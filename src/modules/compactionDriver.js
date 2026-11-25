// The legacy and layered drivers share the pressure computation and summary-outcome recording; only actions started by this plugin are counted.
export function sessionEvents(session) {
  try {
    return typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events ?? null
  } catch { return null }
}

export function computePressure(ctx, session, fallbackWindow = 262144) {
  try {
    const totalTokens = ctx?.get?.('tokenMeter')?.measure(session)?.totalTokens
    if (!Number.isFinite(totalTokens) || totalTokens < 0) return null
    const events = sessionEvents(session)
    let event
    if (Array.isArray(events)) {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e?.type === 'request/context' && Number.isFinite(e?.data?.contextWindow) && e.data.contextWindow > 0) { event = e; break }
      }
    }
    const window = event?.data.contextWindow ?? fallbackWindow
    if (!Number.isFinite(window) || window <= 0) return null
    return { totalTokens, window, windowSource: event ? 'event' : 'fallback', ratio: totalTokens / window }
  } catch { return null }
}

export function bumpCompression(stats, agent, key, delta = 1) {
  stats?.bump(key, delta)
  stats?.bucket(agent.id).bump(key, delta)
}

export function recordCompression(stats, agent, controller, stage, status, detail = {}) {
  stats?.bucket(agent.id).addSample({
    module: 'compression', controller, stage, status, at: new Date().toISOString(),
    modelCall: false, archive: 'not-implemented', ...detail,
  })
}

// Within 30 seconds, an ineffective summary on the same history is not resubmitted; it does not consume the success quota.
export function retryKey(session, pressure) {
  const events = sessionEvents(session)
  return JSON.stringify([pressure.totalTokens, pressure.window, events?.length, events?.at(-1)?.seq])
}

export async function runSummary({ agent, state, controller, timeoutMs, compaction, meter, before, stats, alive }) {
  const prefix = controller === 'layered' ? 'layeredCompact' : 'compactionDriver'
  const started = Date.now()
  const abort = new AbortController()
  state.abort = abort
  const timer = setTimeout(() => abort.abort(new DOMException('compaction timed out', 'TimeoutError')), timeoutMs)
  timer.unref?.()
  const details = () => ({
    startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
    before, after: computePressure({ get: () => meter }, agent.session, before.window),
  })
  bumpCompression(stats, agent, prefix + (controller === 'layered' ? '.attempts' : '.triggers'))
  recordCompression(stats, agent, controller, 'summary', 'running', { before, modelCall: null })
  try {
    const result = await compaction.compactNow(agent, abort.signal)
    if (!alive()) return { ok: false, code: 'disposed' }
    if (result === null) {
      bumpCompression(stats, agent, prefix + (controller === 'layered' ? '.noop' : '.code.noop'))
      recordCompression(stats, agent, controller, 'summary', 'noop', details())
      return { ok: false, code: 'noop' }
    }
    if (typeof result !== 'object' || Array.isArray(result)) {
      throw Object.assign(new Error('compactNow returned no valid result'), { code: 'result' })
    }
    bumpCompression(stats, agent, prefix + (controller === 'layered' ? '.lossy' : '.completed'))
    recordCompression(stats, agent, controller, 'summary', 'success', { ...details(), modelCall: true })
    return { ok: true }
  } catch (err) {
    if (!alive()) return { ok: false, code: 'disposed' }
    const code = abort.signal.reason?.name === 'TimeoutError' || err?.name === 'TimeoutError' ? 'timeout' : err?.code ?? 'unknown'
    if (controller === 'legacy' && (code === 'busy' || code === 'cancelled')) {
      bumpCompression(stats, agent, 'compactionDriver.skippedBusy')
      bumpCompression(stats, agent, 'compactionDriver.code.' + code)
    } else {
      bumpCompression(stats, agent, prefix + '.failed.' + code)
      if (controller === 'legacy') bumpCompression(stats, agent, prefix + '.failed')
    }
    recordCompression(stats, agent, controller, 'summary', code, { ...details(), modelCall: null })
    return { ok: false, code }
  } finally {
    clearTimeout(timer)
    state.abort = null
  }
}

// Optional injected services; the returned dispose releases the injection listeners. After unload, late services are no longer accepted.
export function compressionServices(ctx, names) {
  const services = {}
  let alive = true
  let dispose
  try {
    dispose = ctx.inject?.(names, (svc) => {
      if (!alive) return
      for (const name of names) services[name] = svc[name]
    })
  } catch { /* when a service is missing the status clearly shows unavailable */ }
  return {
    get(name, agent) {
      if (!alive) return undefined
      // Summarization and cleanup belong to the current agent's isolated preset; do not cache or borrow from other presets.
      if (agent && (name === 'compaction' || name === 'toolResultPruner')) {
        try {
          const presets = ctx.get?.('agentPresets')
          if (typeof presets?.serviceFor === 'function') {
            const scoped = presets.serviceFor(agent, name)
            if (scoped !== undefined || presets.composedPreset?.(agent.ctx) !== undefined) return scoped
          }
        } catch { return undefined } // on resolution failure, do not fall back to services that may belong to other configs
      }
      if (!services[name]) {
        try { services[name] = ctx.get?.(name) } catch { /* no inject permission */ }
      }
      return services[name]
    },
    dispose() { alive = false; if (typeof dispose === 'function') dispose() },
  }
}

export function createCompactionDriverModule(ctx, config, stats) {
  if (typeof config !== 'function' && !config?.enabled) return () => {}
  if (typeof ctx?.on !== 'function') return () => {}
  const read = typeof config === 'function' ? config : () => config
  const services = compressionServices(ctx, ['compaction', 'tokenMeter'])
  const states = new Map()
  let active = true
  const onStatus = (payload) => {
    const agent = payload?.agent
    if (!active || !agent?.session || payload.status !== 'idle') return
    const cfg = read() // an immutable snapshot for this check
    if (!cfg?.enabled) return
    const note = (status, detail) => recordCompression(stats, agent, 'legacy', 'check', status, detail)
    let st = states.get(agent.id)
    if (!st) states.set(agent.id, st = { busy: false, done: 0, retryAt: 0 })
    if (st.busy || stats?.compressionBusy(agent.id)) return
    const meter = services.get('tokenMeter')
    const compaction = services.get('compaction', agent)
    if (!meter?.measure || !compaction?.compactNow) { note('unavailable'); return }
    const p = computePressure({ get: () => meter }, agent.session, cfg.contextWindow)
    if (!p) { note('noPressure'); return }
    if (st.done >= cfg.maxCompactionsPerSession) { note('limit', { before: p }); return }
    const events = sessionEvents(agent.session)
    if (!Array.isArray(events)) { note('noHistory', { before: p }); return }
    if (events.filter((e) => e?.type === 'turn/start').length < cfg.minTurns) { note('minTurns', { before: p }); return }
    if (p.totalTokens < cfg.minTokens || p.ratio < cfg.pressureRatio) { note('below', { before: p }); return }
    const key = retryKey(agent.session, p)
    if (key === st.retryKey && Date.now() < st.retryAt) { note('backoff', { before: p }); return }
    if (stats && !stats.beginCompression(agent.id)) return
    st.busy = true
    setImmediate(async () => {
      try {
        if (!active || states.get(agent.id) !== st || !read()?.enabled) {
          if (active) note('cancelled')
          return
        }
        bumpCompression(stats, agent, 'compactionDriver.checks')
        const result = await runSummary({
          agent, state: st, controller: 'legacy', timeoutMs: cfg.timeoutMs,
          compaction, meter, before: p, stats, alive: () => active && states.get(agent.id) === st,
        })
        if (result.ok) st.done += 1
        else if (!['busy', 'cancelled', 'disposed'].includes(result.code)) {
          st.retryKey = key
          st.retryAt = Date.now() + 30000
        }
      } finally {
        st.busy = false
        stats?.endCompression(agent.id)
      }
    })
  }
  const onDisposed = ({ agent } = {}) => {
    const st = states.get(agent?.id)
    st?.abort?.abort(new DOMException('session closed', 'AbortError'))
    states.delete(agent?.id)
  }
  ctx.on('agent/status', onStatus)
  ctx.on('agent/disposed', onDisposed)
  return () => {
    active = false
    for (const st of states.values()) st.abort?.abort(new DOMException('plugin unloaded', 'AbortError'))
    states.clear()
    services.dispose()
    ctx.off?.('agent/status', onStatus)
    ctx.off?.('agent/disposed', onDisposed)
  }
}

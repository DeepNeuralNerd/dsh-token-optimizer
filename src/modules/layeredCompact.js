// L0 observes; L1 clears replayable historical tool results; L2 tries a model summary after re-measuring.
// Cleanup is not a promise to keep every task detail; a retrievable summary is not the same as lossless.
import {
  computePressure, compressionServices, bumpCompression, recordCompression, retryKey, runSummary,
} from './compactionDriver.js'

export function createLayeredCompactModule(ctx, config, stats) {
  if (typeof config !== 'function' && !config?.enabled) return () => {}
  if (typeof ctx?.on !== 'function') return () => {}
  const read = typeof config === 'function' ? config : () => config
  const services = compressionServices(ctx, ['tokenMeter'])
  const summaries = compressionServices(ctx, ['compaction'])
  const pruning = compressionServices(ctx, ['toolResultPruner'])
  const states = new Map()
  let active = true
  const onStatus = async (payload) => {
    const agent = payload?.agent
    if (!active || !agent?.session || payload.status !== 'idle') return
    const cfg = read()
    if (!cfg?.enabled) return
    let st = states.get(agent.id)
    if (!st) states.set(agent.id, st = { busy: false, done: 0, backedOff: false, retryAt: 0 })
    if (st.busy || stats?.compressionBusy(agent.id)) return
    const note = (stage, status, detail) => recordCompression(stats, agent, 'layered', stage, status, detail)
    const bump = (key, delta) => bumpCompression(stats, agent, 'layeredCompact.' + key, delta)
    const meter = services.get('tokenMeter')
    const p = computePressure({ get: () => meter }, agent.session, cfg.sessionWindowFallback)
    if (!p) { bump('noPressure'); note('check', 'noPressure'); return }
    if (p.ratio >= cfg.lowRatio) bump('observed')
    if (p.ratio < cfg.midRatio) { note('check', p.ratio >= cfg.lowRatio ? 'observed' : 'below', { before: p }); return }
    if (stats && !stats.beginCompression(agent.id)) return
    st.busy = true
    try {
      let current = p
      const pruner = pruning.get('toolResultPruner', agent)
      if (!pruner?.pruneSession) {
        bump('pruneUnavailable')
        note('prune', 'unavailable', { before: p })
      } else {
        const started = Date.now()
        let failure = false
        try { pruner.pruneSession(agent.session) } catch {
          failure = true
          bump('pruneFailed')
        }
        current = computePressure({ get: () => meter }, agent.session, p.window)
        if (current) current.windowSource = p.windowSource
        const saved = current ? Math.max(0, p.totalTokens - current.totalTokens) : null
        if (!failure && saved > 0) { bump('lossless'); bump('pruneSavedTokens', saved) }
        else if (!failure && saved === 0) bump('pruneNoop')
        note('prune', failure ? 'failed' : saved === null ? 'noPressure' : saved > 0 ? 'success' : 'noop', {
          before: p, after: current, savedTokens: failure ? null : saved, durationMs: Date.now() - started,
        })
        if (!current) return // on a failed re-measurement, do not request a summary based on stale pressure
      }
      if (current.ratio < cfg.highRatio) return
      if (st.done >= cfg.highTierMaxPerSession) { note('summary', 'limit', { before: current }); return }
      if (st.backedOff) { note('summary', 'backedOff', { before: current }); return }
      const key = retryKey(agent.session, current)
      if (key === st.retryKey && Date.now() < st.retryAt) { note('summary', 'backoff', { before: current }); return }
      const compaction = summaries.get('compaction', agent)
      if (!compaction?.compactNow) { note('summary', 'unavailable', { before: current }); return }
      await new Promise((resolve) => setImmediate(resolve))
      if (!active || states.get(agent.id) !== st || !read()?.enabled) {
        if (active) note('summary', 'cancelled')
        return
      }
      const result = await runSummary({
        agent, state: st, controller: 'layered', timeoutMs: cfg.highTierTimeoutMs,
        compaction, meter, before: current, stats, alive: () => active && states.get(agent.id) === st,
      })
      if (result.ok) st.done += 1
      else if (result.code === 'busy') {
        st.backedOff = true
        bump('backedOff')
      } else if (result.code !== 'disposed') {
        st.retryKey = key
        st.retryAt = Date.now() + 30000
      }
    } finally {
      st.busy = false
      stats?.endCompression(agent.id)
    }
  }
  const onDisposed = ({ agent } = {}) => {
    states.get(agent?.id)?.abort?.abort(new DOMException('session closed', 'AbortError'))
    states.delete(agent?.id)
  }
  ctx.on('agent/status', onStatus)
  ctx.on('agent/disposed', onDisposed)
  return () => {
    active = false
    for (const st of states.values()) st.abort?.abort(new DOMException('plugin unloaded', 'AbortError'))
    states.clear()
    services.dispose()
    summaries.dispose()
    pruning.dispose()
    ctx.off?.('agent/status', onStatus)
    ctx.off?.('agent/disposed', onDisposed)
  }
}

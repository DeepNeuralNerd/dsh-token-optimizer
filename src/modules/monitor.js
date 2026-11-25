// monitor: on session end (session/disposed), print this session's token-savings statistics.
//
// Data sources: the stats counter snapshot (savedChars/counts accumulated by each module) +
// optional ctx.tokenMeter (DSH's built-in metering; when present, its measure data is used).
// Added in v2: listen to session/event to aggregate data.usage from assistant/message events, reporting at session end
// the real model usage and cache hit rate (DeepSeek's disk prefix cache; cacheReadTokens is the hit portion,
// hit rate = cacheRead / (input + cacheRead); per API convention inputTokens excludes cache reads).
// Output: console logs (visible to the DSH process); with showInChat, also appends a session message.

// usage key compatibility: snake_case / cached_tokens and other variants all resolve to the first defined value
function pickUsageField(u, ...names) {
  for (const name of names) {
    const v = u?.[name]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return 0
}

export function createMonitorModule(ctx, config, stats) {
  const listeners = []
  if (typeof ctx?.on !== 'function') return () => {}

  // per-session usage aggregation (assistant/message events on session/event carry data.usage)
  const usageBySession = new Map()

  const onSessionEvent = (session, event) => {
    if (event?.type !== 'assistant/message') return
    const u = event?.data?.usage
    if (!u || typeof u !== 'object') return
    let agg = usageBySession.get(session)
    if (!agg) {
      agg = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, events: 0 }
      usageBySession.set(session, agg)
    }
    const dIn = pickUsageField(u, 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens')
    const dOut = pickUsageField(u, 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens')
    const dCache = pickUsageField(u, 'cacheReadTokens', 'cache_read_tokens', 'cachedTokens', 'cached_tokens', 'promptCacheHitTokens', 'prompt_cache_hit_tokens')
    const dReason = pickUsageField(u, 'reasoningTokens', 'reasoning_tokens')
    agg.inputTokens += dIn
    agg.outputTokens += dOut
    agg.cacheReadTokens += dCache
    agg.reasoningTokens += dReason
    agg.events += 1
    // Note: bump is additive; pass the single-event delta, not the running total
    stats?.bump('monitor.usageEvents', 1)
    stats?.bump('monitor.inputTokens', dIn)
    stats?.bump('monitor.outputTokens', dOut)
    stats?.bump('monitor.cacheReadTokens', dCache)
    stats?.bump('monitor.reasoningTokens', dReason)
  }

  const handler = async (session) => {
    const snapshot = stats.snapshot()
    const lines = ['\u2500\u2500 dsh-token-optimizer session statistics \u2500\u2500']
    for (const [key, value] of Object.entries(snapshot.counters)) {
      lines.push(`  ${key}: ${value}`)
    }
    const totalChars = snapshot.samples.reduce((sum, s) => sum + (s.savedChars ?? 0), 0)
    if (totalChars > 0) lines.push(`  saved about ${totalChars.toLocaleString()} characters in total (compression/dedup/sampling/summarization)`)

    // v2: real model usage and cache hit rate (usage aggregated within the session)
    const agg = usageBySession.get(session)
    if (agg && agg.events > 0) {
      const totalInput = agg.inputTokens + agg.cacheReadTokens
      const hitRate = totalInput > 0 ? `${((agg.cacheReadTokens / totalInput) * 100).toFixed(1)}%` : 'n/a'
      lines.push(`  model usage: ${agg.events} requests, input ${agg.inputTokens.toLocaleString()} / cache hits ${agg.cacheReadTokens.toLocaleString()} / output ${agg.outputTokens.toLocaleString()} tokens`)
      lines.push(`  cache hit rate: ${hitRate} (= cache hits / (input + cache hits))`)
      if (agg.reasoningTokens > 0) lines.push(`  reasoning tokens: ${agg.reasoningTokens.toLocaleString()}`)
    }

    // Try reading the built-in token meter data (when present)
    let meterLine = ''
    try {
      if (ctx.tokenMeter && typeof ctx.tokenMeter.measure === 'function') {
        const m = await ctx.tokenMeter.measure(session)
        if (m && typeof m.totalTokens === 'number') {
          meterLine = `  context surfaceTokens: ${m.surfaceTokens ?? '?'} / totalTokens: ${m.totalTokens}`
          lines.push(meterLine)
        }
      }
    } catch {
      // tokenMeter unavailable or failed: skip silently
    }

    const report = lines.join('\n')
    console.log(report)

    // showInChat: append to the session as a user message (lightweight; failure is not fatal)
    if (config.showInChat && session && typeof session.append === 'function') {
      try {
        session.append('user', {
          content: [{ type: 'text', text: report }],
          source: { kind: 'plugin:dsh-token-optimizer' },
        })
      } catch {
        // append failure is not fatal
      }
    }
    stats?.bump('monitor.reports', 1)
    usageBySession.delete(session)
  }

  ctx.on('session/disposed', handler)
  listeners.push(() => ctx.off('session/disposed', handler))
  ctx.on('session/event', onSessionEvent)
  listeners.push(() => ctx.off('session/event', onSessionEvent))
  return () => {
    usageBySession.clear()
    for (const off of listeners) off()
  }
}

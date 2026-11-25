// Lightweight stats: record each module's savings/processing counts and print a report at session end.
// Added in T2: per-session bucketing (bucket/snapshotSession) and token/cost estimation (estimateTokens/estimateCost).
// The return shapes of snapshot()/formatReport() are contracts with existing call sites (monitor uses them) -> only add methods; never change shapes.

const CHARS_PER_TOKEN = 1.6 // rough estimate: DeepSeek Chinese is about 1.6 characters/token (estimate; real usage is authoritative)

export function createStats() {
  const busyAgents = new Set()
  const counters = new Map()
  const samples = []
  const buckets = new Map() // sessionId -> { counters: Map, samples: [] } (T2 per-session bucketing)

  function bump(key, delta = 1) {
    counters.set(key, (counters.get(key) ?? 0) + delta)
  }

  function addSample(entry) {
    samples.push(entry)
    if (samples.length > 1000) samples.shift()
  }

  function snapshot() {
    return {
      counters: Object.fromEntries(counters),
      samples: [...samples],
    }
  }

  // Session bucketing: returns a bump/addSample facade with the same shape as this object, writing into that session's bucket;
  // global counters (bump) are unaffected -- layered modules record to both (global for monitor reports, buckets for /token-status)
  function bucket(sessionId) {
    const key = String(sessionId ?? 'default')
    let b = buckets.get(key)
    if (!b) {
      b = { counters: new Map(), samples: [] }
      buckets.set(key, b)
    }
    return {
      bump(k, delta = 1) {
        b.counters.set(k, (b.counters.get(k) ?? 0) + delta)
      },
      addSample(entry) {
        b.samples.push(entry)
        if (b.samples.length > 1000) b.samples.shift()
      },
    }
  }

  // Same shape as snapshot(): { counters, samples } (only this session's bucket; independent of global counters)
  function snapshotSession(sessionId) {
    const b = buckets.get(String(sessionId ?? 'default'))
    return {
      counters: Object.fromEntries(b?.counters ?? []),
      samples: [...(b?.samples ?? [])],
    }
  }

  // Character savings -> rough token estimate (conservative: converted via CHARS_PER_TOKEN)
  function estimateTokens(savedChars) {
    const n = Number(savedChars)
    if (!Number.isFinite(n) || n <= 0) return 0
    return Math.round(n / CHARS_PER_TOKEN)
  }

  // Cost estimate (CNY): each token quantity priced in yuan per million and summed
  function estimateCost({ inputTokens = 0, cacheReadTokens = 0, outputTokens = 0 } = {}, pricing) {
    const p = pricing ?? { inputPerMillion: 0.8, cacheHitPerMillion: 0.23, outputPerMillion: 2.8 }
    const cost = (Number(inputTokens) || 0) * (p.inputPerMillion ?? 0)
      + (Number(cacheReadTokens) || 0) * (p.cacheHitPerMillion ?? 0)
      + (Number(outputTokens) || 0) * (p.outputPerMillion ?? 0)
    return cost / 1e6
  }

  function formatReport() {
    const c = Object.fromEntries(counters)
    const lines = []
    lines.push('\u2500\u2500 dsh-token-optimizer session statistics \u2500\u2500')
    for (const [key, value] of Object.entries(c)) {
      lines.push(`  ${key}: ${value}`)
    }
    const totalChars = samples.reduce((sum, s) => sum + (s.savedChars ?? 0), 0)
    if (totalChars > 0) lines.push(`  saved about ${totalChars.toLocaleString()} characters in total (compression/dedup)`)
    return lines.join('\n')
  }

  return {
    bump,
    addSample,
    snapshot,
    bucket,
    snapshotSession,
    compressionBusy(agentId) { return busyAgents.has(agentId) },
    beginCompression(agentId) {
      if (busyAgents.has(agentId)) return false
      busyAgents.add(agentId)
      return true
    },
    endCompression(agentId) { busyAgents.delete(agentId) },
    estimateTokens,
    estimateCost,
    formatReport,
    dispose() {
      busyAgents.clear()
      counters.clear()
      samples.length = 0
      buckets.clear()
    },
  }
}

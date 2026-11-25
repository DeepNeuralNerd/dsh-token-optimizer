// Use the schema provided by the host; when missing, do not block the plugin -- only the settings form is disabled.
// The volatile section guarantees that thresholds saved at once are read as a group at runtime; other modules keep plain config.
let Schema
try {
  const mod = await import('@deepseek-ai/schemastery')
  Schema = mod.default ?? mod
} catch { /* do not install new dependencies */ }

export function buildConfigSchema(S) {
  return S.object({
    archive: S.object({
      enabled: S.boolean().default(false),
      directory: S.string().default(''),
      previousDirectories: S.array(S.string()).default([]),
      retryGeneration: S.number().min(0).default(0),
    }).volatile(),
    compactionDriver: S.object({
      enabled: S.boolean().default(true),
      pressureRatio: S.number().min(0).max(1).default(0.45),
      minTurns: S.number().min(0).default(6),
      minTokens: S.number().min(0).default(100000),
      maxCompactionsPerSession: S.number().min(0).default(3),
      contextWindow: S.number().min(1).default(1000000),
      timeoutMs: S.number().min(1).default(120000),
    }).volatile(),
    layeredCompact: S.object({
      enabled: S.boolean().default(false),
      lowRatio: S.number().min(0).max(1).default(0.4),
      midRatio: S.number().min(0).max(1).default(0.5),
      highRatio: S.number().min(0).max(1).default(0.65),
      highTierTimeoutMs: S.number().min(1).default(120000),
      highTierMaxPerSession: S.number().min(0).default(2),
      sessionWindowFallback: S.number().min(1).default(262144),
      pricing: S.object({
        inputPerMillion: S.number().min(0).default(0.8),
        cacheHitPerMillion: S.number().min(0).default(0.23),
        outputPerMillion: S.number().min(0).default(2.8),
      }),
    }).volatile(),
  })
}
let built
try { built = Schema ? buildConfigSchema(Schema) : undefined } catch { /* degrade when the service is incompatible */ }
export const Config = built

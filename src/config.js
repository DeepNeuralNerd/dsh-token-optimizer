import { isAbsolute } from 'node:path'

// Config defaults and validation. Aligned with section 4.1 of the design document's YAML structure, keeping only keys that actually landed.

export const DEFAULT_CONFIG = {
  archive: { enabled: false, directory: '', previousDirectories: [], retryGeneration: 0 },
  // ===== Layer 1: input pre-processing =====
  // text2img: render very long natural-language text into images, summarize via a vision API, and replace the text in context with the summary.
  // Reliability fix (2026-09-03 controlled experiments): flash-vision-exp hallucinated whole pages at "high-density large pages"
  // (three incidents: Xiaohongshu / Inspur AI server / law-master exam prep); the root cause was excessive per-page information density.
  // Experiment conclusion: font 24 + page height 3000 (~1k characters/page; 6.4k characters -> 6 pages) passed 3/3 runs,
  // with stable fidelity (keyword recall 8/8, 7/8); font 16 + page height 7800 (2 pages) hallucinated consistently.
  // Hence the default small-page pagination (pageFontSize 24 / pageMaxHeight 3000); summaries are still flagged "may be inaccurate",
  // and details must be checked against the saved original before quoting.
  text2img: {
    enabled: true,
    threshold: 1000,           // character threshold; reaching it triggers the ask (any content type)
    // v2.1 asking strategy: always ask at the threshold; content type decides the recommended option (first) and the timeout default --
    // natural language -> image summary; strongly structural -> read the original. Closes v2.0's hole where "auto-converting prose
    // left the model unable to read original details" (real incident: DSH was asked to review plan details but only saw the summary).
    askOnSkip: true,           // false = disable asking; v2.0 automatic behavior (natural language auto-converts; strongly structural skips)
    askTimeoutMs: 120000,      // ask timeout in milliseconds; on timeout the content-type default applies (2 minutes)
    maxAsksPerSession: 0,      // per-session cap on asks (0 = unlimited); beyond it the content-type default applies silently.
                               // Noise valve for the popup-on-every-new-long-text behavior (measured: 4 texts in a row = 4 popups; set 3-5 if that is too many)
    summaryCache: true,        // content hash -> on-disk summary cache; cross-session hits cost 0 API calls
    dynamicResolution: true,   // tiered render size by character count (see resolutionTiers); false uses renderWidth + pagination
    renderWidth: 1200,         // fixed render width when dynamicResolution=false
    // Dynamic resolution tiers (calibrated by measurement on 2026-09-09):
    // Measured: Microsoft YaHei under GDI+ has line height ~1.9x font size (24px -> 43px, 36px -> 70px),
    // and mixed CN/EN text wraps even more, so the old 640x360/1280x720 tiers held only ~107/~417 characters/page, doubling page counts.
    // Sizes were scaled by the "change the canvas, not the rendering" rule (glyphs/leading/wrapping unchanged; verified fidelity still holds):
    // 800x450 is about 240 characters/page, 1440x810 is about 920 characters/page (back to the v2.0 3/3-pass safe ~1,000 characters/page level),
    // 1920x1080@36 is about 420 characters/page; hallucination incidents occurred at ~3,200 characters/page, so every tier keeps a 3.5x margin.
    resolutionTiers: [
      { maxChars: 2000, width: 800, height: 450, fontSize: 24 },
      { maxChars: 6000, width: 1440, height: 810, fontSize: 24 },
      { maxChars: Infinity, width: 1920, height: 1080, fontSize: 36 },
    ],
    pageFontSize: 24,          // render font size (used when dynamicResolution=false)
    pageMaxHeight: 3000,       // maximum page height (used when dynamicResolution=false)
    visionModel: 'deepseek-v4-flash-vision-exp',
    baseUrl: 'https://api.deepseek.com/v1',  // OpenAI-compatible endpoint
    prompt: 'Read the text in all image pages and produce a concise, accurate summary in the language of the source, keeping key numbers, proper nouns, and structural points. Requirements: (1) focus on the substantive body content and ignore metadata such as titles, authors, links, sources, and copyright notices (at most one passing sentence; never treat them as core content); (2) when content spans multiple pages, read every page and cover them fully; never summarize only the opening pages; (3) summarize only what appears in the source and add nothing that is not there; mark illegible or unclear parts as [unreadable] instead of guessing.',
    pagesPerBatch: 4,          // batched summarization: at most this many pages per vision batch.
                               // Measured: flash-vision reading 8+ pages at once summarized only the first pages and invented that "the text ends here",
                               // losing the rest (the second failure mode of the Zhihu long-post incident). Batching forces full coverage; then merge as plain text.
                               // Cost: 1 Flash vision call per batch + 1 plain-text merge call.
    maxSummaryChars: 2000,     // summary cap (length of text replacing the original in context)
    maxSummaryRatio: 0.4,      // the cap scales with input: effective cap = min(maxSummaryChars, input characters x this ratio).
                               // Guarantees the replacement is shorter than the original -- otherwise v2.1 short texts would keep the original because the summary runs long, burning vision for nothing.
    reasoningBudget: 16384,    // thinking-token reserve for the vision reasoning model (max_tokens = summary cap + this reserve;
                               // an insufficient reserve lets thinking exhaust the budget and return an empty summary -- real incident: 4096 was not enough and content came back empty after 51 seconds of thinking)
    saveOriginal: true,        // save the original text to disk (reversible)
  },
  // ===== v2 outputLadder: one pass on post-execute routing (merges v1 compress/sample/pruning truncation intents) =====
  outputLadder: {
    enabled: true,
    structureThreshold: 10000, // JSON array/CSV structural compression threshold (characters)
    compressionRate: 0.5,      // JSON sampling rate
    preserveHeadTail: 1000,    // JSON/CSV head/tail retention
    shellTools: ['pwsh', 'bash', 'sh', 'powershell', 'zsh', 'cmd'], // shell-type tools (sampled)
    shellThreshold: 8000,      // shell-output sampling threshold (characters; the core spill handles >50000 bytes)
    headLines: 10,             // head lines kept when sampling
    tailLines: 10,             // tail lines kept when sampling
    sampleInterval: 20,        // evenly spaced sampling interval for the middle
    errorSummaryChars: 300,    // error-result summary cap
    spillBytes: 50000,         // aligned with the core spill-policy maxInlineBytes; larger outputs pass through
    readTools: ['read', 'read_image'], // exempt tools: first read kept in full
    saveOriginal: true,        // originals saved to disk (reversible)
  },
  // ===== v2 compaction driver: on idle, drive core compaction at a custom pressure ratio (the core 0.8 threshold never fires on a 1M window) =====
  compactionDriver: {
    enabled: true,
    pressureRatio: 0.45,           // triggers only when totalTokens / contextWindow exceeds this ratio
    minTurns: 6,                   // minimum session turns (filters out short-lived sessions/subagents)
    minTokens: 100000,             // minimum context tokens (too small is not worth compacting)
    maxCompactionsPerSession: 3,   // per-session compaction cap (prevents runaway)
    contextWindow: 1000000,        // fallback window; the request/context event is preferred
    timeoutMs: 120000,             // single-compaction timeout
  },
  // ===== T4 layered compaction orchestration (0C revision: L0 observe / L1 lossless prune / L2 lossy compactNow) =====
  // Default enabled:false (canary). When layered mode is on, the runtime bypasses the legacy driver; the settings page saves both switches atomically:
  // the legacy driver is lossy at 0.45 and would consume every L1 lossless opportunity (the kernel compaction-basic itself is
  // a two-stage measure -> prune -> re-measure -> only then lossy process).
  layeredCompact: {
    enabled: false,
    lowRatio: 0.4,                 // L0 observe line (no pressure reduction, bookkeeping only; must not be dressed up as "lossless compression")
    midRatio: 0.5,                 // L1 tool-history cleanup line (ctx.toolResultPruner.pruneSession; actually reduces the numerator)
    highRatio: 0.65,               // L2 lossy line (compactNow; must be judged on the ratio re-measured after L1)
    highTierTimeoutMs: 120000,     // compactNow timeout (AbortSignal.timeout; a timeout is not a cancellation)
    highTierMaxPerSession: 2,      // per-session lossy compaction cap
    sessionWindowFallback: 262144, // window fallback when no request/context event is available (same as the router default)
    pricing: {                     // for T5 cost estimation (CNY per million tokens)
      inputPerMillion: 0.8,
      cacheHitPerMillion: 0.23,
      outputPerMillion: 2.8,
    },
  },
  // Result cache
  // Result caching is paused: read-only searches still depend on mutable file state; the old enabled:true did not reuse results either.
  cache: {
    enabled: false,
    ttl: 3600,
  },
  // ===== Monitor =====
  monitor: {
    enabled: true,
    showInChat: true,          // print savings statistics at session end
  },
  // ===== fileDiff paused: kept for old-config compatibility; always returns the original when a baseline cannot be proven =====
  fileDiff: {
    enabled: false,
    tools: ['read'],
    minSize: 2048,
    maxFileBytes: 200000,
    contextLines: 3,
    collapseUnchanged: true,
  },
  // ===== Per-session tool schema trimming (off by default; when on, applied per agent scope via agent/created) =====
  // mcpLazy: MCP tools are hidden only after the discovery tool registers successfully, supporting catalog search/paging and load-by-name; explicit restrictions are kept.
  toolTrim: {
    enabled: false,
    allow: null,               // null/omitted = unrestricted; [] = allow no inherited tools
    deny: [],
    mcpLazy: true,              // MCP tool lazy loading (a silent no-op when no mcp__* tools are detected)
    mcpPrefix: 'mcp__',         // MCP tool-name prefix (the public name format of dsh-mcp-client)
    mcpLoadToolName: 'mcp_load_tools', // the release meta-tool name
  },
  // ===== memory-bridge integration placeholder (flip it on once dsh-memory-bridge stage 3b lands) =====
  // For now enabled:false registers no hooks; it only keeps the config section legal.
  memory_bridge: {
    enabled: false,
    sync_dir: '~/.dsh-memory',
    compress_on_sync: true,
    compression_strategy: 'time_decay',
    text2img_threshold: 1000,
    dynamic_resolution: true,
  },
}

const NUMERIC_KEYS = new Set([
  'retryGeneration', 'threshold', 'compressionRate', 'preserveHeadTail', 'ttl',
  'maxSummaryChars', 'headLines', 'tailLines', 'sampleInterval',
  'minSize', 'maxFileBytes', 'contextLines',
  'structureThreshold', 'shellThreshold', 'errorSummaryChars', 'spillBytes',
  'pressureRatio', 'minTurns', 'minTokens', 'maxCompactionsPerSession', 'contextWindow', 'timeoutMs',
  'reasoningBudget', 'pageFontSize', 'pageMaxHeight',
  'askTimeoutMs', 'renderWidth', 'text2img_threshold', 'maxSummaryRatio', 'maxAsksPerSession', 'pagesPerBatch',
  // T4 layered-compaction flat keys (NUMERIC_KEYS is a global flat set; sub-key names must not collide with existing keys)
  'lowRatio', 'midRatio', 'highRatio', 'highTierTimeoutMs', 'highTierMaxPerSession', 'sessionWindowFallback',
])
const STRING_KEYS = new Set(['directory', 'visionModel', 'baseUrl', 'prompt', 'sync_dir', 'compression_strategy'])
const STRING_ARRAY_KEYS = new Set(['previousDirectories', 'tools', 'allow', 'deny', 'shellTools', 'readTools'])

// Structured value validation (beyond the basic number/string/boolean checks)
const CUSTOM_VALIDATORS = {
  resolutionTiers(value) {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error('dsh-token-optimizer config: "resolutionTiers" must be a non-empty array of {maxChars, width, height, fontSize}')
    }
    let prev = 0
    for (const tier of value) {
      if (!tier || typeof tier !== 'object') {
        throw new Error('dsh-token-optimizer config: each resolutionTier must be an object {maxChars, width, height, fontSize}')
      }
      for (const k of ['maxChars', 'width', 'height', 'fontSize']) {
        if (!Number.isFinite(tier[k]) || tier[k] <= 0) {
          throw new Error(`dsh-token-optimizer config: resolutionTier "${k}" must be a positive number`)
        }
      }
      if (tier.maxChars <= prev) {
        throw new Error('dsh-token-optimizer config: resolutionTiers maxChars must be strictly increasing')
      }
      prev = tier.maxChars
      // the DeepSeek vision API long-side limit measured at ~8124; keep a safety margin
      if (Math.max(tier.width, tier.height) > 8000) {
        throw new Error('dsh-token-optimizer config: resolutionTier width/height must be <= 8000 (vision API long-side limit)')
      }
    }
  },
  // T1: the pricing sub-object uses custom validation (shallow validation leaves zero coverage of inner keys); after it passes,
  // it returns a deep copy + freeze, avoiding the trap where an outer freeze leaves the inner object mutable by shared reference (08 A13)
  pricing(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('dsh-token-optimizer config: "pricing" must be an object {inputPerMillion, cacheHitPerMillion, outputPerMillion}')
    }
    const copy = {}
    for (const k of ['inputPerMillion', 'cacheHitPerMillion', 'outputPerMillion']) {
      if (!Number.isFinite(value[k]) || value[k] < 0) {
        throw new Error(`dsh-token-optimizer config: pricing.${k} (${value[k]}) must be a non-negative number`)
      }
      copy[k] = value[k]
    }
    return Object.freeze(copy)
  },
}

function assertNumber(name, value, { min = 0, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`dsh-token-optimizer config: ${name} (${value}) must be a number in [${min}, ${max}]`)
  }
}

function resolveSection(section, defaults) {
  section = unwrapConfig(section)
  if (section !== undefined && (section === null || typeof section !== 'object' || Array.isArray(section))) {
    throw new Error('dsh-token-optimizer config: section must be an object')
  }
  const out = { ...defaults }
  if (section && typeof section === 'object') {
    for (const [key, value] of Object.entries(section)) {
      if (!(key in defaults)) {
        throw new Error(`dsh-token-optimizer config: unknown key "${key}" (allowed: ${Object.keys(defaults).join(', ')})`)
      }
      if (NUMERIC_KEYS.has(key)) {
        if (key === 'compressionRate' || key === 'pressureRatio' || key === 'lowRatio' || key === 'midRatio' || key === 'highRatio') {
          assertNumber(key, value, { min: 0, max: 1 })
        } else if (key === 'maxSummaryRatio') assertNumber(key, value, { min: 0.1, max: 1 })
        else assertNumber(key, value)
      } else if (key === 'allow' && value === null) {
        // Explicit unrestricted policy, distinct from an empty whitelist.
      } else if (STRING_ARRAY_KEYS.has(key)) {
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
          throw new Error(`dsh-token-optimizer config: "${key}" must be an array of strings`)
        }
      } else if (STRING_KEYS.has(key)) {
        if (typeof value !== 'string') throw new Error(`dsh-token-optimizer config: "${key}" must be a string`)
      } else if (CUSTOM_VALIDATORS[key]) {
        // A validator may return a deep-copied/normalized replacement; returning undefined keeps the original value.
        // already assigned here -> continue skips the loop-tail out[key] = value (otherwise it would be overwritten back)
        const replacement = CUSTOM_VALIDATORS[key](value)
        out[key] = replacement !== undefined ? replacement : value
        continue
      } else if (typeof value !== typeof defaults[key]) {
        throw new Error(`dsh-token-optimizer config: "${key}" must be ${typeof defaults[key]}`)
      }
      out[key] = value
    }
  }
  return Object.freeze(out)
}

// v1 retired sections: silently ignored with a notice when left in user config (never throw -- a throw would take down the whole plugin tree)
const LEGACY_SECTIONS = new Set(['compress', 'sample', 'pruning', 'dedup'])

export function unwrapConfig(value) {
  return value && typeof value.get === 'function' ? value.get() : value
}

// Used at startup, on every idle, and by /token-status; does not modify other frozen module configs.
export function resolveCompressionConfig(config = {}) {
  const compactionDriver = resolveSection(config.compactionDriver, DEFAULT_CONFIG.compactionDriver)
  const layeredCompact = resolveSection(config.layeredCompact, DEFAULT_CONFIG.layeredCompact)
  const { lowRatio: low, midRatio: mid, highRatio: high } = layeredCompact
  if (!(0 < low && low <= mid && mid < high && high < 1)) {
    throw new Error('compaction thresholds must satisfy 0 < observe line <= cleanup line < summary line < 100%')
  }
  if (!(0 < compactionDriver.pressureRatio && compactionDriver.pressureRatio < 1)) {
    throw new Error('the legacy driver threshold must be greater than 0% and less than 100%')
  }
  for (const [name, section, timeout, limit, window] of [
    ['compactionDriver', compactionDriver, 'timeoutMs', 'maxCompactionsPerSession', 'contextWindow'],
    ['layeredCompact', layeredCompact, 'highTierTimeoutMs', 'highTierMaxPerSession', 'sessionWindowFallback'],
  ]) {
    if (!Number.isInteger(section[timeout]) || section[timeout] < 1 || section[timeout] > 2147483647) throw new Error(name + ' timeout must be a positive 32-bit integer')
    if (!Number.isInteger(section[limit]) || section[limit] < 0) throw new Error(name + ' limit must be a non-negative integer')
    if (!(section[window] > 0)) throw new Error(name + ' window must be positive')
  }
  return Object.freeze({ compactionDriver, layeredCompact })
}

export function resolveArchiveConfig(config = {}) {
  const value = resolveSection(unwrapConfig(config)?.archive, DEFAULT_CONFIG.archive)
  if (value.enabled && (!value.directory.trim() || !isAbsolute(value.directory))) throw new Error('archiving requires an absolute directory path')
  if (value.previousDirectories.some(dir => !isAbsolute(dir))) throw new Error('previous archive directories must be absolute paths')
  if (!Number.isSafeInteger(value.retryGeneration) || value.retryGeneration < 0) throw new Error('the archive retry counter must be a non-negative integer')
  return Object.freeze({ ...value, previousDirectories: Object.freeze([...value.previousDirectories]) })
}

export function compressionMode(config) {
  return config.layeredCompact.enabled ? 'layered' : config.compactionDriver.enabled ? 'legacy' : 'off'
}

export function resolveConfig(config = {}) {
  if (typeof config !== 'object' || config === null) config = {}
  for (const name of LEGACY_SECTIONS) {
    if (config[name] !== undefined) {
      console.warn(`[dsh-token-optimizer] config section "${name}" is deprecated (merged into outputLadder or retired in v2) and was ignored. Please remove it from cordis.patch.yml.`)
    }
  }
  return Object.freeze({
    archive: resolveArchiveConfig(config),
    text2img: resolveSection(config.text2img, DEFAULT_CONFIG.text2img),
    cache: resolveSection(config.cache, DEFAULT_CONFIG.cache),
    monitor: resolveSection(config.monitor, DEFAULT_CONFIG.monitor),
    fileDiff: resolveSection(config.fileDiff, DEFAULT_CONFIG.fileDiff),
    toolTrim: resolveSection(config.toolTrim, DEFAULT_CONFIG.toolTrim),
    outputLadder: resolveSection(config.outputLadder, DEFAULT_CONFIG.outputLadder),
    ...resolveCompressionConfig(config),
    // placeholder section: with enabled:false no module consumes it; it only keeps the config valid (flip it on after stage 3b)
    memory_bridge: resolveSection(config.memory_bridge, DEFAULT_CONFIG.memory_bridge),
  })
}

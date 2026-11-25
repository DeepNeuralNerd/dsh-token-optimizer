// dsh-token-optimizer: layered token-optimization pipeline (v2)
//
// Real DSH plugin API notes (different from the invented events in the original design doc):
//   - the plugin is a Cordis plugin; entry point export function apply(ctx, config = {})
//   - ctx.on('agent/pre-step', (payload, next) => ...)  rewrites messages entering the model (inbox batches)
//   - ctx.on('tools/execute') / ctx.on('tools/post-execute')  tool execution / result replacement (birth point)
//   - ctx.on('session/disposed')  session end
//   - ctx.on('agent/status' | 'agent/created' | 'agent/disposed' | 'session/event' | 'tools/change')
//   - ctx.compaction(compactNow)/ctx.tokenMeter(measure)  accessed via ctx.get (inject not declared)
//
// This plugin does not reimplement capabilities DSH already provides:
//   - token-meter (metering/projection), compaction-basic (LLM summary compaction, reversible),
//     tool-result-pruner (8192 characters, only on compaction), spill (>50k bytes saved to disk and retrievable)
//
// v3 module inventory:
//   1. text2img  long text -> images -> vision summary (very long natural-language text; one sample saved ~72%; the real value is "the longer the session, the more it saves")
//   2. outputLadder  birth-point routing of tool output: error summary / JSON-CSV structural compression / shell sampling; originals saved to disk, reversible
//   3. cache     paused (off by default; no reliable file-invalidation proof; old config also only passed through)
//   4. monitor   end-of-session statistics report (real usage aggregation and cache hit rate)
//   5. fileDiff  paused (off by default; cannot prove the current request still holds the full baseline)
//   6. toolTrim  tool visibility management: static allow/deny trimming + MCP lazy loading
//      (the mcp_load_tools meta-tool searches and pages by name/description; a no-op when no MCP deployment exists)
//   7. compactionDriver / layeredCompact  compaction scheduling: drives core compaction at configured thresholds when the agent is idle
//   8. archive   runtime original-text archiving: inputs are written to disk before entering context; outputs are confirmed before later requests/summaries
//   9. client    the "Token Optimization & Compaction" panel in general settings
//
// v1's compress/sample/pruning/dedup are retired (dedup's surface area shrank to zero; the rest merged into
// outputLadder; old config sections are silently ignored with a notice and will not take down the plugin tree).

import { DEFAULT_CONFIG, resolveConfig, resolveCompressionConfig, compressionMode } from './config.js'
import { createText2imgModule } from './modules/text2img.js'
import { createOutputLadderModule } from './modules/outputLadder.js'
import { createCacheModule } from './modules/cache.js'
import { createMonitorModule } from './modules/monitor.js'
import { createFileDiffModule } from './modules/fileDiff.js'
import { createToolTrimModule } from './modules/toolTrim.js'
import { createCompactionDriverModule } from './modules/compactionDriver.js'
import { createLayeredCompactModule } from './modules/layeredCompact.js'
import { registerTokenStatusCommand } from './commands/tokenStatus.js'
import { createArchiveModule } from './modules/archive.js'
import { createStats } from './stats.js'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Debug log: off by default; set DSH_TOKEN_OPTIMIZER_DEBUG=1 when troubleshooting to write it to disk
const DEBUG_LOG = !!process.env.DSH_TOKEN_OPTIMIZER_DEBUG
const DEBUG_LOG_PATH = process.env.DSH_TOKEN_OPTIMIZER_DEBUG_LOG || join(homedir(), '.dsh', 'token-optimizer-debug.log')
function debugLog(msg) {
  if (!DEBUG_LOG) return
  try {
    appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`, 'utf8')
  } catch { /* ignore logging failures */ }
}

debugLog('module loaded, apply defined: ' + typeof apply)

export function apply(ctx, config = {}) {
  debugLog('apply() CALLED with config keys: ' + (Object.keys(config ?? {}).join(',') || '(empty)'))
  const resolved = resolveConfig(config)
  const stats = createStats()

  const modules = []
  // Registered earliest and prepended: original inputs reach disk before other rewrite/compaction middleware sees them.
  const archive = createArchiveModule(ctx, () => config)
  modules.push(() => archive.dispose())
  if (resolved.text2img.enabled) modules.push(createText2imgModule(ctx, resolved.text2img, stats))
  if (resolved.outputLadder.enabled) modules.push(createOutputLadderModule(ctx, resolved.outputLadder, stats))
  if (resolved.cache.enabled) modules.push(createCacheModule(ctx, resolved.cache, stats))
  if (resolved.monitor.enabled) modules.push(createMonitorModule(ctx, resolved.monitor, stats))
  if (resolved.fileDiff.enabled) modules.push(createFileDiffModule(ctx, resolved.fileDiff, stats))
  if (resolved.toolTrim.enabled) modules.push(createToolTrimModule(ctx, resolved.toolTrim, stats))
  // Validate the whole threshold group before saving. The host configEditor calls internal/config before writing;
  // scope it to this plugin's fiber so its validation is not imposed on subplugin configs.
  function validateConfig(value, next) {
    const candidate = next()
    if (!ctx.fiber || this === ctx.fiber) resolveConfig(candidate)
    return candidate
  }
  ctx.on('internal/config', validateConfig)
  modules.push(() => ctx.off?.('internal/config', validateConfig))
  const readCompression = () => resolveCompressionConfig(config)
  // Both listeners stay resident, mutually exclusive by live config; quotas and stats are not cleared when switching controllers.
  modules.push(createCompactionDriverModule(ctx, () => {
    const current = readCompression()
    return { ...current.compactionDriver, enabled: compressionMode(current) === 'legacy' }
  }, stats))
  modules.push(createLayeredCompactModule(ctx, () => {
    const current = readCompression()
    return { ...current.layeredCompact, enabled: compressionMode(current) === 'layered' }
  }, stats))
  modules.push(registerTokenStatusCommand(ctx, readCompression, stats, archive))
  // clean up all registered hooks when the plugin unloads
  return () => {
    for (const cleanup of modules) cleanup()
    stats.dispose()
  }
}

export { DEFAULT_CONFIG, resolveConfig }

export { Config } from './configSchema.js'

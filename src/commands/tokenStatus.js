// /token-status is the session observation entry point; every reading is taken from the same live config the drivers use.
import { compressionMode } from '../config.js'
import { computePressure, compressionServices } from '../modules/compactionDriver.js'

const labels = {
  running: 'summary request in flight (model call not yet confirmed)',
  success: 'success', noop: 'nothing to clean / no safe effective summary region',
  observed: 'observed only, not compacted', below: 'trigger condition not reached',
  unavailable: 'required service unavailable', noPressure: 'no reliable reading available',
  noHistory: 'cannot read turn count', minTurns: 'not enough turns', limit: 'success limit reached',
  busy: 'kernel busy (manual compaction, queue, or other maintenance)', backedOff: 'contention detected; auto summarization stopped for this session',
  backoff: 'brief backoff on the same history, not retried yet', cancelled: 'cancelled',
  timeout: 'timed out', failed: 'failed', unknown: 'failed (reason uncategorized)',
  result: 'failed (kernel returned an invalid result)',
}
const modeLabel = { legacy: 'Legacy driver', layered: 'Layered', off: 'Plugin auto-compaction off' }
const pct = (v) => (v * 100).toFixed(1) + '%'
const tokens = (p) => p ? String(p.totalTokens) : 'unavailable'

export function registerTokenStatusCommand(ctx, config, stats, archive) {
  const read = typeof config === 'function' ? config : () => config
  const meter = compressionServices(ctx, ['tokenMeter'])
  const disposers = []
  let active = true
  const injection = ctx.inject?.(['commands'], (svc) => {
    if (!active) return
    try {
      disposers.push(svc.commands.register({
        name: 'token-status',
        description: 'Show the effective compaction controller, thresholds, attempt/success counts, and recent readings',
        handler(invocation) {
          try {
            const current = read()
            const mode = compressionMode(current)
            const cfg = mode === 'legacy' ? current.compactionDriver : current.layeredCompact
            const agent = invocation?.agent
            const snapshot = stats.snapshotSession(agent?.id ?? agent?.session?.id)
            const c = snapshot.counters
            const p = agent?.session ? computePressure(
              { get: () => meter.get('tokenMeter') }, agent.session,
              mode === 'legacy' ? cfg.contextWindow : cfg.sessionWindowFallback,
            ) : null
            const lines = [
              'Current controller: ' + modeLabel[mode] + ' (the kernel safety compaction remains under host control)',
              mode === 'legacy'
                ? 'Legacy driver threshold: ' + pct(cfg.pressureRatio) + '; at least ' + cfg.minTurns + ' turns and ' + cfg.minTokens + ' estimated tokens'
                : 'Layered thresholds: observe ' + pct(current.layeredCompact.lowRatio) + ' / tool-history cleanup ' + pct(current.layeredCompact.midRatio) + ' / model summarization ' + pct(current.layeredCompact.highRatio) + (mode === 'off' ? ' (not currently enabled)' : ''),
              'Config effect: after saving, the next check uses the new values; operations already started use the original config snapshot.',
              p ? 'Pressure ratio ' + pct(p.ratio) + ' (estimated used ' + p.totalTokens + ' / window ' + p.window + '; window source: ' + (p.windowSource === 'event' ? 'request/context declaration, not a capacity measurement' : 'fallback value; actual occupancy uncertain') + ')' 
                : 'Pressure ratio: unavailable (missing session or valid metering)',
              'Below is this plugin\u2019s record for the current agent; kernel automatic/manual and other-plugin triggers are not counted.',
              'Observe-layer fires ' + (c['layeredCompact.observed'] ?? 0) + ' times (no pressure reduction)',
              'Tool-history cleanup: ' + (c['layeredCompact.lossless'] ?? 0) + ' applied / ' + (c['layeredCompact.pruneNoop'] ?? 0) + ' no change / ' + (c['layeredCompact.pruneUnavailable'] ?? 0) + ' service missing',
              'Cleanup has reduced the estimated context by ' + (c['layeredCompact.pruneSavedTokens'] ?? 0) + ' tokens in total (not the same as net billing savings)',
              'Layered model summarization: attempts ' + (c['layeredCompact.attempts'] ?? 0) + ' / success ' + (c['layeredCompact.lossy'] ?? 0) + ' / no effective region ' + (c['layeredCompact.noop'] ?? 0),
              'Legacy driver model summarization: attempts ' + (c['compactionDriver.triggers'] ?? 0) + ' / success ' + (c['compactionDriver.completed'] ?? 0) + ' / no effective region ' + (c['compactionDriver.code.noop'] ?? 0),
            ]
            const issues = Object.entries(c).filter(([key]) => /(?:failed\.|code\.(?:busy|cancelled)$|backedOff$)/.test(key))
            if (issues.length) lines.push('anomaly/backoff counters: ' + issues.map(([k, v]) => k + '=' + v).join(', '))
            const recent = snapshot.samples.filter((s) => s.module === 'compression').slice(-6)
            for (const s of recent) {
              lines.push(s.at + ' ' + modeLabel[s.controller] + '/' + ({ check: 'check', prune: 'tool-history cleanup', summary: 'model summarization' }[s.stage] ?? s.stage)
                + ': ' + (labels[s.status] ?? ('failed (' + s.status + ')'))
                + '; estimated tokens ' + tokens(s.before) + ' \u2192 ' + tokens(s.after)
                + (s.before && s.after ? ' (change this run ' + (s.before.totalTokens - s.after.totalTokens) + ')' : '')
                + (s.durationMs !== undefined ? '; took ' + s.durationMs + 'ms' : '')
                + '; model call ' + (s.modelCall === true ? 'yes' : s.modelCall === false ? 'no' : 'unconfirmed'))
            }
            lines.push('Token/API cost of the summary model itself: the host does not provide per-call usage, so this plugin does not estimate net billing savings.')
            lines.push('Runtime original-text archive: ' + (archive ? JSON.stringify(archive.status(agent?.session)) : 'not mounted'))
            return { kind: 'success', text: lines.join('\n') }
          } catch (err) {
            return { kind: 'error', text: 'token-status failed: ' + (err?.message ?? err) }
          }
        },
      }))
    } catch (err) { ctx.logger?.warn?.('token-status registration failed: %s', err?.message ?? err) }
  })
  return () => {
    active = false
    if (typeof injection === 'function') injection()
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    meter.dispose()
  }
}

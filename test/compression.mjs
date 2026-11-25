// TO-02: fictional session/services; verify observable behavior; no real model calls.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { resolveConfig, resolveCompressionConfig } from '../src/config.js'
import { createStats } from '../src/stats.js'
import { apply } from '../src/index.js'
import { createLayeredCompactModule } from '../src/modules/layeredCompact.js'
import { createCompactionDriverModule, computePressure } from '../src/modules/compactionDriver.js'
import { buildConfigSchema } from '../src/configSchema.js'

const tick = () => new Promise((r) => setImmediate(r))
const agent = (id = 'a') => ({ id, session: { id: 's-' + id, events: [
  ...Array.from({ length: 6 }, () => ({ type: 'turn/start' })),
  { type: 'request/context', data: { contextWindow: 100000 } },
] } })
function context(services = {}) {
  const handlers = new Map()
  const ctx = {
    fiber: {}, services, commands: [],
    on(key, fn) { const a = handlers.get(key) ?? []; a.push(fn); handlers.set(key, a); return () => ctx.off(key, fn) },
    off(key, fn) { const a = handlers.get(key) ?? []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) },
    get(key) { return services[key] },
    inject(keys, callback) {
      if (keys.includes('commands')) callback({ commands: { register(def) { ctx.commands.push(def); return () => ctx.commands.splice(ctx.commands.indexOf(def), 1) } } })
      else callback(Object.fromEntries(keys.map((k) => [k, services[k]])))
      return () => {}
    },
    async emit(key, data) { for (const fn of [...(handlers.get(key) ?? [])]) await fn(data) },
    validate(raw) {
      const list = handlers.get('internal/config') ?? []
      const run = (i) => i >= list.length ? raw : list[i].call(ctx.fiber, raw, () => run(i + 1))
      return run(0)
    },
    status(a) { return ctx.commands.find((c) => c.name === 'token-status').handler({ agent: a }) },
  }
  return ctx
}
const idle = async (ctx, a) => { await ctx.emit('agent/status', { agent: a, status: 'idle' }); await tick() }
const samples = (stats, a) => stats.snapshotSession(a.id).samples.filter((s) => s.module === 'compression')
const quiet = { text2img: { enabled: false }, outputLadder: { enabled: false }, monitor: { enabled: false }, toolTrim: { enabled: false } }

export async function runCompressionChecks(check) {
  console.log('== TO-02 config/controller/settings regression ==')
  const expect = (name, action) => {
    try { action(); check('TO-02 ' + name, true) }
    catch (err) { check('TO-02 ' + name + ': ' + err.message, false) }
  }
  const defaults = resolveConfig({})
  expect('legacy defaults kept, layered off by default, 40/50/65', () => {
    assert.equal(defaults.compactionDriver.enabled, true)
    assert.equal(defaults.layeredCompact.enabled, false)
    assert.deepEqual([defaults.layeredCompact.lowRatio, defaults.layeredCompact.midRatio, defaults.layeredCompact.highRatio], [0.4, 0.5, 0.65])
  })
  for (const value of [
    { lowRatio: 0 }, { lowRatio: 0.6 }, { midRatio: 0.65 }, { highRatio: 1 }, { highRatio: NaN },
    { highRatio: '' }, { highRatio: '0.8' }, { midRatio: 0.8, highRatio: 0.7 },
  ]) expect('backend rejects illegal threshold ' + JSON.stringify(value), () => assert.throws(() => resolveConfig({ layeredCompact: value })))
  expect('allow observe line equal to cleanup line', () => assert.doesNotThrow(() => resolveConfig({ layeredCompact: { lowRatio: 0.5 } })))
  expect('reject illegal window/timeout/fractional success quota', () => {
    for (const value of [{ sessionWindowFallback: 0 }, { highTierTimeoutMs: 0 }, { highTierMaxPerSession: 1.2 }])
      assert.throws(() => resolveConfig({ layeredCompact: value }))
  })
  expect('readings reject NaN/Infinity/negatives; fallback value labeled honestly', () => {
    for (const value of [NaN, Infinity, -1]) assert.equal(computePressure({ get: () => ({ measure: () => ({ totalTokens: value }) }) }, agent().session), null)
    const p = computePressure({ get: () => ({ measure: () => ({ totalTokens: 55 }) }) }, { events: [] }, 100)
    assert.equal(p.windowSource, 'fallback')
    assert.equal(p.ratio, 0.55)
  })

  for (const mode of ['legacy', 'layered']) {
    let result = null
    let calls = 0
    const stats = createStats()
    const a = agent(mode)
    const ctx = context({ tokenMeter: { measure: () => ({ totalTokens: 70000 }) }, compaction: { compactNow: async () => { calls++; return result } } })
    const cfg = mode === 'legacy'
      ? { ...defaults.compactionDriver, minTokens: 0, maxCompactionsPerSession: 1 }
      : { ...defaults.layeredCompact, enabled: true, highTierMaxPerSession: 1 }
    const dispose = (mode === 'legacy' ? createCompactionDriverModule : createLayeredCompactModule)(ctx, cfg, stats)
    await idle(ctx, a)
    await idle(ctx, a)
    expect(mode + ' null does not record success; the same history is not resubmitted briefly', () => {
      assert.equal(calls, 1)
      assert.equal(stats.snapshot().counters[mode === 'legacy' ? 'compactionDriver.completed' : 'layeredCompact.lossy'], undefined)
      assert.ok(samples(stats, a).some((s) => s.status === 'noop' && s.modelCall === false))
    })
    a.session.events.push({ type: 'turn/start' })
    result = {}
    await idle(ctx, a)
    await idle(ctx, a)
    expect(mode + ' history changes leave success quota; only success caps it', () => {
      assert.equal(calls, 2)
      assert.equal(stats.snapshot().counters[mode === 'legacy' ? 'compactionDriver.completed' : 'layeredCompact.lossy'], 1)
    })
    dispose()
  }
  {
    let tokens = 70000, calls = 0
    const stats = createStats(), a = agent('prune')
    const ctx = context({ tokenMeter: { measure: () => ({ totalTokens: tokens }) }, toolResultPruner: { pruneSession() { tokens = 30000 } } })
    createLayeredCompactModule(ctx, { ...defaults.layeredCompact, enabled: true }, stats)
    await idle(ctx, a)
    expect('cleanup works without a summary service; before/after amounts recompute', () => {
      const s = samples(stats, a).find((s) => s.stage === 'prune')
      assert.equal(s.savedTokens, 40000)
      assert.equal(s.before.totalTokens - s.after.totalTokens, 40000)
      assert.equal(s.after.windowSource, 'event')
      assert.equal(s.modelCall, false)
    })
    ctx.services.compaction = { compactNow: async () => { calls++; return {} } }
    tokens = 55000
    await idle(ctx, a)
    expect('after cleanup below the summary threshold, no summary call', () => assert.equal(calls, 0))
  }
  {
    let valid = true, calls = 0
    const stats = createStats(), a = agent('bad-meter')
    const ctx = context({
      tokenMeter: { measure: () => ({ totalTokens: valid ? 70000 : NaN }) },
      toolResultPruner: { pruneSession() { valid = false } },
      compaction: { compactNow: async () => { calls++; return {} } },
    })
    createLayeredCompactModule(ctx, { ...defaults.layeredCompact, enabled: true }, stats)
    await idle(ctx, a)
    expect('a failed re-measure after cleanup does not request a summary from stale pressure', () => {
      assert.equal(calls, 0)
      assert.ok(samples(stats, a).some((s) => s.status === 'noPressure'))
    })
  }
  for (const code of ['busy', 'summary', 'timeout']) {
    const stats = createStats(), a = agent(code)
    const ctx = context({
      tokenMeter: { measure: () => ({ totalTokens: 70000 }) },
      compaction: { compactNow: async (_, signal) => {
        if (code === 'timeout') return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
        throw Object.assign(new Error(code), { code })
      } },
    })
    createLayeredCompactModule(ctx, { ...defaults.layeredCompact, enabled: true, highTierTimeoutMs: 5 }, stats)
    await Promise.all([idle(ctx, a), new Promise((r) => setTimeout(r, 15))])
    expect(code + ' classification is explicit and does not consume success counts', () => {
      assert.equal(stats.snapshot().counters['layeredCompact.failed.' + code], 1)
      assert.equal(stats.snapshot().counters['layeredCompact.lossy'], undefined)
      assert.ok(samples(stats, a).some((s) => s.status === code && s.modelCall === null))
    })
  }
  {
    let calls = 0, cfg = { ...defaults.layeredCompact, enabled: true }
    const stats = createStats(), a = agent('queued')
    const ctx = context({ tokenMeter: { measure: () => ({ totalTokens: 70000 }) }, compaction: { compactNow: async () => { calls++; return {} } } })
    const dispose = createLayeredCompactModule(ctx, () => cfg, stats)
    const pending = ctx.emit('agent/status', { agent: a, status: 'idle' })
    cfg = { ...cfg, enabled: false }
    await pending
    expect('turning the switch off before start cancels queued actions', () => assert.equal(calls, 0))
    cfg = { ...cfg, enabled: true }
    const pending2 = ctx.emit('agent/status', { agent: a, status: 'idle' })
    dispose()
    await pending2
    expect('no queued summary after unload', () => assert.equal(calls, 0))
  }
  {
    let cfg = { ...defaults.layeredCompact, enabled: true }, finish, calls = 0
    const stats = createStats(), a = agent('snapshot')
    const ctx = context({ tokenMeter: { measure: () => ({ totalTokens: 70000 }) }, compaction: { compactNow: async () => { calls++; return new Promise((r) => { finish = r }) } } })
    const dispose = createLayeredCompactModule(ctx, () => cfg, stats)
    const pending = ctx.emit('agent/status', { agent: a, status: 'idle' })
    await tick()
    cfg = { ...cfg, highRatio: 0.9 }
    finish({})
    await pending
    await idle(ctx, a)
    expect('in-flight operations finish; the next check uses the new thresholds', () => {
      assert.equal(calls, 1)
      assert.equal(stats.snapshot().counters['layeredCompact.lossy'], 1)
    })
    dispose()
  }
  {
    let calls = 0, prunes = 0
    const current = { legacy: { ...defaults.compactionDriver, minTokens: 0 }, layered: { ...defaults.layeredCompact } }
    const raw = { ...quiet,
      compactionDriver: { get: () => current.legacy },
      layeredCompact: { get: () => current.layered },
    }
    const ctx = context({
      tokenMeter: { measure: () => ({ totalTokens: 70000 }) },
      toolResultPruner: { pruneSession() { prunes++ } },
      compaction: { compactNow: async () => { calls++; return {} } },
    })
    const dispose = apply(ctx, raw), a = agent('live')
    await idle(ctx, a)
    expect('initial controller, triggers, and status agree', () => {
      assert.equal(calls, 1)
      assert.match(ctx.status(a).text, /Current controller: Legacy driver/)
      assert.match(ctx.status(a).text, /Legacy driver model summarization: attempts 1 \/ success 1/)
    })
    current.layered = { ...current.layered, enabled: true, highRatio: 0.8 }
    await idle(ctx, a)
    expect('switching to layered needs no remount; legacy is mutually exclusive', () => {
      assert.equal(prunes, 1)
      assert.equal(calls, 1)
      assert.match(ctx.status(a).text, /Current controller: Layered/)
      assert.match(ctx.status(a).text, /model summarization 80.0%/)
    })
    current.layered = { ...current.layered, highRatio: 0.6 }
    await idle(ctx, a)
    expect('after lowering the summary threshold the next check uses live values', () => assert.equal(calls, 2))
    current.layered = { ...current.layered, enabled: false }
    current.legacy = { ...current.legacy, enabled: false }
    await idle(ctx, a)
    expect('no actions after off; records remain and the kernel safety note is present', () => {
      assert.equal(calls, 2)
      assert.equal(prunes, 2)
      assert.match(ctx.status(a).text, /Current controller: Plugin auto-compaction off/)
      assert.match(ctx.status(a).text, /the kernel safety compaction remains under host control/)
      assert.match(ctx.status(a).text, /Runtime original-text archive:.*"enabled":false/)
    })
    let writes = 0
    expect('host pre-write validation rejects crossed thresholds', () => {
      assert.throws(() => { ctx.validate({ ...quiet, layeredCompact: { highRatio: 0.4 } }); writes++ }, /thresholds/)
      assert.equal(writes, 0)
    })
    const saved = { ...quiet, compactionDriver: current.legacy, layeredCompact: current.layered }
    dispose()
    const next = context({ tokenMeter: { measure: () => ({ totalTokens: 70000 }) } })
    const stop = apply(next, saved)
    expect('saved data yields the same controller and thresholds after restart; a missing summary service does not sink the plugin', () => {
      assert.match(next.status(a).text, /Current controller: Plugin auto-compaction off/)
      assert.match(next.status(a).text, /model summarization 60.0%/)
    })
    stop()
  }

  // reuse the current host schema andsettings projection functions, without loading the desktop or a real profile.
  if (process.env.DSH_OPTIMIZER_HOST_FIXTURE) {
    const folder = pathToFileURL(process.env.DSH_OPTIMIZER_HOST_FIXTURE.replace(/\\/g, '/') + '/')
    const S = (await import(new URL('node_modules/@deepseek-ai/schemastery/lib/index.mjs', folder))).default
    const { updateVolatile } = await import(new URL('node_modules/@deepseek-ai/cosmokit/lib/index.js', folder))
    const schema = buildConfigSchema(S)
    const source = readFileSync(new URL('settings-contract.js', folder), 'utf8')
    const get = (name) => {
      const start = source.indexOf('function ' + name + '(')
      assert.ok(start >= 0, 'missing host function ' + name)
      return source.slice(start, source.indexOf('\n}', start) + 2)
    }
    const sandbox = { z: S, isPlainObject: (v) => v !== null && typeof v === 'object' && !Array.isArray(v) }
    vm.createContext(sandbox)
    vm.runInContext(['isRecord', 'walk', 'redactSecrets', 'plainSchema', 'volatileForm', 'isExpression', 'projectForm'].map(get).join('\n'), sandbox)
    const raw = { ...quiet, compactionDriver: { minTurns: 9, minTokens: 12345, maxCompactionsPerSession: 7, contextWindow: 555555, timeoutMs: 54321 },
      layeredCompact: { highTierTimeoutMs: 45678, highTierMaxPerSession: 4, sessionWindowFallback: 888888, pricing: { inputPerMillion: 5, cacheHitPerMillion: 6, outputPerMillion: 7 } } }
    const projected = sandbox.projectForm(sandbox.volatileForm(schema), raw)
    const updated = { ...projected, layeredCompact: { ...projected.layeredCompact, enabled: true, lowRatio: 0.45, midRatio: 0.55, highRatio: 0.75 } }
    expect('host projection keeps legacy-driver limits、layered timeout/counts/window/pricing', () => {
      assert.deepEqual(JSON.parse(JSON.stringify(projected)), { compactionDriver: raw.compactionDriver, layeredCompact: raw.layeredCompact })
      const resolved = resolveConfig(schema(updated))
      assert.equal(resolved.compactionDriver.minTokens, 12345)
      assert.equal(resolved.layeredCompact.highTierMaxPerSession, 4)
      assert.equal(resolved.layeredCompact.pricing.inputPerMillion, 5)
    })
    expect('after a real volatile reference updates, new value, restart resolution is consistent', () => {
      const active = schema(raw), next = schema(updated)
      updateVolatile(active.layeredCompact, next.layeredCompact)
      assert.equal(resolveCompressionConfig(active).layeredCompact.highRatio, 0.75)
      assert.equal(resolveCompressionConfig(schema(updated)).layeredCompact.highRatio, 0.75)
    })
    expect('schema JSON round-trip supports settings projection, no function-serialization dependency', () => {
      const copy = new S(schema.toJSON())
      assert.equal(resolveCompressionConfig(copy(updated)).layeredCompact.highRatio, 0.75)
    })
  } else console.log('  host contract checks skipped (set DSH_OPTIMIZER_HOST_FIXTURE for installed-host fixtures)')

  // the logic layer simulates React/slot/configForms; without claiming real desktop visual acceptance.
  const clientSource = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  function ui(initial, mutateResult = true) {
    let snapshot = initial, component, module, cursor = 0, renderedHooks, writes = [], disposed = 0
    const states = [], effects = []
    const react = {
      createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat() } } },
      useSyncExternalStore() { cursor++; return snapshot },
      useState(init) {
        const i = cursor++
        if (!(i in states)) states[i] = typeof init === 'function' ? init() : init
        return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value }]
      },
      useEffect(fn, deps) {
        const i = cursor++
        if (JSON.stringify(effects[i]) !== JSON.stringify(deps)) { effects[i] = deps; fn() }
      },
    }
    vm.runInNewContext(clientSource, { window: { __ModuleLoader__: { load(spec) { module = spec.factory(() => react) } } } })
    const form = {
      getSnapshot: () => snapshot, subscribe: () => () => {},
      async mutate(ops) { writes.push(ops); if (mutateResult instanceof Error) throw mutateResult; return mutateResult },
    }
    const cleanup = module.apply({
      slots: { register(meta, view) { assert.equal(meta.name, 'settings.general.item'); assert.equal(typeof view, 'function'); component = view; return () => { disposed++ } } },
      configForms: { get: () => form, whileServed: () => () => { disposed++ } },
    })
    const render = () => { cursor = 0; const tree = component(); renderedHooks = cursor; return tree }
    const all = (tree) => typeof tree !== 'object' || !tree ? [] : [tree, ...tree.props.children.flatMap(all)]
    const text = (tree) => typeof tree === 'string' ? tree : tree?.props ? tree.props.children.map(text).join(' ') : ''
    const input = (label) => all(render()).find((n) => n.props['aria-label'] === label)
    const click = (label) => all(render()).find((n) => n.type === 'button' && (!label || text(n) === label)).props.onClick()
    return { render, text, input, click, writes, hooks: () => renderedHooks, cleanup, disposed: () => disposed, setSnapshot(value) { snapshot = value } }
  }
  const ready = { status: 'ready', writable: true, value: resolveConfig({}) }
  {
    const view = ui(ready)
    expect('general settings include independent thresholds, strategy, and observe-only notes', () => {
      assert.ok(view.input('Tool-history cleanup threshold'))
      assert.ok(view.input('Model summarization threshold'))
      assert.match(view.text(view.render()), /observation only, no compaction/)
      assert.equal(view.input('Auto-compaction strategy').props.value, 'legacy')
    })
    view.input('Model summarization threshold').props.onChange({ target: { value: '' } })
    await view.click()
    expect('clearing the input does not write 0、and sends no save request', () => {
      assert.equal(view.writes.length, 0)
      assert.match(view.text(view.render()), /Not saved/)
    })
    view.input('Model summarization threshold').props.onChange({ target: { value: '45' } })
    await view.click()
    expect('crossed threshold values are rejected client-side', () => assert.equal(view.writes.length, 0))
    view.input('Model summarization threshold').props.onChange({ target: { value: '75' } })
    view.input('Auto-compaction strategy').props.onChange({ target: { value: 'layered' } })
    await view.click()
    expect('one atomic commit of both switches and all threshold values, with clear activation timing', () => {
      assert.equal(view.writes.length, 1)
      assert.equal(view.writes[0].length, 6)
      const ops = JSON.parse(JSON.stringify(view.writes[0]))
      assert.deepEqual(ops.slice(0, 2).map((o) => o.value), [true, false])
      assert.equal(ops[4].value, 0.75)
      assert.match(view.text(view.render()), /the next compaction check uses the new config/)
    })
    view.cleanup()
    view.cleanup()
    expect('client unload releases the slot and subscriptions, cleanup is repeatable', () => assert.equal(view.disposed(), 2))
  }
  {
    const view = ui(ready)
    expect('the archive UI is off by default and provides a directory、independent save and retry', () => {
      assert.equal(view.input('Enable original-text archiving').props.checked, false)
      assert.ok(view.input('Original-text archive directory'))
      assert.match(view.text(view.render()), /A failed write blocks the related request/)
    })
    view.input('Enable original-text archiving').props.onChange({ target: { checked: true } })
    await view.click('Save archive settings')
    expect('an empty archive path refuses to save', () => assert.equal(view.writes.length, 0))
    view.input('Original-text archive directory').props.onChange({ target: { value: 'D:\\synthetic\\archive' } })
    await view.click('Save archive settings')
    expect('archiving saves atomically on its own without changing compaction threshold values、and never falsely reports a successful write', () => {
      assert.equal(view.writes.length, 1)
      assert.ok(view.writes[0].every(op => op.path[0] === 'archive'))
      assert.match(view.text(view.render()), /check \/token-status for write status/)
    })
    view.setSnapshot({ ...ready, value: { ...ready.value, archive: { enabled: true, directory: 'D:\\old', previousDirectories: [], retryGeneration: 8 } } })
    view.render(); view.render()
    view.input('Original-text archive directory').props.onChange({ target: { value: 'E:\\new' } })
    await view.click('Save archive settings')
    expect('changing directories keeps the old directory index, without moving files automatically', () => assert.deepEqual(JSON.parse(JSON.stringify(view.writes.at(-1)[2].value)), ['D:\\old']))
    await view.click('Retry archiving')
    expect('an explicit UI retry only updates the counter and does not treat a submission as a successful write', () => {
      assert.equal(view.writes.at(-1).length, 1)
      assert.equal(view.writes.at(-1)[0].value, 9)
      assert.match(view.text(view.render()), /Retry submitted; check \/token-status for the write result/)
    })
    view.cleanup()
  }
  for (const result of [false, null, new Error('disk rejected')]) {
    const view = ui(ready, result)
    await view.click()
    expect('a save rejection/exception does not falsely report success ' + String(result), () => {
      assert.doesNotMatch(view.text(view.render()), /Saved/)
      assert.match(view.text(view.render()), result === null ? /Save result unconfirmed/ : /Save failed/)
    })
    view.cleanup()
  }
  {
    const view = ui(null)
    const initialHooks = (view.render(), view.hooks())
    expect('not-ready shows default reference values and is non-editable, without pretending to be live config', () => {
      assert.equal(view.input('Tool-history cleanup threshold').props.disabled, true)
      assert.match(view.text(view.render()), /non-editable defaults for reference/)
    })
    view.setSnapshot(ready); view.render(); view.render()
    expect('service going from never-ready to ready keeps the hook count, editable', () => {
      assert.equal(view.hooks(), initialHooks)
      assert.equal(view.input('Tool-history cleanup threshold').props.disabled, false)
    })
    view.setSnapshot({ ...ready, writable: false })
    expect('read-only config clearly disables saving', () => {
      assert.equal(view.input('Model summarization threshold').props.disabled, true)
      assert.match(view.text(view.render()), /The current config is read-only/)
    })
    view.cleanup()
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = 0, passed = 0
  await runCompressionChecks((name, ok) => { if (ok) { passed++; console.log('  ok  ' + name) } else { failed++; console.error('FAIL  ' + name) } })
  console.log(passed + ' passed, ' + failed + ' failed')
  process.exitCode = failed ? 1 : 0
}

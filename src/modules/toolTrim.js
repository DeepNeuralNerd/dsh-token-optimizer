// Scoped tool availability and bounded MCP discovery; verified against DSH 0.2.1-rc.2.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value) }],
}

// Resolve the core defineTool (not declared as a dependency; borrowed at runtime via createRequire).
// Multiple anchors: the plugin's own location (a link install cannot reach the profile dependency bridge) -> DSH_ROOT ->
// DSH_HOME/.dsh profiles/node_modules (the symlink bridge the CLI installer generates,
// pointing back to the global CLI tree, the same dependency as dsh-undo-savepoint) -> the global npm directory.
// If every anchor fails, returns undefined; mcpLazy degrades to disabled, and static trimming is unaffected.
export function resolveDefineTool() {
  const anchors = []
  anchors.push(import.meta.url) // the plugin's own location
  if (process.env.DSH_ROOT) anchors.push(join(process.env.DSH_ROOT, 'package.json'))
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  anchors.push(join(dshHome, 'profiles', 'node_modules', 'noop.js'))
  if (process.env.APPDATA) anchors.push(join(process.env.APPDATA, 'npm', 'node_modules', 'noop.js'))
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor)
      req.resolve('@deepseek-ai/dsh-tools')
      const mod = req('@deepseek-ai/dsh-tools')
      if (mod && typeof mod.defineTool === 'function') return mod.defineTool
    } catch { /* next anchor */ }
  }
  return undefined
}

function getView(tools, agent) {
  try {
    const view = tools?.view?.(agent)
    return view?.restrictableNames instanceof Set && view.visible instanceof Map ? view : null
  } catch { return null }
}

const PAGE_SIZE = 10
const MAX_PAGE = 20
const MAX_LOAD = 20
const label = name => name.length > 200 ? name.slice(0, 200) + '…' : name
const warn = message => console.warn('[dsh-token-optimizer] toolTrim: ' + message)

export function createToolTrimModule(ctx, config, stats, deps = {}) {
  if (!config?.enabled || typeof ctx?.on !== 'function') return () => {}
  // null/omitted means unrestricted; [] intentionally allows no inherited tools.
  const allow = Array.isArray(config.allow) ? new Set(config.allow) : null
  const deny = new Set(config.deny ?? [])
  const defineTool = config.mcpLazy ? (deps.defineTool ?? resolveDefineTool()) : undefined
  const gates = new Map()
  const ownedDefinitions = new WeakSet()
  let closed = false
  let warnedCompatibility = false
  const allowed = name => (allow === null || allow.has(name)) && !deny.has(name)
  const live = gate => !closed && !gate.dead && gates.get(gate.agent.id) === gate
  function dispose(effect) {
    try { effect?.(); return true } catch (err) { warn('undo failed: ' + (err?.message ?? err)); return false }
  }
  function dropMeta(gate) {
    const effect = gate.metaDisposer
    gate.metaDisposer = undefined
    gate.definition = undefined
    dispose(effect)
  }
  function destroy(gate) {
    gate.dead = true
    gates.delete(gate.agent.id) // invalidate callbacks before effects emit tools/change
    dropMeta(gate)
    dispose(gate.disposer)
    gate.disposer = undefined
    gate.catalog.clear()
    gate.released.clear()
  }

  function mount(gate, view, released, lazyReady) {
    const valid = name => name !== 'run_code' && (!view || view.restrictableNames.has(name))
    const filter = {}
    if (allow !== null) filter.allow = [...allow].filter(valid).sort()
    const hidden = lazyReady ? [...gate.catalog.keys()].filter(name => !released.has(name)) : []
    const blocked = [...new Set([...deny, ...hidden])].filter(valid).sort()
    if (blocked.length) filter.deny = blocked
    const key = JSON.stringify(filter)
    if (gate.filterKey === key) return true
    let effect
    try {
      if (filter.allow !== undefined || filter.deny !== undefined) {
        effect = gate.tools.restrict(filter)
        if (typeof effect !== 'function') throw Error('restrict returned no undoable handle; filter replacement cannot be guaranteed')
      }
    } catch (err) { warn('filter not applied: ' + (err?.message ?? err)); return false }
    if (!live(gate)) { dispose(effect); return false }
    const old = gate.disposer
    gate.disposer = effect
    gate.filterKey = key // own mutation events must not remount this filter
    if (!dispose(old)) {
      gate.disposer = () => { effect?.(); old?.() }
      gate.filterKey = undefined
      return false
    }
    if (effect) {
      stats?.bump('tooltrim.applied', 1)
      stats?.addSample({ module: 'tooltrim', allow: filter.allow?.length, deny: blocked.length, mcpReleased: released.size })
    }
    return true
  }

  function registerMeta(gate, view) {
    if (deny.has(config.mcpLoadToolName)) { dropMeta(gate); return false }
    if (gate.metaDisposer && view.visible.get(config.mcpLoadToolName) === gate.definition) return true
    dropMeta(gate)
    const existing = view.visible.get(config.mcpLoadToolName)
    if (view.knownNames?.has(config.mcpLoadToolName) && !ownedDefinitions.has(existing)) {
      warn('found a same-named ' + config.mcpLoadToolName + '; keeping the original tool and disabling lazy loading for this scope')
      return false
    }
    if (typeof gate.tools.register !== 'function') return false
    try {
      const definition = defineTool({
        name: config.mcpLoadToolName,
        description: 'Search and load MCP tools on demand. Use query to search names or descriptions (an empty query browses the catalog), offset/limit to page, then names to load exact tool names. Returns only a bounded catalog; tools that load successfully appear in later requests. Respects user and parent-scope restrictions; load failures report their reason.',
        parameters: {
          query: { type: 'string', description: 'Optional: keywords matching tool name, server name, or description; up to 200 characters' },
          offset: { type: 'integer', description: 'Optional: which match to start from, default 0' },
          limit: { type: 'integer', description: 'Optional: 1-20 matches per page, default 10' },
          names: { type: 'array', items: { type: 'string' }, description: 'Optional: exact tool names to load, up to 20 per call; omit to search only' },
        },
        output: TEXT_OUTPUT,
        isConcurrencySafe: () => false,
        execute: (args, exec) => execute(args, exec),
      })
      gate.definition = definition
      ownedDefinitions.add(definition)
      const effect = gate.tools.register(definition)
      if (typeof effect !== 'function') throw Error('register returned no undoable handle')
      if (!live(gate)) { dispose(effect); return false }
      gate.metaDisposer = effect
      return getView(gate.tools, gate.agent)?.visible.get(config.mcpLoadToolName) === definition
    } catch (err) {
      gate.definition = undefined
      warn('meta-tool registration failed; MCP visibility unchanged: ' + (err?.message ?? err))
      return false
    }
  }

  // Registry and restriction APIs are synchronous in the verified core.
  // Guard reentrancy because both register/restrict/dispose emit tools/change.
  function refresh(gate, proposed) {
    if (!live(gate) || gate.refreshing) return false
    gate.refreshing = true
    try {
      const view = getView(gate.tools, gate.agent)
      const catalog = new Map()
      if (config.mcpLazy && (!view || typeof defineTool !== 'function') && !warnedCompatibility) {
        warnedCompatibility = true
        warn('no reliable tools.view or defineTool; disabling lazy loading and keeping explicit static restrictions')
      }
      if (config.mcpLazy && typeof defineTool === 'function' && view) {
        // Read global definitions for metadata only: a hidden name stays known.
        // This never registers or force-allows a global tool.
        const global = getView(gate.tools, undefined)
        for (const name of [...view.restrictableNames].sort()) {
          if (!name.startsWith(config.mcpPrefix) || name === config.mcpLoadToolName) continue
          const prev = gate.catalog.get(name)
          const definition = view.visible.get(name) ?? global?.visible.get(name) ?? prev?.definition
          const globalDefinition = global?.visible.get(name)
          if (prev && globalDefinition && prev.globalDefinition !== globalDefinition) gate.released.delete(name)
          catalog.set(name, {
            definition, globalDefinition,
            description: definition ? String(definition.description ?? '') : (prev?.description ?? ''),
          })
        }
      }
      if (!gate.detected && catalog.size) { gate.detected = true; stats?.bump('toolgate.mcpDetected', 1) }
      gate.catalog = catalog
      for (const name of gate.released) if (!catalog.has(name) || !allowed(name)) gate.released.delete(name)
      const nextReleased = new Set([...(proposed ?? gate.released)].filter(name => catalog.has(name) && allowed(name)))
      let lazyReady = false
      if (catalog.size && view) lazyReady = registerMeta(gate, view)
      else dropMeta(gate)
      if (!live(gate)) return false
      const ok = mount(gate, view, nextReleased, lazyReady)
      if (ok) gate.released = nextReleased
      return ok && lazyReady
    } finally { gate.refreshing = false }
  }

  function execute(args, exec) {
    const gate = gates.get(exec?.agent?.id)
    if (!gate || gate.agent !== exec.agent || !live(gate)) return 'No MCP gate state found for this session; the load did not take effect'
    refresh(gate)
    const input = Array.isArray(args?.names) ? args.names : []
    const names = [...new Set(input.slice(0, MAX_LOAD).filter(name => typeof name === 'string'))]
    const before = new Set(gate.released)
    const proposed = new Set(before)
    const failed = [], loaded = []
    for (const name of names) {
      if (!gate.catalog.has(name)) failed.push({ name: label(name), reason: 'unknown or disconnected' })
      else if (!allowed(name)) failed.push({ name: label(name), reason: 'restricted by user allow/deny' })
      else proposed.add(name)
    }
    const attempted = names.filter(name => gate.catalog.has(name) && allowed(name))
    const applied = attempted.length ? refresh(gate, proposed) : false
    const visible = getView(gate.tools, gate.agent)?.visible
    const rollback = new Set(gate.released)
    for (const name of attempted) {
      if (applied && visible?.has(name)) loaded.push(name)
      else {
        failed.push({ name: label(name), reason: applied ? 'still restricted by another scope; not callable yet' : 'the load filter did not take effect; retry' })
        if (!before.has(name)) rollback.delete(name)
      }
    }
    if ([...gate.released].some(name => !rollback.has(name))) refresh(gate, rollback)
    const newlyLoaded = loaded.filter(name => !before.has(name)).length
    if (newlyLoaded) { stats?.bump('toolgate.mcpReleased', newlyLoaded); stats?.bump('toolgate.remounts', 1) }
    const query = typeof args?.query === 'string' ? args.query.slice(0, 200).toLowerCase() : ''
    const offset = Number.isSafeInteger(args?.offset) && args.offset > 0 ? args.offset : 0
    const limit = Number.isSafeInteger(args?.limit) ? Math.max(1, Math.min(MAX_PAGE, args.limit)) : PAGE_SIZE
    const matches = [...gate.catalog].filter(([name, entry]) => allowed(name) && (name.toLowerCase().includes(query) || entry.description.toLowerCase().includes(query)))
    const finalView = getView(gate.tools, gate.agent)
    const items = matches.slice(offset, offset + limit).map(([name, entry]) => ({
      name: label(name), description: entry.description.replace(/\s+/g, ' ').slice(0, 120),
      state: finalView?.visible.has(name) ? 'available' : 'unloaded_or_restricted',
    }))
    return 'Released: ' + (loaded.map(label).join(', ') || '(none)') + '\n' + JSON.stringify({
      failed, ignoredNames: Math.max(0, input.length - MAX_LOAD),
      total: [...gate.catalog.keys()].filter(allowed).length, matched: matches.length, offset, limit,
      nextOffset: offset + items.length < matches.length && items.length ? offset + items.length : null,
      items,
    })
  }

  const onCreated = payload => {
    const agent = payload?.agent
    if (closed || agent?.id === undefined || typeof agent.ctx?.tools?.restrict !== 'function') return
    const previous = gates.get(agent.id)
    if (previous?.agent === agent) return
    if (previous) destroy(previous)
    const gate = { agent, tools: agent.ctx.tools, catalog: new Map(), released: new Set(), dead: false, refreshing: false }
    gates.set(agent.id, gate)
    try { refresh(gate) } catch (err) { warn('init failed: ' + (err?.message ?? err)) }
  }
  const onChange = () => {
    if (closed) return
    for (const gate of [...gates.values()]) {
      try { refresh(gate) } catch (err) { warn('refresh failed: ' + (err?.message ?? err)) }
    }
  }
  const onDisposed = payload => {
    const gate = gates.get(payload?.agent?.id)
    if (gate && gate.agent === payload.agent) destroy(gate)
  }
  ctx.on('agent/created', onCreated)
  ctx.on('tools/change', onChange)
  ctx.on('agent/disposed', onDisposed)
  return () => {
    if (closed) return
    closed = true
    ctx.off('agent/created', onCreated)
    ctx.off('tools/change', onChange)
    ctx.off('agent/disposed', onDisposed)
    for (const gate of [...gates.values()]) destroy(gate)
  }
}

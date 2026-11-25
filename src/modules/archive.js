// Original-text archiving uses only public runtime APIs; it does not replace Session.append or host persistence.
import * as fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { resolveArchiveConfig } from '../config.js'
import { resolveDefineTool } from './toolTrim.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const copy = value => JSON.parse(JSON.stringify(value))
const textOf = record => {
  const message = record.message ?? record.data?.message ?? record.data
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) return message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
  return JSON.stringify(record.frame ?? record.data ?? message ?? '')
}
const roleOf = r => r.kind === 'input' ? 'user-original' : r.eventType ?? r.kind
const abort = signal => { if (signal?.aborted) throw signal.reason ?? new Error('archive wait was cancelled') }
const waitTick = signal => new Promise((done, reject) => {
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); done() }
  const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(signal.reason ?? new Error('archive wait was cancelled')) }
  const timer = setTimeout(finish, 100)
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
})

export function createArchiveModule(ctx, config, deps = {}) {
  const io = deps.fs ?? fs
  const boot = randomUUID()
  const states = new Map(), agents = new Map(), listeners = [], disposers = []
  const defineTool = deps.defineTool ?? resolveDefineTool()
  let closed = false
  let sessionStore = null
  const read = () => resolveArchiveConfig(typeof config === 'function' ? config() : config)
  function state(session) {
    let s = states.get(session.id)
    if (!s) {
      s = { session, scan: 0, pending: new Map(), seen: new Set(), index: [], roots: new Set(),
        initialized: new Set(), serial: Promise.resolve(), error: null, failedKey: null, retry: 0,
        durable: -1, file: null, bytes: 0, tools: new Set(), coverage: 'Stream fragments from before enabling cannot be backfilled; history is backfilled only from events the host still retains.' }
      states.set(session.id, s)
    }
    s.session = session
    return s
  }
  const keyOf = (s, cfg) => JSON.stringify([resolve(cfg.directory), cfg.retryGeneration, s.retry])
  function add(s, record) {
    if (!s.seen.has(record.key) && !s.pending.has(record.key)) {
      s.pending.set(record.key, { v: 1, sessionId: s.session.id, time: new Date().toISOString(), ...copy(record) })
    }
  }
  function input(s, message, origin, seq) {
    if (message?.source?.kind === 'runtime-context') return
    add(s, { kind: 'input', key: 'input:' + hash(JSON.stringify(message)), message, origin, ...(seq === undefined ? {} : { seq }) })
  }
  function collect(s) {
    if (typeof s.session.snapshotEvents !== 'function') throw new Error('the host lacks snapshotEvents; archiving cannot proceed')
    for (const e of s.session.snapshotEvents(s.scan)) {
      if (e.type === 'agent/inbox/spliced') for (const m of e.data.inserted ?? []) input(s, m, 'inbox', e.seq)
      if (e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'assistant/attempt') {
        add(s, { kind: 'event', key: 'event:' + e.seq, eventType: e.type, seq: e.seq, time: e.time, data: e.data })
      }
      s.scan = Math.max(s.scan, e.seq + 1)
    }
  }
  function metadata(record, file, offset, bytes) {
    return { key: record.key, file, offset, bytes, seq: record.seq, role: roleOf(record), time: record.time,
      excerpt: textOf(record).slice(0, 180) }
  }
  const prefix = s => hash(String(s.session.id)).slice(0, 32) + '-'
  async function loadRoot(s, root) {
    if (s.initialized.has(root)) return
    let names
    try { names = await io.readdir(root) } catch (e) { if (e.code === 'ENOENT') { s.initialized.add(root); return } throw e }
    const loaded = []
    for (const name of names.filter(n => n.startsWith(prefix(s)) && n.endsWith('.jsonl')).sort()) {
      const file = join(root, name)
      // Repair only the unfinished trailing line a crash left behind; a complete but corrupt JSON record raises an error instead of overwriting history.
      const handle = await io.open(file, 'r+')
      try {
        const size = (await handle.stat()).size
        if (size) {
          const tail = Buffer.alloc(1); await handle.read(tail, 0, 1, size - 1)
          if (tail[0] !== 10) {
            const owner = Number(name.slice(prefix(s).length).split('-')[0])
            let active = true
            if (Number.isSafeInteger(owner) && owner > 0 && owner !== process.pid) {
              try { process.kill(owner, 0) } catch (e) { if (e.code === 'ESRCH') active = false }
            } else if (file === s.file) active = false
            if (active) throw Object.assign(new Error('archive tail is incomplete; cannot rewrite a segment that may still be in use'), { code: 'EBUSY' })
            let position = size, end = 0
            while (position > 0) {
              const count = Math.min(65536, position); position -= count
              const part = Buffer.alloc(count); await handle.read(part, 0, count, position)
              const newline = part.lastIndexOf(10)
              if (newline >= 0) { end = position + newline + 1; break }
            }
            await handle.truncate(end)
          }
        }
        await handle.sync()
      } finally { await handle.close() }
      const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
      let offset = 0
      try {
        for await (const line of lines) {
          const bytes = Buffer.byteLength(line) + 1, record = JSON.parse(line)
          if (record.v !== 1 || record.sessionId !== s.session.id || typeof record.key !== 'string') throw new Error('archive record format or session mismatch')
          loaded.push(metadata(record, file, offset, bytes)); offset += bytes
        }
      } finally { lines.close() }
    }
    for (const m of loaded) if (!s.seen.has(m.key)) { s.seen.add(m.key); s.index.push(m); s.pending.delete(m.key) }
    s.initialized.add(root)
  }
  async function commit(s, cfg) {
    const root = resolve(cfg.directory)
    s.roots.add(root)
    for (const old of cfg.previousDirectories) s.roots.add(resolve(old))
    for (const dir of s.roots) await loadRoot(s, dir)
    await io.mkdir(root, { recursive: true })
    const file = join(root, prefix(s) + process.pid + '-' + boot + '.jsonl')
    if (file !== s.file) { s.file = file; s.bytes = 0 }
    for (const key of s.seen) s.pending.delete(key)
    const batch = [...s.pending.values()]
    if (!batch.length) { s.error = null; s.failedKey = null; s.durable = s.scan - 1; return }
    const lines = batch.map(r => JSON.stringify(r) + '\n')
    // Each process/plugin lifecycle owns its own segment; it never contends with another desktop process writing the same file.
    let handle
    try { handle = await io.open(file, 'r+') }
    catch (error) { if (error.code !== 'ENOENT') throw error; handle = await io.open(file, 'wx+') }
    let start
    try {
      start = (await handle.stat()).size
      let position = start
      for (const line of lines) {
        const buffer = Buffer.from(line)
        let written = 0
        while (written < buffer.length) {
          const result = await handle.write(buffer, written, buffer.length - written, position + written)
          if (result.bytesWritten <= 0) throw new Error('archive write made no progress')
          written += result.bytesWritten
        }
        position += buffer.length
      }
      await handle.sync()
    } catch (error) {
      try { if (start !== undefined) { await handle.truncate(start); await handle.sync() } }
      catch (rollbackError) { s.initialized.delete(root); throw new AggregateError([error, rollbackError], 'archive write and rollback both failed; staying paused') }
      throw error
    } finally {
      try { await handle.close() } catch (error) { s.initialized.delete(root); throw error }
    }
    let offset = start
    for (let i = 0; i < batch.length; i++) {
      const record = batch[i], bytes = Buffer.byteLength(lines[i])
      s.seen.add(record.key); s.pending.delete(record.key)
      s.index.push(metadata(record, file, offset, bytes)); offset += bytes
    }
    s.bytes = offset; s.durable = s.scan - 1; s.error = null; s.failedKey = null
  }
  async function once(s, cfg) {
    const key = keyOf(s, cfg)
    if (s.failedKey === key) throw s.error
    const run = s.serial.then(async () => {
      if (s.failedKey === key) throw s.error
      try { collect(s); await commit(s, cfg) }
      catch (err) {
        s.error = err; s.failedKey = key
        console.warn('[dsh-token-optimizer] original-text archive failed; check /token-status, then retry, change the directory, or explicitly turn archiving off. Error code: ' + (err.code ?? err.name))
        throw err
      }
    })
    s.serial = run.catch(() => {})
    return run
  }
  async function ensure(session, { signal, wait = false } = {}) {
    const s = state(session)
    while (true) {
      abort(signal)
      if (closed) throw new Error('the archive plugin was unloaded; resubmit the pending request')
      const cfg = read()
      if (!cfg.enabled) return
      try {
        await once(s, cfg)
        abort(signal)
        // If the path or switch changed while waiting, confirm once more against the new settings.
        if (!read().enabled || (!s.pending.size && keyOf(s, cfg) === keyOf(s, read()))) return
      } catch (err) {
        if (!wait || signal?.aborted || closed) throw err
        // Do not retry a broken directory back-to-back; write again only when the retry count, path, or switch changes.
        await waitTick(signal)
      }
    }
  }
  function background(session) {
    if (closed || !read().enabled) return
    const s = state(session)
    // Schedule at most one background task per round; later requests must still wait explicitly.
    if (s.scheduled) return
    s.scheduled = true
    queueMicrotask(() => {
      s.scheduled = false
      if (!closed) ensure(session).catch(() => {})
    })
  }
  function restore(entry) {
    const { agent, waiting } = entry
    const messages = [...waiting.values()]
    for (const m of messages.reverse()) {
      if (!agent.inbox.locate(m.id)) agent.inbox.prepend('next-step', m)
      waiting.delete(m.id)
    }
  }
  async function preStep(payload, next) {
    const { agent, messages = [], signal } = payload
    if (!agent?.session) return next()
    mount(agent)
    const entry = agents.get(agent.id)
    if (!read().enabled) return next()
    const s = state(agent.session)
    for (const message of messages) { input(s, message, 'pre-step'); entry.waiting.set(message.id, copy(message)) }
    try {
      await ensure(agent.session, { signal, wait: true })
      abort(signal)
      const result = await next()
      if (result?.kind === 'reject') restore(entry)
      return result
    } catch (error) { restore(entry); throw error }
  }
  function onEvent(session, event) {
    const entry = [...agents.values()].find(e => e.agent.session === session)
    if (event.type === 'user/message') entry?.waiting.delete(event.data?.id)
    if (event.type === 'turn/end' && entry?.waiting.size) restore(entry)
    background(session)
  }
  function stream(payload) {
    if (!read().enabled || !payload.agent?.session) return
    mount(payload.agent)
    const s = state(payload.agent.session), entry = agents.get(payload.agent.id)
    const frame = payload.frame
    add(s, { kind: 'assistant-stream', key: 'stream:' + entry.life + ':' + frame.attemptId + ':' + frame.revision,
      lifecycle: entry.life, frame })
    background(payload.agent.session)
  }
  function request(options, next) {
    // With archiving off, do not touch host session services and do not interfere with normal requests.
    if (!read().enabled || options.sessionId === undefined) return next()
    if (!sessionStore?.get) throw new Error('the archive session service is not ready; the model request was not released')
    const session = sessionStore.get(options.sessionId)
    if (!session) return next()
    return (async function* () {
      if (read().enabled && options.purpose === 'compaction') add(state(session), {
        kind: 'checkpoint', key: 'checkpoint:' + randomUUID(), phase: 'before-summary-request',
        observedEventSeq: session.seq - 1, coverage: state(session).coverage,
      })
      await ensure(session, { signal: options.signal, wait: true })
      yield* next()
    })()
  }
  async function readRecord(meta) {
    const handle = await io.open(meta.file, 'r')
    try {
      const buffer = Buffer.alloc(meta.bytes)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, meta.offset + offset)
        if (!bytesRead) throw new Error('archive record is incomplete; truncated originals are not returned')
        offset += bytesRead
      }
      return JSON.parse(buffer.toString('utf8'))
    } finally { await handle.close() }
  }
  async function query(session, args = {}) {
    const s = state(session), cfg = read()
    if (cfg.directory) s.roots.add(resolve(cfg.directory))
    for (const dir of cfg.previousDirectories) s.roots.add(resolve(dir))
    await s.serial
    for (const dir of s.roots) await loadRoot(s, dir)
    if (args.action === 'status') return status(session)
    if (args.action === 'read') {
      const meta = s.index.find(m => m.key === args.key)
      if (!meta) throw new Error('this key was not found in the current session; search first to obtain a key')
      if (meta.bytes > 16 * 1024 * 1024) throw new Error('a single record exceeds 16MiB; read it from the local archive JSONL: ' + meta.file)
      const record = await readRecord(meta)
      const value = textOf(record), chars = Array.from(value)
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0)), limit = Math.min(4000, Math.max(1, Math.floor(Number(args.limit) || 2000)))
      return { key: meta.key, role: meta.role, time: meta.time, seq: meta.seq, text: chars.slice(offset, offset + limit).join(''),
        nextOffset: offset + limit < chars.length ? offset + limit : null, totalCharacters: chars.length }
    }
    const needle = String(args.query ?? '').slice(0, 200).toLocaleLowerCase()
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0)), limit = Math.min(20, Math.max(1, Math.floor(Number(args.limit) || 10)))
    const records = [], omitted = []
    let cursor = offset, scanned = 0
    // Bounded full-text scan: each page reads at most 2MiB (records up to 16MiB); continue with nextOffset; never inject the whole pool into the model.
    for (; cursor < s.index.length && cursor - offset < 2000 && records.length < limit && scanned < 2 * 1024 * 1024; cursor++) {
      const meta = s.index[cursor]
      if (args.role ? meta.role !== args.role : ['assistant-stream', 'checkpoint'].includes(meta.role)) continue
      let text = meta.excerpt
      if (needle && meta.bytes <= 16 * 1024 * 1024) {
        scanned += meta.bytes; text = textOf(await readRecord(meta))
      } else if (needle) omitted.push(meta.key)
      const found = needle ? text.toLocaleLowerCase().indexOf(needle) : 0
      if (found >= 0) records.push({ key: meta.key, seq: meta.seq, role: meta.role, time: meta.time,
        excerpt: text.slice(Math.max(0, found - 40), Math.max(0, found - 40) + 180) })
    }
    return { scope: 'current session; by default searches raw inputs/accepted inputs/final model outputs; role can be set to assistant-stream to search stream fragments', records,
      nextOffset: cursor < s.index.length ? cursor : null, oversizedRecordsNotSearched: omitted, coverage: s.coverage }

  }
  function status(session) {
    const cfg = read(), s = session ? states.get(session.id) : null
    return { enabled: cfg.enabled, directory: cfg.directory, previousDirectories: cfg.previousDirectories,
      state: !cfg.enabled ? 'off (content not yet written successfully stays in this process\u2019s memory)' : s?.error ? 'disk write failed; related requests are paused; recovers after retry/path change/turning it off' : s?.pending.size ? 'awaiting durable confirmation' : s?.durable >= 0 ? 'disk write confirmed' : 'awaiting session check',
      durableEventSeq: s?.durable ?? -1, pending: s?.pending.size ?? 0, records: s?.index.length ?? 0,
      error: s?.error ? { code: s.error.code ?? s.error.name, message: 'archive incomplete; not released as saved' } : null,
      lookupAvailable: !!s?.tools.size, coverage: s?.coverage ?? 'On enable, backfills events the host still retains; stream fragments lost while off cannot be backfilled.' }
  }
  function mount(agent) {
    if (!agent?.session || closed) return
    let entry = agents.get(agent.id)
    if (!entry) { entry = { agent, waiting: new Map(), life: randomUUID(), dispose: null }; agents.set(agent.id, entry) }
    if (!read().enabled || entry.dispose || !defineTool || !agent.ctx?.tools?.register) return
    try {
      const tool = defineTool({
        name: 'conversation_archive',
        description: 'Find the user originals and model outputs of this conversation before compaction. search: bounded full-text search (lists when query is omitted); if nextOffset is present, continue with the next page; read: read a record by key with paging, offset/limit count Unicode characters; status: inspect the archive. Search first, then read on demand; never inject the whole pool.',
        parameters: { action: { type: 'string', enum: ['search', 'read', 'status'] }, query: { type: 'string' },
          key: { type: 'string' }, role: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        isConcurrencySafe: () => true,
        execute: async args => JSON.stringify(await query(agent.session, args)),
      })
      entry.dispose = agent.ctx.tools.register(tool)
      state(agent.session).tools.add(agent.id)
    } catch (err) { console.warn('[dsh-token-optimizer] archive lookup tool registration failed: ' + (err.code ?? err.name)) }
  }
  function on(name, fn, options) { ctx.on(name, fn, options); listeners.push([name, fn]) }
  on('agent/pre-step', preStep, { prepend: true })
  on('llm/stream', request, { prepend: true })
  on('session/flush', session => ensure(session))
  on('session/event', onEvent)
  on('agent/assistant-stream', stream)
  on('agent/created', p => mount(p.agent))
  on('agent/disposed', p => {
    const e = agents.get(p.agent?.id)
    if (e) { restore(e); e.dispose?.(); state(e.agent.session).tools.delete(e.agent.id); agents.delete(e.agent.id) }
  })
  const sessionRegistration = ctx.inject?.(['sessions'], svc => {
    if (closed) return
    const store = svc.sessions
    sessionStore = store
    svc.effect?.(() => () => { if (sessionStore === store) sessionStore = null })
  })
  if (typeof sessionRegistration === 'function') disposers.push(sessionRegistration)
  else if (sessionRegistration?.dispose) disposers.push(() => sessionRegistration.dispose())
  const registration = ctx.inject?.(['commands'], svc => {
    disposers.push(svc.commands.register({ name: 'token-archive-retry', description: 'Retry the original-text archive for the current session (without resending input)',
      async handler(invocation) {
        const session = invocation?.agent?.session
        if (!session) return { kind: 'error', text: 'run this inside a session' }
        state(session).retry++
        try { await ensure(session); return { kind: 'success', text: read().enabled ? 'Archive check passed; waiting inputs can continue.' : 'Archiving is off.' } }
        catch (e) { return { kind: 'error', text: 'Archive still failing: ' + (e.code ?? e.name) + '; change the directory or turn it off explicitly.' } }
      },
    }))
  })
  if (typeof registration === 'function') disposers.push(registration)
  return { ensure, query, status,
    async dispose() {
      if (closed) return
      closed = true
      sessionStore = null
      for (const [name, fn] of listeners) ctx.off?.(name, fn)
      for (const e of agents.values()) { restore(e); e.dispose?.() }
      for (const d of disposers) await d?.()
      await Promise.all([...states.values()].map(s => s.serial))
    },
  }
}

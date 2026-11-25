// core logic unittest(node --test).
// call the modules' internal compression/fingerprint functions directly,no DSH runtime dependency.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'
import { createStats } from '../src/stats.js'
import { createOutputLadderModule } from '../src/modules/outputLadder.js'
import { createCacheModule } from '../src/modules/cache.js'

//  content may be string or [{type:'text',text}] array,extract text uniformly before assertions text
function txt(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
  }
  return ''
}

// ---- minimal mock DSH ctx: on/off recording + event dispatch only ----
function makeFakeCtx() {
  const handlers = new Map()
  return {
    on(event, handler) {
      handlers.set(event, handler)
    },
    off(event, handler) {
      if (handlers.get(event) === handler) handlers.delete(event)
    },
    async emit(event, ...args) {
      const h = handlers.get(event)
      if (!h) throw new Error(`no handler for ${event}`)
      return h(...args)
    },
  }
}

test('resolveConfig defaults and validation', () => {
  const cfg = resolveConfig({})
  assert.equal(cfg.outputLadder.structureThreshold, 10000)
  assert.equal(cfg.cache.ttl, 3600)
  assert.equal(cfg.compactionDriver.pressureRatio, 0.45)
  assert.throws(() => resolveConfig({ outputLadder: { bogus: 1 } }), /unknown key/)
  assert.throws(() => resolveConfig({ outputLadder: { structureThreshold: -5 } }), /must be a number/)
  // v1 retired sections silently ignored without throwing(prevents taking down the plugin tree)
  assert.doesNotThrow(() => resolveConfig({ compress: { threshold: 1 }, dedup: {}, pruning: {}, sample: {} }))
})

test('outputLadder: large JSON arrays are sample-compressed,small outputs untouched', async () => {
  const ctx = makeFakeCtx()
  const stats = createStats()
  createOutputLadderModule(ctx, resolveConfig({}).outputLadder, stats)

  // build 500  lines JSON array
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item-${i}`, value: i * 10 }))
  const bigText = JSON.stringify(rows)

  const result = { isError: false, value: rows, content: [{ type: 'text', text: bigText }] }
  const decision = await ctx.emit('tools/post-execute', { name: 'grep' }, result, async () => ({ kind: 'accept' }))
  assert.equal(decision.kind, 'accept')
  assert.notEqual(decision.content[0].text, bigText)
  assert.match(decision.content[0].text, /json-array-compressed/)
  assert.match(decision.content[0].text, /totalRows.:500/)
  assert.ok(decision.content[0].text.length < bigText.length)
  assert.ok(stats.snapshot().counters['ladder.structured'] >= 1)

  // small outputs are not compressed
  const small = { isError: false, value: [1, 2, 3], content: [{ type: 'text', text: '[1,2,3]' }] }
  const d2 = await ctx.emit('tools/post-execute', { name: 'grep' }, small, async () => ({ kind: 'accept' }))
  assert.equal(d2.kind, 'accept')
  assert.equal(d2.content, undefined)
  assert.equal(small.content[0].text, '[1,2,3]')
})

test('outputLadder: CSV head/tail retention', async () => {
  const ctx = makeFakeCtx()
  const stats = createStats()
  // 100 CSV lines is about 1.2KB, below the default threshold 10000 so it does not trigger; lower the threshold and head/tail retention
  createOutputLadderModule(ctx, { ...resolveConfig({}).outputLadder, structureThreshold: 500, preserveHeadTail: 5 }, stats)
  const csv = ['id,name', ...Array.from({ length: 100 }, (_, i) => `${i},row-${i}`)].join('\n')
  const result = { isError: false, value: csv, content: [{ type: 'text', text: csv }] }
  const decision = await ctx.emit('tools/post-execute', { name: 'grep' }, result, async () => ({ kind: 'accept' }))
  assert.match(decision.content[0].text, / rows omitted/)
  assert.match(decision.content[0].text, /id,name/) // header kept
})

test('cache: paused, unsafe reuse off, repeated calls execute the tool', async () => {
  const ctx = makeFakeCtx()
  const stats = createStats()
  let executions = 0
  createCacheModule(ctx, { ...resolveConfig({}).cache, enabled: true }, stats)

  const exec = { name: 'glob', arguments: { pattern: '**/*.js' } }
  const run = async () => {
    const result = await ctx.emit('tools/execute', exec, async () => {
      executions += 1
      return { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'content' }] }
    })
    return result
  }
  await run()
  await run()
  assert.equal(executions, 2) // read-only searches depend on external file state and re-execute every time
  assert.equal(stats.snapshot().counters['cache.hits'] ?? 0, 0)
})

// single-process smoke verification(replaces node --test,avoids sandbox spawn EPERM).
// usage: node test/smoke.mjs

import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { createStats } from '../src/stats.js'
import { createText2imgModule, splitChunks } from '../src/modules/text2img.js'
import { createCacheModule } from '../src/modules/cache.js'
import { createMonitorModule } from '../src/modules/monitor.js'
import { createFileDiffModule } from '../src/modules/fileDiff.js'
import { createToolTrimModule } from '../src/modules/toolTrim.js'
import { createOutputLadderModule } from '../src/modules/outputLadder.js'
import { createCompactionDriverModule, computePressure } from '../src/modules/compactionDriver.js'
import { createLayeredCompactModule } from '../src/modules/layeredCompact.js'
import { registerTokenStatusCommand } from '../src/commands/tokenStatus.js'
import { runCompressionChecks } from './compression.mjs'

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}`)
  }
}

function makeFakeCtx() {
  // waterfall composition semantics(0A §D2 measured):the outermost return valueis the only effective one;
  // among prepends, later registrations are more outer;among defaults, earlier registrations are more outer
  const handlers = new Map() // event -> [{fn}] in execution order (outermost first)
  return {
    on(event, handler, opts) {
      const arr = handlers.get(event) ?? []
      if (opts && opts.prepend) arr.unshift({ fn: handler })
      else arr.push({ fn: handler })
      handlers.set(event, arr)
      return () => this.off(event, handler)
    },
    off(event, handler) {
      const arr = handlers.get(event)
      if (!arr) return
      const i = arr.findIndex((h) => h.fn === handler)
      if (i >= 0) arr.splice(i, 1)
    },
    async emit(event, ...args) {
      const arr = handlers.get(event)
      if (!arr || arr.length === 0) throw new Error(`no handler for ${event}`)
      // the test passes"terminate next"as the last parameter(the kernel's call shape)→ it is the chain's end
      const terminal = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
      const baseArgs = terminal ? args.slice(0, -1) : args
      const run = async (i, a) => {
        if (i >= arr.length) return terminal ? terminal(...a) : undefined
        return arr[i].fn(...a, (...na) => run(i + 1, na.length ? na : a))
      }
      return run(0, baseArgs)
    },
  }
}

// after module replacement content may be string or [{type:'text',text}] array(OpenAI-style blocks),
// extract text uniformly before assertions text,compatible with both shapes
function txt(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
  }
  return ''
}

console.log('== config ==')
{
  const cfg = resolveConfig({})
  check('default structureThreshold 10000', cfg.outputLadder.structureThreshold === 10000)
  check('default ttl 3600', cfg.cache.ttl === 3600)
  check('default pressureRatio 0.45', cfg.compactionDriver.pressureRatio === 0.45)
  // v2.1 new defaults
  check('v2.1 default text2img.threshold 1000', cfg.text2img.threshold === 1000)
  check('v2.1 default askTimeoutMs 120000', cfg.text2img.askTimeoutMs === 120000)
  check('v2.1 default dynamicResolution true', cfg.text2img.dynamicResolution === true)
  check('v2.1 default summaryCache true', cfg.text2img.summaryCache === true)
  check('v2.1 default3 tiers by default', cfg.text2img.resolutionTiers.length === 3 && cfg.text2img.resolutionTiers[2].maxChars === Infinity)
  check('v2.1 pagesPerBatch default 4', cfg.text2img.pagesPerBatch === 4)
  check('memory_bridge placeholder section enabled=false', cfg.memory_bridge.enabled === false)
  check('memory_bridge sync_dir default', cfg.memory_bridge.sync_dir === '~/.dsh-memory')
  let threw = false
  try { resolveConfig({ outputLadder: { bogus: 1 } }) } catch { threw = true }
  check('unknown key errors', threw)
  threw = false
  try { resolveConfig({ outputLadder: { structureThreshold: -5 } }) } catch { threw = true }
  check('negative errors', threw)
  threw = false
  try { resolveConfig({ text2img: { resolutionTiers: [{ maxChars: 500, width: 640, height: 360, fontSize: 24 }, { maxChars: 300, width: 1280, height: 720, fontSize: 24 }] } }) } catch { threw = true }
  check('tier maxChars not increasing errors', threw)
  threw = false
  try { resolveConfig({ text2img: { resolutionTiers: [{ maxChars: 2000, width: 9000, height: 360, fontSize: 24 }] } }) } catch { threw = true }
  check('tier exceeds vision API long-side limit errors', threw)
  // v1 retired sections silently ignored without throwing
  let legacyThrew = false
  try { resolveConfig({ compress: { threshold: 1 }, pruning: {}, dedup: {}, sample: {} }) } catch { legacyThrew = true }
  check('retired sections silently ignored without throwing', !legacyThrew)
}

console.log('== text2img full flow(askOnSkip=false automatic path,mock render+summary) ==')
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  // mock: render returns a fake path, summarize returns a fixed text
  const deps = {
    renderToPng: async (text) => '/tmp/fake.png',
    summarizeImage: async (png, cfg) => `[summary] total ${Math.floor(png.length)} byte image, contentsummary:This is a test text brief summary.`,
  }
  createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: false, summaryCache: false }, stats, deps)
  const longText = 'This is ' + 'a very long natural language text content,for testsummaryreplacement.'.repeat(10)
  const nextLong = async () => ({ kind: 'enter', messages: [{ role: 'user', content: longText }] })
  const dLong = await ctx.emit('agent/pre-step', { signal: {} }, nextLong)
  check('long natural-language text triggers text2img', /text2img/.test(txt(dLong.messages[0].content)))
  check('text2img content includes the summary', /\[summary\]/.test(txt(dLong.messages[0].content)))
  check('text2img replacement is shorter', txt(dLong.messages[0].content).length < longText.length)
  check('text2img summary marker includes the verification guard', /read the original file to verify/.test(txt(dLong.messages[0].content)))
  check('text2img.messages=1', stats.snapshot().counters['text2img.messages'] === 1)
  check('text2img.savedChars>0', stats.snapshot().counters['text2img.savedChars'] > 0)
  // JSON does not trigger( content-type detection)
  const json = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: i })))
  const nextJson = async () => ({ kind: 'enter', messages: [{ content: json }] })
  const dJson = await ctx.emit('agent/pre-step', { signal: {} }, nextJson)
  check('JSON does not trigger text2img', dJson.messages[0].content === json)
  // short textdoes not trigger
  const nextShort = async () => ({ kind: 'enter', messages: [{ content: 'hi there' }] })
  const dShort = await ctx.emit('agent/pre-step', { signal: {} }, nextShort)
  check('short textdoes not trigger text2img', dShort.messages[0].content === 'hi there')

  // render failures keep the original
  const ctx2 = makeFakeCtx()
  const stats2 = createStats()
  const depsFail = {
    renderToPng: async () => { throw new Error('render boom') },
    summarizeImage: async () => 'x',
  }
  createText2imgModule(ctx2, { ...resolveConfig({}).text2img, threshold: 100, askOnSkip: false, summaryCache: false }, stats2, depsFail)
  const nextFail = async () => ({ kind: 'enter', messages: [{ role: 'user', content: longText }] })
  const dFail = await ctx2.emit('agent/pre-step', { signal: {} }, nextFail)
  check('render failure keeps the original', dFail.messages[0].content === longText)
  check('text2img.failures=1', stats2.snapshot().counters['text2img.failures'] === 1)
}

console.log('== text2img v2.1 summarycap scales with input ==')
{
  const ctx = makeFakeCtx()
  let capSeen = 0
  const deps = {
    renderToPng: async () => '/tmp/fake.png',
    // simulate the real summarizeImage:truncating to the passed maxSummaryChars
    summarizeImage: async (png, cfg) => { capSeen = cfg.maxSummaryChars; return 'long'.repeat(1500).slice(0, cfg.maxSummaryChars) },
  }
  createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: false, summaryCache: false }, createStats(), deps)
  const text800 = 'This is a ' + 'for verifyingsummarycap scaling natural-language long text.'.repeat(20) // ~600-800 chars
  const d = await ctx.emit('agent/pre-step', { signal: {} }, async () => ({ kind: 'enter', messages: [{ content: text800 }] }))
  const expectedCap = Math.min(2000, Math.max(200, Math.round(text800.length * 0.4)))
  check('v2.1 summarycapscales with input(0.4 ratio)', capSeen === expectedCap && capSeen < 2000)
  check('v2.1 the scaled replacement is always shorter', txt(d.messages[0].content).length < text800.length)
  check('v2.1 the scaled summary stays under the cap', /text2img/.test(txt(d.messages[0].content)))
}

console.log('== text2img batched summary chunks ==')
{
  const c9 = splitChunks(Array.from({ length: 9 }, (_, i) => `p${i}`), 4)
  check('splitChunks 9 pages/batch 4 → [4,4,1]', c9.length === 3 && c9[0].length === 4 && c9[1].length === 4 && c9[2].length === 1)
  const c5 = splitChunks([1, 2, 3, 4, 5], 4)
  check('splitChunks 5 pages/batch 4 → [4,1]', c5.length === 2 && c5[1].length === 1)
}

// multi-page render: the renderer returns a path array; all pages should go to summarization
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  const deps = {
    renderToPng: async () => ['/tmp/fake-p1.png', '/tmp/fake-p2.png'],
    summarizeImage: async (pngs) => `[summary] total ${pngs.length} page images`,
  }
  createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: false, summaryCache: false }, stats, deps)
  const multiText = 'multi-page test' + 'This is a for multi-page render test long text content.'.repeat(20)
  const nextMulti = async () => ({ kind: 'enter', messages: [{ role: 'user', content: multiText }] })
  const dMulti = await ctx.emit('agent/pre-step', { signal: {} }, nextMulti)
  check('multi-page render triggers text2img', /text2img/.test(txt(dMulti.messages[0].content)))
  check('multi-page summary includes page count', /total 2 page images/.test(txt(dMulti.messages[0].content)))
  check('multi-page stats counter', stats.snapshot().counters['text2img.messages'] === 1)
}

console.log('== text2img structural filter(askOnSkip=false automatic path) ==')
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  const deps = {
    renderToPng: async () => '/tmp/fake.png',
    summarizeImage: async () => '[summary] testsummary.',
  }
  createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: false, summaryCache: false }, stats, deps)
  // 1) >=5 pure separator lines + >200 lines → refuses(skip counter + no replacement)
  const sepLines = ['----------------', '================', '+----+----+', '----------------', '**********', ...Array.from({ length: 250 }, (_, i) => `This is part ${i}  lines of real text content, for testing the structural filter.`)].join('\n')
  const dSep = await ctx.emit('agent/pre-step', { signal: {} }, async () => ({ kind: 'enter', messages: [{ content: sepLines }] }))
  check('text2img structural text rejected', dSep.messages[0].content === sepLines)
  check('text2img.skipped counter', stats.snapshot().counters['text2img.skipped'] >= 1)
  // 2) only 1 separator line long text -> passes (v1 misfires on it)
  const oneSep = ['---', ...Array.from({ length: 205 }, (_, i) => `paragraph ${i}:This is pure natural-language body content,for verifyinga single separator does not misfire.`)].join('\n')
  const dOne = await ctx.emit('agent/pre-step', { signal: {} }, async () => ({ kind: 'enter', messages: [{ content: oneSep }] }))
  check('text2img single-separator long text triggers', /text2img/.test(txt(dOne.messages[0].content)))
}

console.log('== text2img v2.1 asks at the threshold(askOnSkip=true main path) ==')
{
  const mkCtxWithAsk = (askImpl) => {
    const ctx = makeFakeCtx()
    ctx.inject = (keys, cb) => {
      const sctx = {}
      if (keys.includes('userQuestions')) sctx.userQuestions = { ask: askImpl }
      cb(sctx)
    }
    return ctx
  }
  const mkDeps = () => ({
    renderToPng: async () => '/tmp/fake.png',
    summarizeImage: async () => '[summary] ask flowtestsummary.',
  })
  const nlText = 'This is a ' + 'for ask mechanismtest natural-language long text content.'.repeat(15)
  const structural = ['----------------', '================', '+----+----+', '----------------', '**********', ...Array.from({ length: 250 }, (_, i) => `This is part ${i}  lines of real text content, for testing the structural filter.`)].join('\n')
  const enterWith = (text) => async () => ({ kind: 'enter', messages: [{ content: text }] })
  const markRunning = (ctx) => ctx.emit('agent/status', { agent: { id: 'root1' }, status: 'running' })
  const base = { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, summaryCache: false }

  // 1) natural languagereaches the threshold -> asks; the recommendation (convert) is first;ask the request must carry agent(web provider required)
  {
    let askCount = 0
    let askGotAgent = false
    let firstLabel = ''
    let questionText = ''
    const ctx = mkCtxWithAsk(async (req) => {
      askCount += 1
      askGotAgent = !!req?.agent
      firstLabel = req.questions[0].options[0].label
      questionText = req.questions[0].question
      return { answers: [{ id: 'text2img_path', selected: ['Convert to image summary (recommended)'] }] }
    })
    const stats = createStats()
    createText2imgModule(ctx, { ...base, askOnSkip: true }, stats, mkDeps())
    await markRunning(ctx)
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 natural language asks first at the threshold', askCount === 1 && askGotAgent)
    check('v2.1 natural language recommendation (convert) is first', /Convert to image summary/.test(firstLabel))
    check('v2.1 popup includes the economics estimate', /token/.test(questionText) && /image page\(s\)/.test(questionText) && /summary of at most/.test(questionText))
    check('v2.1 choosing convert -> summary replacement', /text2img/.test(txt(d.messages[0].content)))
    check('v2.1 asked counter', stats.snapshot().counters['text2img.asked'] === 1)
  }
  // 2) natural language chooses"Read the original as-is" → original kept
  {
    let askCount = 0
    const ctx = mkCtxWithAsk(async () => { askCount += 1; return { answers: [{ id: 'text2img_path', selected: ['Read the original as-is'] }] } })
    const stats = createStats()
    createText2imgModule(ctx, { ...base, askOnSkip: true }, stats, mkDeps())
    await markRunning(ctx)
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 choosing read-original -> original kept', d.messages[0].content === nlText)
    check('v2.1 read-original skipped counter', stats.snapshot().counters['text2img.skipped'] === 1)
  }
  // 3) strongly structural -> the recommendation (read original) is first; choosing convert -> forced counter
  {
    let firstLabel = ''
    const ctx = mkCtxWithAsk(async (req) => {
      firstLabel = req.questions[0].options[0].label
      return { answers: [{ id: 'text2img_path', selected: ['Convert to image summary'] }] }
    })
    const stats = createStats()
    createText2imgModule(ctx, { ...base, askOnSkip: true }, stats, mkDeps())
    await markRunning(ctx)
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(structural))
    check('v2.1 structural recommendation (read original) is first', /Read the original as-is/.test(firstLabel))
    check('v2.1 structural choosing convert -> converts', /text2img/.test(txt(d.messages[0].content)))
    check('v2.1 forced counter', stats.snapshot().counters['text2img.forced'] === 1)
  }
  // 4) ask timeout → by contenttype default (natural language converts / structural reads the original)
  {
    const mkTimeoutAsk = () => async (req) => new Promise((_, reject) => {
      req.signal.addEventListener('abort', () => reject(new Error('ASK_ABORTED')))
    })
    {
      const ctx = mkCtxWithAsk(mkTimeoutAsk())
      createText2imgModule(ctx, { ...base, askOnSkip: true, askTimeoutMs: 60 }, createStats(), mkDeps())
      await markRunning(ctx)
      const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
      check('v2.1 timeout default: natural language -> convert', /text2img/.test(txt(d.messages[0].content)))
    }
    {
      const ctx = mkCtxWithAsk(mkTimeoutAsk())
      createText2imgModule(ctx, { ...base, askOnSkip: true, askTimeoutMs: 60 }, createStats(), mkDeps())
      await markRunning(ctx)
      const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(structural))
      check('v2.1 timeout default: structural -> read original', d.messages[0].content === structural)
    }
  }
  // 5) ask throws (NO_PROVIDER etc.)→ natural languagealso degrades to reading the original(fail-safe,no more automatic conversion)
  {
    const ctx = mkCtxWithAsk(async () => { throw new Error('NO_PROVIDER') })
    const stats = createStats()
    createText2imgModule(ctx, { ...base, askOnSkip: true }, stats, mkDeps())
    await markRunning(ctx)
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 ask on throw natural language degrades to reading the original', d.messages[0].content === nlText)
  }
  // 6) no running event (cannot get the current agent)→ reads the original without asking
  {
    let askCount = 0
    const ctx = mkCtxWithAsk(async () => { askCount += 1; return { answers: [] } })
    createText2imgModule(ctx, { ...base, askOnSkip: true }, createStats(), mkDeps())
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 with no current agent it reads the original without asking', d.messages[0].content === nlText && askCount === 0)
  }
  // 7) no userQuestions service (fake ctx without inject)→ reads the original without crashing
  {
    const ctx = makeFakeCtx()
    createText2imgModule(ctx, { ...base, askOnSkip: true }, createStats(), mkDeps())
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 with no provider it reads the original without crashing', d.messages[0].content === nlText)
  }
  // 8) askOnSkip=false → no asking; natural language converts automatically(v2.0 behavior)
  {
    let askCount = 0
    const ctx = mkCtxWithAsk(async () => { askCount += 1; return { answers: [] } })
    createText2imgModule(ctx, { ...base, askOnSkip: false }, createStats(), mkDeps())
    await markRunning(ctx)
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 askOnSkip=false automatic conversion without asking', /text2img/.test(txt(d.messages[0].content)) && askCount === 0)
  }
  // 9) the same text reappears → fingerprint dedup reuses the last choice and does not ask again
  {
    let askCount = 0
    const ctx = mkCtxWithAsk(async () => { askCount += 1; return { answers: [{ id: 'text2img_path', selected: ['Convert to image summary (recommended)'] }] } })
    createText2imgModule(ctx, { ...base, askOnSkip: true }, createStats(), mkDeps())
    await markRunning(ctx)
    const d1 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    const d2 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 the same text is not asked about twice', askCount === 1)
    check('v2.1 a repeated text reuses the last choice (convert)', /text2img/.test(txt(d2.messages[0].content)) && /text2img/.test(txt(d1.messages[0].content)))
  }
  // 10) maxAsksPerSession popup quota: first asks; later different texts follow the content-type default silently
  {
    let askCount = 0
    const ctx = mkCtxWithAsk(async () => { askCount += 1; return { answers: [{ id: 'text2img_path', selected: ['Read the original as-is'] }] } })
    createText2imgModule(ctx, { ...base, askOnSkip: true, maxAsksPerSession: 1 }, createStats(), mkDeps())
    await markRunning(ctx)
    const d1 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    const other = 'another ' + 'completely different natural language text contentfor popup quotatest.'.repeat(15)
    const d2 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(other))
    check('v2.1 popup quota:firstask,latersilentlydefault(natural language→convert)', askCount === 1 && d1.messages[0].content === nlText && /text2img/.test(txt(d2.messages[0].content)))
  }
  // 11) runtime context snapshot(source.kind='plugin')is not processed(stray-trigger incident regression:
  //     short instruction + 2,864-character runtime-context snapshot -> the popup pointed at the snapshot)
  {
    let askCount = 0
    const ctx = mkCtxWithAsk(async () => { askCount += 1; return { answers: [{ id: 'text2img_path', selected: ['Convert to image summary (recommended)'] }] } })
    createText2imgModule(ctx, { ...base, askOnSkip: true }, createStats(), mkDeps())
    await markRunning(ctx)
    const runtime = {
      role: 'user',
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
      content: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'.repeat(60),
    }
    const userMsg = { role: 'user', source: { kind: 'user', rpcId: 'x' }, content: nlText }
    const d = await ctx.emit('agent/pre-step', { signal: {} }, async () => ({ kind: 'enter', messages: [runtime, userMsg] }))
    check('v2.1 the runtime context snapshot passes through unchanged', d.messages[0].content === runtime.content)
    check('v2.1 the snapshot does not trigger the popup (only user messages pop once)', askCount === 1 && /text2img/.test(txt(d.messages[1].content)))
  }
}

console.log('== text2img v2.1 summary disk cache (0 API across sessions) ==')
{
  const cacheDir = mkdtempSync(join(tmpdir(), 't2i-cache-'))
  const nlText = 'cachetest' + 'This is a for summarydiskcachetest natural-language long text content.'.repeat(15)
  const enterWith = (text) => async () => ({ kind: 'enter', messages: [{ content: text }] })
  const base = { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: false }

  // 1) first conversion: render+summarize; second conversion: cache hit, the renderer is not called again
  {
    let renderCalls = 0
    const deps = {
      renderToPng: async () => { renderCalls += 1; return '/tmp/fake.png' },
      summarizeImage: async () => '[summary] diskcachetestsummary.',
    }
    const ctx = makeFakeCtx()
    const stats = createStats()
    createText2imgModule(ctx, { ...base, summaryCache: true }, stats, { ...deps, cacheDir })
    const d1 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    const d2 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 cache first conversion renders once', renderCalls === 1)
    check('v2.1 cache second hit does not re-render', renderCalls === 1 && /text2img/.test(txt(d2.messages[0].content)))
    check('v2.1 cache-hit counter', stats.snapshot().counters['text2img.cacheHits'] === 1)
    check('v2.1 cache-hit marker', /summary served from disk cache/.test(txt(d2.messages[0].content)))
    check('v2.1 the first conversion marker has no cache wording', !/summary served from disk cache/.test(txt(d1.messages[0].content)))
  }
  // 2) across sessions (new module instance, same cacheDir) -> cache hit, 0 render 0 summary
  {
    let renderCalls = 0
    let summarizeCalls = 0
    const deps = {
      renderToPng: async () => { renderCalls += 1; return '/tmp/fake.png' },
      summarizeImage: async () => { summarizeCalls += 1; return '[summary] should not be called.' },
    }
    const ctx = makeFakeCtx()
    createText2imgModule(ctx, { ...base, summaryCache: true }, createStats(), { ...deps, cacheDir })
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 cross-session cache hit costs 0 render 0 API', renderCalls === 0 && summarizeCalls === 0)
    check('v2.1 cross-session summary reuse', /diskcachetestsummary/.test(txt(d.messages[0].content)))
  }
  // 3) different content -> misses, renders normally
  {
    let renderCalls = 0
    const deps = {
      renderToPng: async () => { renderCalls += 1; return '/tmp/fake.png' },
      summarizeImage: async () => '[summary] new contentsummary.',
    }
    const ctx = makeFakeCtx()
    createText2imgModule(ctx, { ...base, summaryCache: true }, createStats(), { ...deps, cacheDir })
    await ctx.emit('agent/pre-step', { signal: {} }, enterWith('completely different' + ' another natural language text contentfor cacheunknownhittest.'.repeat(15)))
    check('v2.1 different content misses and renders normally', renderCalls === 1)
  }
  // 4) original-save dedup: DSH resends the same message each step; a cache hit reuses the first original path (incident: 7 appearances produced 7 duplicate files)
  {
    const origDir = mkdtempSync(join(tmpdir(), 't2i-orig-'))
    const textDup = 'original dedup' + 'This is a for original-save deduptest natural-language long text content.'.repeat(15)
    const depsD = {
      renderToPng: async () => '/tmp/fake.png',
      summarizeImage: async () => '[summary] original deduptest.',
    }
    const ctx = makeFakeCtx()
    createText2imgModule(ctx, { ...base, summaryCache: true, saveOriginal: true }, createStats(), { ...depsD, cacheDir, originalDir: origDir })
    const d1 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(textDup))
    const d2 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(textDup))
    const files = readdirSync(origDir)
    check('v2.1 a cache hit reuses the first original path', files.length === 1 && txt(d2.messages[0].content).includes(files[0]) && /original full text/.test(txt(d1.messages[0].content)))
  }
  // 5) prompt change → cache invalidated(badsummary cache reuse would make incidents permanent:Zhihu long text incident)
  {
    let renderCalls = 0
    const deps = {
      renderToPng: async () => { renderCalls += 1; return '/tmp/fake.png' },
      summarizeImage: async () => '[summary] new-prompt summary.',
    }
    const ctx = makeFakeCtx()
    // the same text nlText was cached in test 1 with the default prompt; after a prompt change it must go through vision
    createText2imgModule(ctx, { ...base, summaryCache: true, prompt: 'completely different summary prompt' }, createStats(), { ...deps, cacheDir })
    await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 a prompt change invalidates the cache', renderCalls === 1)
  }
}

console.log('== text2img v2.1 dynamic resolution tiers ==')
{
  const base = { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: false, summaryCache: false }
  const enterWith = (text) => async () => ({ kind: 'enter', messages: [{ content: text }] })
  let lastPageConfig = null
  const deps = {
    renderToPng: async (text, pageConfig) => { lastPageConfig = pageConfig; return '/tmp/fake.png' },
    summarizeImage: async () => '[summary] tier test.',
  }
  const ctx = makeFakeCtx()
  createText2imgModule(ctx, base, createStats(), deps)
  await ctx.emit('agent/pre-step', { signal: {} }, enterWith('o'.repeat(1500)))
  check('v2.1 ≤2000 chars → 800×450', lastPageConfig.width === 800 && lastPageConfig.pageMaxHeight === 450 && lastPageConfig.pageFontSize === 24)
  await ctx.emit('agent/pre-step', { signal: {} }, enterWith('o'.repeat(5000)))
  check('v2.1 ≤6000 chars → 1440×810', lastPageConfig.width === 1440 && lastPageConfig.pageMaxHeight === 810 && lastPageConfig.pageFontSize === 24)
  await ctx.emit('agent/pre-step', { signal: {} }, enterWith('o'.repeat(8000)))
  check('v2.1 >6000 chars → 1920×1080@36 pt', lastPageConfig.width === 1920 && lastPageConfig.pageMaxHeight === 1080 && lastPageConfig.pageFontSize === 36)

  // dynamicResolution=false → fixed renderWidth + pagination params
  let lastPageConfig2 = null
  const deps2 = {
    renderToPng: async (text, pageConfig) => { lastPageConfig2 = pageConfig; return '/tmp/fake.png' },
    summarizeImage: async () => '[summary] tier test.',
  }
  const ctx2 = makeFakeCtx()
  createText2imgModule(ctx2, { ...base, dynamicResolution: false, renderWidth: 900 }, createStats(), deps2)
  await ctx2.emit('agent/pre-step', { signal: {} }, enterWith('o'.repeat(8000)))
  check('v2.1 dynamicResolution off uses renderWidth', lastPageConfig2.width === 900 && lastPageConfig2.pageMaxHeight === 3000)
}

console.log('== outputLadder ==')
{
  const cfg = resolveConfig({}).outputLadder
  const ctx = makeFakeCtx()
  const stats = createStats()
  createOutputLadderModule(ctx, cfg, stats)
  const mk = (text, isError = false) => ({ isError, content: [{ type: 'text', text }] })

  // 1) error result -> summary
  const errText = 'Error: boom\n' + 'stack-line-padding-'.repeat(30)
  const dErr = await ctx.emit('tools/post-execute', { name: 'pwsh' }, mk(errText, true), async () => ({ kind: 'accept' }))
  check('outputLadder error summary marker', /error output summarized/.test(txt(dErr.content)))
  check('outputLadder the error summary is shorter', txt(dErr.content).length < errText.length)
  check('outputLadder ladder.errors>=1', stats.snapshot().counters['ladder.errors'] >= 1)

  // 2) JSON array(>10k)→ structural compression
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item-${i}`, value: i * 10 }))
  const bigJson = JSON.stringify(rows)
  const dJson = await ctx.emit('tools/post-execute', { name: 'grep' }, mk(bigJson), async () => ({ kind: 'accept' }))
  check('outputLadder JSON compression marker', /json-array-compressed/.test(txt(dJson.content)))
  check('outputLadder JSON totalRows 500', /totalRows.:500/.test(txt(dJson.content)))
  check('outputLadder JSON takes the structured branch', /outputLadder\.structured/.test(txt(dJson.content)))

  // 3) CSV → structural compression
  const csv = ['id,name', ...Array.from({ length: 2500 }, (_, i) => `${i},row-${i}`)].join('\n')
  const dCsv = await ctx.emit('tools/post-execute', { name: 'grep' }, mk(csv), async () => ({ kind: 'accept' }))
  check('outputLadder CSV omission marker', / rows omitted/.test(txt(dCsv.content)))
  check('outputLadder CSV header kept', /id,name/.test(txt(dCsv.content)))

  // 4) pwsh multi-line output(no comma header, should not be treated as CSV)→ shell sampling
  const shellLines = []
  for (let i = 1; i <= 500; i++) shellLines.push(`line-${i}: some content padding padding padding`)
  const shellText = shellLines.join('\n')
  const dShell = await ctx.emit('tools/post-execute', { name: 'pwsh' }, mk(shellText), async () => ({ kind: 'accept' }))
  check('outputLadder shell sampling marker', /sampled view = head/.test(txt(dShell.content)))
  check('outputLadder shell keep linespt', /1\tline-1/.test(txt(dShell.content)))
  check('outputLadder shell branch marker', /outputLadder\.shell/.test(txt(dShell.content)))

  // 5) read -type tool exemption
  const bigFile = 'file-content-'.repeat(3000)
  const dRead = await ctx.emit('tools/post-execute', { name: 'read' }, mk(bigFile), async () => ({ kind: 'accept' }))
  check('outputLadder read exemption passes through', dRead.content === undefined)

  // 6) >= spillBytes characters but unstructured text -> passed to the core spill
  const huge = 'x'.repeat(55000)
  const dSpill = await ctx.emit('tools/post-execute', { name: 'grep' }, mk(huge), async () => ({ kind: 'accept' }))
  check('outputLadder spill band passes through', dSpill.content === undefined)
  check('outputLadder ladder.spillSkip>=1', stats.snapshot().counters['ladder.spillSkip'] >= 1)

  // 6b) >= spillBytes chars  JSON array → structural compression wins first(nothand to spill,information density is higher)
  const bigRows = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `row-${i}`, payload: 'y'.repeat(40) }))
  const hugeJson = JSON.stringify(bigRows) // ~130k characters
  const dHugeJson = await ctx.emit('tools/post-execute', { name: 'grep' }, mk(hugeJson), async () => ({ kind: 'accept' }))
  check('outputLadder the huge JSON takes the structural branch', /json-array-compressed/.test(txt(dHugeJson.content)))
  check('outputLadder the huge JSON is not spill-skipped', /outputLadder\.structured/.test(txt(dHugeJson.content)))
  check('outputLadder the sample count is capped at 500', /sampledRows.:500/.test(txt(dHugeJson.content)))

  // 7) small outputs / non-accept decisions pass through
  const dSmall = await ctx.emit('tools/post-execute', { name: 'pwsh' }, mk('ok'), async () => ({ kind: 'accept' }))
  check('outputLadder small output passes through', dSmall.content === undefined)
  const dReject = await ctx.emit('tools/post-execute', { name: 'pwsh' }, mk(shellText), async () => ({ kind: 'reject' }))
  check('outputLadder non-accept is untouched', dReject.kind === 'reject')

  // 8) pwsh output is exactly JSON array → the structured branch wins first(decision-table order)
  const dOrder = await ctx.emit('tools/post-execute', { name: 'pwsh' }, mk(bigJson), async () => ({ kind: 'accept' }))
  check('outputLadder pwsh-JSON takes the structured branch', /outputLadder\.structured/.test(txt(dOrder.content)))
}

console.log('== compactionDriver ==')
{
  const tick = () => new Promise((r) => setTimeout(r, 20))
  const cfg = { ...resolveConfig({}).compactionDriver, minTurns: 6, minTokens: 100000, pressureRatio: 0.45, maxCompactionsPerSession: 3, timeoutMs: 1000 }
  const mkAgent = (turns, totalTokens) => {
    const events = []
    for (let i = 0; i < turns; i++) events.push({ type: 'turn/start' })
    events.push({ type: 'request/context', data: { contextWindow: 1000000 } })
    return { id: 'a1', session: { events } }
  }
  const mkServices = (compactNow, measure = () => ({ totalTokens: 500000 })) => ({ compactNow, measure })

  // turn count / pressure insufficient -> does not trigger
  {
    const ctx = makeFakeCtx()
    let calls = 0
    ctx.get = () => mkServices(async () => { calls += 1; return { tokenCount: 1 } }, () => ({ totalTokens: 200000 }))
    const stats = createStats()
    createCompactionDriverModule(ctx, cfg, stats)
    await ctx.emit('agent/status', { agent: mkAgent(2, 200000), status: 'idle' })
    await tick()
    check('compactionDriver insufficient turn count does not trigger', calls === 0)
    await ctx.emit('agent/status', { agent: mkAgent(10, 200000), status: 'idle' })
    await tick()
    check('compactionDriver insufficient pressure does not trigger', calls === 0)
  }
  // trigger satisfied + inFlight dedup
  {
    const ctx = makeFakeCtx()
    let calls = 0
    ctx.get = () => mkServices(async () => { calls += 1; return { tokenCount: 1 } })
    const stats = createStats()
    createCompactionDriverModule(ctx, cfg, stats)
    const agent = mkAgent(10, 500000)
    await ctx.emit('agent/status', { agent, status: 'idle' })
    await ctx.emit('agent/status', { agent, status: 'idle' })
    await tick()
    check('compactionDriver meetsufficienttriggerexactlyoone times', calls === 1)
    check('compactionDriver.completed=1', stats.snapshot().counters['compactionDriver.completed'] === 1)
  }
  // max capped
  {
    const ctx = makeFakeCtx()
    let calls = 0
    ctx.get = () => mkServices(async () => { calls += 1; return { tokenCount: 1 } })
    const stats = createStats()
    createCompactionDriverModule(ctx, cfg, stats)
    const agent = mkAgent(10, 500000)
    for (let i = 0; i < 5; i++) { await ctx.emit('agent/status', { agent, status: 'idle' }); await tick() }
    check('compactionDriver max capped(exactly 3  times)', calls === 3)
  }
  // retries after busy backoff
  {
    const ctx = makeFakeCtx()
    let calls = 0
    ctx.get = () => mkServices(async () => {
      calls += 1
      if (calls === 1) { const e = new Error('busy'); e.code = 'busy'; throw e }
      return { tokenCount: 1 }
    })
    const stats = createStats()
    createCompactionDriverModule(ctx, cfg, stats)
    const agent = mkAgent(10, 500000)
    await ctx.emit('agent/status', { agent, status: 'idle' })
    await tick()
    await ctx.emit('agent/status', { agent, status: 'idle' })
    await tick()
    const c = stats.snapshot().counters
    check('compactionDriver retries after busy backoffsuccess', calls === 2 && c['compactionDriver.skippedBusy'] === 1 && c['compactionDriver.completed'] === 1)
  }
  // compactNow returns null(without a usable region)counts but does not crash
  {
    const ctx = makeFakeCtx()
    let calls = 0
    ctx.get = () => mkServices(async () => { calls += 1; return null })
    const stats = createStats()
    createCompactionDriverModule(ctx, cfg, stats)
    const agent = mkAgent(10, 500000)
    await ctx.emit('agent/status', { agent, status: 'idle' })
    await tick()
    check('compactionDriver null does not count as success and does not crash', calls === 1 && stats.snapshot().counters['compactionDriver.completed'] === undefined)
  }
  // without the service: does not trigger and does not throw (lazy acquisition, retried every idle, warned only once)
  {
    const ctx = makeFakeCtx()
    let calls = 0
    ctx.get = () => undefined
    createCompactionDriverModule(ctx, cfg, createStats())
    await ctx.emit('agent/status', { agent: mkAgent(10, 500000), status: 'idle' })
    await tick()
    check('compactionDriver without the service it does not trigger and does not throw', calls === 0)
  }
  // empty payload / running state does not throw
  {
    const ctx = makeFakeCtx()
    let calls = 0
    ctx.get = () => mkServices(async () => { calls += 1; return { tokenCount: 1 } })
    createCompactionDriverModule(ctx, cfg, createStats())
    await ctx.emit('agent/status', {})
    await ctx.emit('agent/status', { agent: mkAgent(10, 500000), status: 'running' })
    await tick()
    check('compactionDriver empty payload / running does not trigger', calls === 0)
  }
}

console.log('== cache ==')
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  let executions = 0
  createCacheModule(ctx, { ...resolveConfig({}).cache, enabled: true }, stats)
  const exec = { name: 'glob', arguments: { pattern: '**/*.js' } }
  const run = async () => ctx.emit('tools/execute', exec, async () => {
    executions += 1
    return { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'content' }] }
  })
  await run()
  await run()
  check('paused cache: repeated calls still execute the tool', executions === 2)
  check('paused cache: no false hits', !stats.snapshot().counters['cache.hits'])
}

console.log('== monitor ==')
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  stats.bump('compress.tools', 3)
  stats.bump('compress.savedChars', 5000)
  createMonitorModule(ctx, { ...resolveConfig({}).monitor, showInChat: false }, stats)
  // session/disposed should print the report without throwing
  await ctx.emit('session/disposed', { id: 's1' })
  check('monitor report generated', stats.snapshot().counters['monitor.reports'] === 1)
}

console.log('== monitor usage aggregation and hit rate ==')
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  const logs = []
  const origLog = console.log
  console.log = (...args) => { logs.push(args.join(' ')) }
  let report = ''
  try {
    createMonitorModule(ctx, { ...resolveConfig({}).monitor, showInChat: false }, stats)
    const session = { id: 's2' }
    await ctx.emit('session/event', session, { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, reasoningTokens: 10 } } })
    await ctx.emit('session/event', session, { type: 'user/message', data: {} })
    await ctx.emit('session/event', session, { type: 'assistant/message', data: {} }) // without usage,notcrash
    await ctx.emit('session/disposed', session)
    report = logs.join('\n')
  } finally {
    console.log = origLog
  }
  check('monitor report includes the hit rate 90.0%', /cache hit rate: 90\.0%/.test(report))
  check('monitor report includes usage lines', /1 request/.test(report))
  check('monitor report includes reasoning lines', /reasoning tokens: 10/.test(report))
  const c = stats.snapshot().counters
  check('monitor usage incremental aggregation', c['monitor.inputTokens'] === 100 && c['monitor.cacheReadTokens'] === 900 && c['monitor.usageEvents'] === 1)
}

console.log('== fileDiff ==')
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  createFileDiffModule(ctx, { ...resolveConfig({}).fileDiff, enabled: true }, stats)
  const textA = 'line0\nline1\n' + 'padding-line-x\n'.repeat(500)
  const mk = (text) => ({ isError: false, content: [{ type: 'text', text }] })
  const d1 = await ctx.emit('tools/post-execute', { name: 'read', arguments: { path: 'a.txt' } }, mk(textA), async () => ({ kind: 'accept' }))
  check('fileDiff first read does not change the projection', d1.kind === 'accept' && d1.content === undefined)
  const d2 = await ctx.emit('tools/post-execute', { name: 'read', arguments: { path: 'a.txt' } }, mk(textA), async () => ({ kind: 'accept' }))
  check('fileDiff without a trustworthy baseline it still returns the original', d2.content === undefined)
  const textB = textA.replace('line1', 'line1-CHANGED')
  const d3 = await ctx.emit('tools/post-execute', { name: 'read', arguments: { path: 'a.txt' } }, mk(textB), async () => ({ kind: 'accept' }))
  check('fileDiff changestillreturnsoriginal', d3.content === undefined)
  check('fileDiff no false savings reported', !stats.snapshot().counters['filediff.unchanged'] && !stats.snapshot().counters['filediff.changed'])

  // the real read tool's param key is file_path (pathOf compatibility)
  const d4 = await ctx.emit('tools/post-execute', { name: 'read', arguments: { file_path: 'c.txt' } }, mk(textA), async () => ({ kind: 'accept' }))
  const d5 = await ctx.emit('tools/post-execute', { name: 'read', arguments: { file_path: 'c.txt' } }, mk(textA), async () => ({ kind: 'accept' }))
  check('fileDiff the file_path key also keeps the original', d5.content === undefined)

  // split reads (offset/limit) are outside param tracking/folding: the same file with two different windows must not be judged as "changed"
  const part1 = 'p'.repeat(3000)
  const part2 = 'q'.repeat(3000)
  const d6 = await ctx.emit('tools/post-execute', { name: 'read', arguments: { file_path: 'd.txt', offset: 1, limit: 10 } }, mk(part1), async () => ({ kind: 'accept' }))
  const d7 = await ctx.emit('tools/post-execute', { name: 'read', arguments: { file_path: 'd.txt', offset: 11, limit: 10 } }, mk(part2), async () => ({ kind: 'accept' }))
  check('fileDiff split reads are not tracked and not folded', d6.content === undefined && d7.content === undefined)
}

console.log('== toolTrim ==')
{
  let captured
  let restrictCalls = 0
  const ctxT = makeFakeCtx()
  const statsT = createStats()
  const fakeAgent = {
    id: 'a1',
    ctx: {
      tools: {
        restrict: (filter) => { captured = filter; restrictCalls += 1; return () => {} },
      },
    },
  }
  createToolTrimModule(ctxT, { ...resolveConfig({}).toolTrim, enabled: true, allow: ['read'], deny: ['write'] }, statsT)
  await ctxT.emit('agent/created', { agent: fakeAgent })
  check('toolTrim restricts at agent scope', captured && captured.allow[0] === 'read' && captured.deny[0] === 'write')
  check('toolTrim counter', statsT.snapshot().counters['tooltrim.applied'] === 1)
  await ctxT.emit('agent/created', { agent: fakeAgent })
  check('toolTrim the same agent is not restricted twice', restrictCalls === 1)
  // off registers no listener
  let registered = false
  const ctxD = makeFakeCtx()
  ctxD.on = (event) => { registered = event === 'agent/created' }
  createToolTrimModule(ctxD, { ...resolveConfig({}).toolTrim, enabled: false, allow: ['read'] }, createStats())
  check('toolTrim off registers no listener', registered === false)
  // one agent's restrict failure (e.g. an unknown tool name) does not throw and does not affect later agents
  const ctxTh = makeFakeCtx()
  let okCalls = 0
  createToolTrimModule(ctxTh, { ...resolveConfig({}).toolTrim, enabled: true, allow: ['read'] }, createStats())
  await ctxTh.emit('agent/created', { agent: { id: 'bad', ctx: { tools: { restrict: () => { throw new Error('names unknown global tool') } } } } })
  await ctxTh.emit('agent/created', { agent: { id: 'good', ctx: { tools: { restrict: () => { okCalls += 1; return () => {} } } } } })
  check('toolTrim a single failure does not affect later ones', okCalls === 1)
  // without agent.ctx  loadnotthrow
  await ctxTh.emit('agent/created', {})
  check('toolTrim an empty load does not throw', true)
}

const { runAvailabilityChecks } = await import('./availability.mjs')
await runAvailabilityChecks(check)

// ===== v2.2 iteration (T1/T2/T3/T4/T5/T7) tests =====

console.log('== T1 layeredCompact config foundation ==')
{
  const cfg = resolveConfig({})
  check('T1:default enabled=false (canary)', cfg.layeredCompact.enabled === false)
  check('T1:three-layer default ratios 0.4/0.5/0.65', cfg.layeredCompact.lowRatio === 0.4 && cfg.layeredCompact.midRatio === 0.5 && cfg.layeredCompact.highRatio === 0.65)
  check('T1:sessionWindowFallback default 262144(and the router default is the same value)', cfg.layeredCompact.sessionWindowFallback === 262144)
  check('T1:pricing default prices (0.8/0.23/2.8 yuan per million)', cfg.layeredCompact.pricing.inputPerMillion === 0.8 && cfg.layeredCompact.pricing.cacheHitPerMillion === 0.23 && cfg.layeredCompact.pricing.outputPerMillion === 2.8)
  let threw = false
  try { resolveConfig({ layeredCompact: { lowRatio: 1.5 } }) } catch (e) { threw = /lowRatio/.test(e?.message ?? '') }
  check('T1:lowRatio=1.5 throws and the error message includes lowRatio', threw)
  threw = false
  try { resolveConfig({ layeredCompact: { lowRato: 1.5 } }) } catch (e) { threw = /lowRato/.test(e?.message ?? '') }
  check('T1:an unknown key lowRatio throws (the error message includes the key name)', threw)
  threw = false
  try { resolveConfig({ layeredCompact: { pricing: { inputPerMillion: 'x', cacheHitPerMillion: 0.23, outputPerMillion: 2.8 } } }) } catch (e) { threw = /pricing\.inputPerMillion/.test(e?.message ?? '') }
  check('T1:pricing a non-numeric valuethrows(shallow validation patched)', threw)
  const userPricing = { inputPerMillion: 0.9, cacheHitPerMillion: 0.2, outputPerMillion: 3 }
  const frozen = resolveConfig({ layeredCompact: { pricing: userPricing } }).layeredCompact.pricing
  check('T1:pricing validation returns a deep copy and freezes it (inner/outer decoupled)', frozen !== userPricing && Object.isFrozen(frozen))
}

console.log('== T2 stats bucketing and estimation ==')
{
  const stats = createStats()
  const b1 = stats.bucket('s1')
  const b2 = stats.bucket('s2')
  b1.bump('layeredCompact.lossy', 2)
  b2.bump('layeredCompact.lossy', 5)
  b1.addSample({ module: 'layeredCompact', savedChars: 10 })
  const s1 = stats.snapshotSession('s1')
  const s2 = stats.snapshotSession('s2')
  check('T2:snapshotSession and snapshot samestructure{counters,samples}', typeof s1.counters === 'object' && Array.isArray(s1.samples))
  check('T2:two sessions interleaved writes stay isolated', s1.counters['layeredCompact.lossy'] === 2 && s2.counters['layeredCompact.lossy'] === 5)
  check('T2:the global counter is not bucketed', stats.snapshot().counters['layeredCompact.lossy'] === undefined)
  check('T2:estimateTokens estimation (1600 characters ~ 1000 tokens; non-numbers return 0)', stats.estimateTokens(1600) === 1000 && stats.estimateTokens(-5) === 0)
  check('T2:estimateCost  cost values are correct (1M output = 0.8 yuan; 1M cache = 0.23 yuan)', stats.estimateCost({ inputTokens: 1e6 }) === 0.8 && stats.estimateCost({ cacheReadTokens: 1e6 }) === 0.23)
}

console.log('== T3 computePressure ==')
{
  const session = { events: [{ type: 'request/context', data: { contextWindow: 262144 } }] }
  const ctxP = { get: (k) => (k === 'tokenMeter' ? { measure: () => ({ totalTokens: 131072 }) } : undefined) }
  const p = computePressure(ctxP, session, 1000000)
  check('T3:the event window ratio=0.5 and windowSource=event', p !== null && p.ratio === 0.5 && p.window === 262144 && p.windowSource === 'event')
  const p2 = computePressure(ctxP, { events: [] }, 1000000)
  check('T3:without the event -> fallback window and windowSource=fallback', p2.window === 1000000 && p2.windowSource === 'fallback' && p2.ratio === 131072 / 1000000)
  const ctxNone = { get: () => undefined }
  check('T3:without tokenMeter → null(notthrow)', computePressure(ctxNone, session) === null)
  const ctxThrow = { get: () => ({ measure: () => { throw new Error('boom') } }) }
  check('T3:measure throws → null(notthrow)', computePressure(ctxThrow, session) === null)
}

console.log('== T4/T6 layeredCompact orchestration ==')
{
  const tick = () => new Promise((r) => setImmediate(r))
  const mkLayeredCtx = ({ prunerImpl, compactImpl, measureImpl }) => {
    const ctx = makeFakeCtx()
    ctx.inject = (keys, cb) => {
      const sctx = {}
      for (const k of keys) {
        if (k === 'compaction') sctx[k] = { compactNow: compactImpl }
        if (k === 'tokenMeter') sctx[k] = { measure: measureImpl }
        if (k === 'toolResultPruner') sctx[k] = prunerImpl ? { pruneSession: prunerImpl } : undefined
      }
      cb(sctx)
    }
    return ctx
  }
  const idle = (ctx, agent) => ctx.emit('agent/status', { agent, status: 'idle' })
  const mkAgent = (id, events) => ({ id, session: { events } })
  const winEvents = (window) => [{ type: 'request/context', data: { contextWindow: window } }]
  const cfg = { ...resolveConfig({}).layeredCompact, enabled: true }

  // ① L0 observe only:0.45 → observed +1,both pruneSession and compactNow are 0
  {
    let pruneCalls = 0
    let compactCalls = 0
    const stats = createStats()
    const ctx = mkLayeredCtx({
      prunerImpl: () => { pruneCalls += 1 },
      compactImpl: async () => { compactCalls += 1; return {} },
      measureImpl: () => ({ totalTokens: 45000 }),
    })
    createLayeredCompactModule(ctx, cfg, stats)
    await idle(ctx, mkAgent('la1', winEvents(100000)))
    await tick()
    const c = stats.snapshot().counters
    check('T6①:L0 observe only(0.45 → observed count is 1)', c['layeredCompact.observed'] === 1)
    check('T6①:L0 does not trigger prune/compact', pruneCalls === 0 && compactCalls === 0)
  }
  // ② L1 really lowers the numerator:0.55 → prune runs exactly once; re-measured drop -> savedTokens>0 and compactNow=0
  {
    let tokens = 55000
    let pruneCalls = 0
    let compactCalls = 0
    const stats = createStats()
    const ctx = mkLayeredCtx({
      prunerImpl: () => { pruneCalls += 1; tokens = 30000 },
      compactImpl: async () => { compactCalls += 1; return {} },
      measureImpl: () => ({ totalTokens: tokens }),
    })
    createLayeredCompactModule(ctx, cfg, stats)
    await idle(ctx, mkAgent('la2', winEvents(100000)))
    await tick()
    const c = stats.snapshot().counters
    check('T6②:L1 prune runs exactly once and the re-measured drop is savedTokens=25000', pruneCalls === 1 && c['layeredCompact.pruneSavedTokens'] === 25000)
    check('T6②:lossless count is 1 and compactNow stays 0 (measured 0.3 < 0.65)', c['layeredCompact.lossless'] === 1 && compactCalls === 0)
  }
  // ③ L1 an empty turn is still recorded honestly: 0.7 + prune with no effect -> pruneNoop (not lossless) and still goes through L2
  {
    let pruneCalls = 0
    let compactCalls = 0
    const stats = createStats()
    const ctx = mkLayeredCtx({
      prunerImpl: () => { pruneCalls += 1 }, // tokens do not change -> the measurement does not change
      compactImpl: async () => { compactCalls += 1; return {} },
      measureImpl: () => ({ totalTokens: 70000 }),
    })
    createLayeredCompactModule(ctx, cfg, stats)
    await idle(ctx, mkAgent('la3', winEvents(100000)))
    await tick()
    const c = stats.snapshot().counters
    check('T6③:no drop after measuring -> records pruneNoop, not lossless', c['layeredCompact.pruneNoop'] === 1 && c['layeredCompact.lossless'] === undefined)
    check('T6③:pruneNoop afterstillby ratio go through L2(compactNow exactly 1  times)', compactCalls === 1 && c['layeredCompact.lossy'] === 1)
  }
  // ④ pruner absence is not fatal:pruneUnavailable + L2 judges as usual
  {
    let compactCalls = 0
    const stats = createStats()
    const ctx = mkLayeredCtx({
      prunerImpl: undefined,
      compactImpl: async () => { compactCalls += 1; return {} },
      measureImpl: () => ({ totalTokens: 70000 }),
    })
    createLayeredCompactModule(ctx, cfg, stats)
    await idle(ctx, mkAgent('la4', winEvents(100000)))
    await tick()
    const c = stats.snapshot().counters
    check('T6④:pruner pruner absent -> pruneUnavailable and L2 proceeds as usual', c['layeredCompact.pruneUnavailable'] === 1 && compactCalls === 1)
  }
  // ⑤ L2 exactlyoone times + between two turns, a reverse idle does not trigger twice
  {
    let tokens = 80000
    let compactCalls = 0
    const stats = createStats()
    const ctx = mkLayeredCtx({
      prunerImpl: () => { if (tokens > 68000) tokens = 68000 }, // first drops to 0.68 (still above high)
      compactImpl: async () => { compactCalls += 1; return {} },
      measureImpl: () => ({ totalTokens: tokens }),
    })
    createLayeredCompactModule(ctx, cfg, stats)
    const agent = mkAgent('la5', winEvents(100000))
    await idle(ctx, agent) // 0.8 -> L1 compresses to 0.68 -> re-measured still >= 0.65 -> L2 exactly once
    await tick()
    check('T6⑤:L2 triggerexactlyoone times', compactCalls === 1)
    // simulate pressure falling back between two turns after L2 (0.55): a reverse idle must not trigger L2 again
    tokens = 55000
    await idle(ctx, agent)
    await tick()
    await idle(ctx, agent)
    await tick()
    check('T6⑤:between two turns, a reverse idle does not trigger twice', compactCalls === 1)
  }
  // ⑥ error classes:busy → failed.busy + session backs off;prune throws → pruneFailed and does not interrupt
  {
    let compactCalls = 0
    const stats = createStats()
    const ctx = mkLayeredCtx({
      prunerImpl: () => { throw new Error('prune boom') },
      compactImpl: async () => { compactCalls += 1; const e = new Error('busy'); e.code = 'busy'; throw e },
      measureImpl: () => ({ totalTokens: 70000 }),
    })
    createLayeredCompactModule(ctx, cfg, stats)
    const agent = mkAgent('la6', winEvents(100000))
    await idle(ctx, agent) // prune throws → pruneFailed;L2 compactNow busy → failed.busy + backedOff
    await tick()
    const c = stats.snapshot().counters
    check('T6⑥:compactNow busy → records failed.busy (not a generic failed)', c['layeredCompact.failed.busy'] === 1)
    check('T6⑥:prune throws → pruneFailed and does not interrupt handler(L2 alreadyjudge)', c['layeredCompact.pruneFailed'] === 1 && compactCalls === 1)
    await idle(ctx, agent) // backedOff:afterwards no more automatic lossy compaction
    await tick()
    check('T6⑥⑧:after busy this session backs off and does not auto-compact again', compactCalls === 1)
  }
}

console.log('== T5 /token-status ==')
{
  const registered = []
  const ctx = makeFakeCtx()
  ctx.inject = (keys, cb) => {
    const svc = {}
    if (keys.includes('commands')) svc.commands = { register: (d) => { registered.push(d); return () => {} } }
    if (keys.includes('tokenMeter')) svc.tokenMeter = { measure: () => ({ totalTokens: 300000 }) }
    if (Object.keys(svc).length > 0) cb(svc)
  }
  const stats = createStats()
  // bucket key = agent.id (consistent with layeredCompact's write side; session id and agent id are two different things)
  stats.bucket('a1').bump('layeredCompact.lossy', 1)
  stats.bucket('a1').bump('layeredCompact.observed', 3)
  stats.bump('ladder.savedChars', 3200)
  registerTokenStatusCommand(ctx, resolveConfig({}), stats)
  check('T5:the command token-status is already registered', registered.length === 1 && registered[0].name === 'token-status')
  const agent = { id: 'a1', session: { id: 'sess-1', events: [{ type: 'request/context', data: { contextWindow: 1000000 } }] } }
  const out = registered[0].handler({ agent })
  check('T5:success and includes pressure ratio / window source / layer counters / cost accounting basis', out.kind === 'success'
    && /Pressure ratio 30\.0%/.test(out.text)
    && /window source: request\/context declaration/.test(out.text)
    && /Layered model summarization: attempts 0 \/ success 1/.test(out.text)
    && /API cost/.test(out.text))
  const outNoSession = registered[0].handler({})
  check('T5:without a session -> the pressure ratio is unavailable but still success (no empty claims)', outNoSession.kind === 'success' && /unavailable/.test(outNoSession.text))
}

console.log('== T7 outputLadder/fileDiff baseline-rebuild regression ==')
{
  // the inner handler rewrites content -> outputLadder's compression must apply to the baseline after the inner rewrite,
  // and additionalContexts must not be dropped (rebuilding from result.content used to drop it)
  const ctx2 = makeFakeCtx()
  createOutputLadderModule(ctx2, resolveConfig({}).outputLadder, createStats())
  ctx2.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    // further inner: replace content with another large JSON carrying the INNER marker, and attach additionalContexts
    const inner = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ idx: i, data: `INNER-${i}-${'x'.repeat(100)}` })))
    return { ...decision, content: [{ type: 'text', text: inner }], additionalContexts: [{ type: 'text', text: 'ctx-keep' }] }
  })
  const exec = { name: 'pwsh', arguments: { command: 'x' } }
  const original = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ idx: i, data: `ORIG-${i}-${'x'.repeat(100)}` })))
  const d = await ctx2.emit('tools/post-execute', exec, { isError: false, content: [{ type: 'text', text: original }] },
    async () => ({ kind: 'accept', content: [{ type: 'text', text: original }] }))
  const text = txt(d.content)
  check('T7:compression applies to the baseline after the inner rewrite (includes INNER, excludes ORIG)', text.includes('INNER-') && !text.includes('ORIG-'))
  check('T7:additionalContexts is not dropped', Array.isArray(d.additionalContexts) && d.additionalContexts[0].text === 'ctx-keep')
  check('T7:structural compression still completes(json-array-compressed)', text.includes('json-array-compressed'))

  // fileDiff safe degradation: keeps the inner projection and additionalContexts as-is
  const ctx3 = makeFakeCtx()
  createFileDiffModule(ctx3, resolveConfig({}).fileDiff, createStats())
  const bigFile = 'y'.repeat(4096)
  const execR = { name: 'read', arguments: { path: 'a.txt' } }
  await ctx3.emit('tools/post-execute', execR, { isError: false, content: [{ type: 'text', text: bigFile }] },
    async () => ({ kind: 'accept', content: [{ type: 'text', text: bigFile }] }))
  const d2 = await ctx3.emit('tools/post-execute', execR, { isError: false, content: [{ type: 'text', text: bigFile }] },
    async () => ({ kind: 'accept', content: [{ type: 'text', text: bigFile }], additionalContexts: [{ type: 'text', text: 'keep-me' }] }))
  check('T7:fileDiff keeps the original and passes through additionalContexts', txt(d2.content) === bigFile && d2.additionalContexts?.[0]?.text === 'keep-me')
}

await runCompressionChecks(check)

console.log('')
if (failures === 0) {
  console.log('ALL CHECKS PASSED')
  process.exit(0)
} else {
  console.error(`${failures} CHECK(S) FAILED`)
  process.exit(1)
}

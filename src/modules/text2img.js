// text2img: render very long natural-language text into images, read the images via a vision API to get a summary,
// and replace the original text with the text summary in the context. Single measured run (2582-character text): 1530 tokens original -> 430 tokens image, ~72% saved.
// Note: a single sample; this feature's real value is "the longer the session, the more it saves" (later turns no longer carry the original).
// Design points:
// - Since v2.1, reaching the threshold always asks (regardless of content type); content type decides the recommended option and the timeout default --
//   natural language -> convert to image summary, strongly structural -> read the original (v2.0's "auto-convert prose" left the model unable to read
//   original details, a real incident that drove this). askOnSkip=false restores v2.0's automatic behavior.
// - Dynamic resolution tiers (640x360 / 1280x720 / 1920x1080); larger tiers raise the font size to keep page density
//   (density above ~3,000 characters/page makes vision models hallucinate -- the root cause of three incident classes)
// - Content hash -> on-disk summary cache; cross-session hits cost 0 API calls
// - On Windows, render via System.Drawing (scripts/render-text.ps1); elsewhere degrade to saving the original only
// - The original text is saved to disk (reversible); the summary names its source file plus a "read the original before quoting details" guard
// - Same shape as modlens: "image -> text" completes inside the plugin; only text enters the DSH adapter
//   (the dsh-llm-deepseek adapter rejects image blocks; this is the only viable path)

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Debug log: off by default; set DSH_TOKEN_OPTIMIZER_DEBUG=1 when troubleshooting to write it to disk
const DEBUG_LOG = process.env.DSH_TOKEN_OPTIMIZER_DEBUG_LOG || join(homedir(), '.dsh', 'text2img-debug.log')
const DEBUG_ENABLED = !!process.env.DSH_TOKEN_OPTIMIZER_DEBUG
function dbg(msg) {
  if (!DEBUG_ENABLED) return
  try { appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf8') } catch {}
}
const ORIGINAL_DIR = join(homedir(), '.dsh', 'token-optimizer', 'text2img-originals')
const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/render-text.ps1', import.meta.url))

// ---- Content-type detection: natural language only ----
const CODE_LIKE = /(^|\n)\s*(function|const|let|var|import|export|class|def |public |private |<[a-zA-Z][^>]*>|[{}\[\];]\s*$|\/\/|\/\*|#!)/m
const JSON_LIKE = /^[\s]*[\[{]/
function isNaturalLanguage(text) {
  if (JSON_LIKE.test(text)) return { ok: false, reason: 'json-like' }
  const lines = text.split(/\r?\n/)
  const total = lines.length
  if (total === 0) return { ok: false, reason: 'empty' }

  // Partition by ``` / ~~~ code fences: lines inside fences, plus non-fence lines that look like code, all count as code-like
  let inFence = false
  let codeLike = 0
  let configLike = 0
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; codeLike++; continue }
    if (inFence) { codeLike++; continue }
    if (CODE_LIKE.test(line)) { codeLike++; continue }
    // Config-like lines: indented "key: value" / "key=value" (YAML/properties/ini, etc.)
    if (/^[ \t]+[A-Za-z0-9_.\-/]+:\s*/.test(line) || /^[ \t]+\S+=\s*/.test(line)) configLike++
  }

  // (1) code/fence share too high -> judged as code or a structural file; skip (avoids OCR corruption)
  if (codeLike / total > 0.5) return { ok: false, reason: 'code-like' }
  // (2) almost all indented key:value / key=value -> config file; skip
  if (total > 8 && configLike / total > 0.5) return { ok: false, reason: 'config-like' }
  // (3) too structural: pure separator lines (----- / ===== / +----+ table rules) >= 5 with many total lines
  //    (v1 rejected anything with a single run of 10+ separators anywhere, hurting long texts with one separator line;
  //     it now counts pure separator lines, so ordinary separator-styled headings are unaffected)
  let separatorLines = 0
  for (const line of lines) {
    if (/^\s*[-=_*|+]{10,}\s*$/.test(line)) separatorLines++
  }
  if (total > 200 && separatorLines >= 5) return { ok: false, reason: 'structural' }
  return { ok: true, reason: 'pass' }
}

// ---- Dynamic resolution tiers ----
// Density principle: a verified-reliable page density is font size 24 at width 1200, about 1,000 characters/page; above ~3,000/page the model hallucinates.
// Larger tiers scale the font proportionally to keep density (1920x1080 at size 36 is about 1,250 characters/page).
// Measured 2026-09-09 (YaHei line height ~1.9x font size): 800x450 about 160 chars/page, 1440x810 about 490, 1920x1080@36 about 440.
function tierFor(chars, config) {
  if (!config.dynamicResolution) {
    return { width: config.renderWidth, pageFontSize: config.pageFontSize, pageMaxHeight: config.pageMaxHeight }
  }
  for (const t of config.resolutionTiers) {
    if (chars <= t.maxChars) return { width: t.width, pageFontSize: t.fontSize, pageMaxHeight: t.height }
  }
  const last = config.resolutionTiers[config.resolutionTiers.length - 1]
  return { width: last.width, pageFontSize: last.fontSize, pageMaxHeight: last.height }
}

// Economics estimate (shown in the ask so the user chooses with full information):
// - original tokens ~ characters x 0.7 (mixed Chinese/English on DeepSeek runs about 0.65-0.75 tokens/character)
// - image tokens ~ pages x 60 (measured: a 1200x3000 large page is ~72/image, small 800x450 pages fewer; 60 is conservative)
// - measured per-page density, in the same order as resolutionTiers
const TIER_CHARS_PER_PAGE = [160, 490, 440]
function estimateEconomics(text, config) {
  const origTokens = Math.round(text.length * 0.7)
  let charsPerPage = 400 // fallback (the old pagination approximation when dynamicResolution is off)
  if (config.dynamicResolution) {
    for (let i = 0; i < config.resolutionTiers.length; i++) {
      if (text.length <= config.resolutionTiers[i].maxChars) { charsPerPage = TIER_CHARS_PER_PAGE[i]; break }
    }
  }
  const pages = Math.max(1, Math.ceil(text.length / charsPerPage))
  const imageTokens = pages * 60
  const cap = summaryCapFor(text.length, config)
  return { origTokens, pages, imageTokens, cap }
}
// Summary cap = min(maxSummaryChars, input x maxSummaryRatio), floored at 200 --
// this guarantees the replacement is shorter than the original (otherwise short texts would keep the original because the summary runs long, burning vision for nothing)
function summaryCapFor(len, config) {
  return Math.min(config.maxSummaryChars, Math.max(200, Math.round(len * config.maxSummaryRatio)))
}

// ---- Rendering: Windows System.Drawing ----
function renderToPng(text, pageConfig = {}) {
  return new Promise((resolve, reject) => {
    const out = join(tmpdir(), `t2i-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
    const child = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH,
      '-text', text, '-outPath', out, '-width', String(pageConfig.width ?? 1200),
      '-fontSize', String(pageConfig.pageFontSize ?? 24),
      '-maxHeight', String(pageConfig.pageMaxHeight ?? 3000),
    ], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0 && existsSync(out)) {
        // Paged rendering: the script prints paginated file paths line by line on stdout (the first line is an "OK ..." summary line)
        const extra = stdout.split(/\r?\n/).map((s) => s.trim())
          .filter((s) => s && /\.png$/i.test(s) && s !== out)
        const pages = [out, ...extra].filter((p) => existsSync(p))
        resolve(pages)
      } else {
        reject(new Error(`render failed (${code}): ${stderr.slice(0, 200)}`))
      }
    })
  })
}

// ---- Summary disk cache: content hash -> summary; cross-session hits cost 0 API calls ----
// Entries also record the on-disk path from the first conversion: DSH resends the same inbox
// message on every step; a cache hit reuses that path so the same text does not produce duplicate original files
// (measured incident: the same text appearing 7 times produced 7 duplicate original files).
function hashOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function makeSummaryCache(cacheDir) {
  // promptHash: changing the prompt invalidates old summaries -- a cached bad summary would make incidents permanent (measured:
  // a long Zhihu post was summarized down to its copyright block; after a prompt change the same content must go through vision again)
  function read(hash, promptHash) {
    try {
      const raw = readFileSync(join(cacheDir, `${hash}.json`), 'utf8')
      const data = JSON.parse(raw)
      if (data.promptHash && data.promptHash !== promptHash) return null
      if (typeof data.summary === 'string' && data.summary.trim().length > 0) {
        return { summary: data.summary, original: typeof data.original === 'string' ? data.original : null }
      }
    } catch { /* miss/corrupt: treat as no cache */ }
    return null
  }
  function write(hash, summary, original, promptHash) {
    try {
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(join(cacheDir, `${hash}.json`), JSON.stringify({
        summary, original: original ?? null, promptHash, savedAt: new Date().toISOString(),
      }), 'utf8')
    } catch { /* a failed cache write must not block the main flow */ }
  }
  return { read, write }
}

// ---- Vision API summaries (batch + merge) ----
// Measured incident: reading 8+ pages at once, flash-vision summarized only the first pages and invented that "the text ends here",
// losing the rest. Structural fix: batch vision calls by pagesPerBatch (forcing full coverage per batch),
// then merge as plain text; a "page i of N" marker before each image helps the model track progress.
export function splitChunks(paths, batchSize) {
  const out = []
  for (let i = 0; i < paths.length; i += batchSize) out.push(paths.slice(i, i + batchSize))
  return out
}

function buildVisionContent(paths, prompt, pageOffset, totalPages) {
  const content = []
  paths.forEach((p, i) => {
    content.push({ type: 'text', text: `[page ${pageOffset + i + 1} of ${totalPages}]` })
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${readFileSync(p).toString('base64')}` } })
  })
  content.push({ type: 'text', text: prompt })
  return content
}

async function callVisionApi(content, config) {
  const body = {
    model: config.visionModel,
    messages: [{ role: 'user', content }],
    // deepseek-v4-flash-vision-exp is a reasoning model: it spends reasoning tokens before emitting content.
    // If max_tokens is too small, thinking tokens exhaust the budget and content comes back empty (an empty summary).
    // Real incident: with 4096 reserved it returned an empty summary after 51 seconds of thinking. The thinking budget is configurable and defaults to 16384.
    max_tokens: config.maxSummaryChars + (config.reasoningBudget ?? 16384),
  }
  const apiKey = typeof config.resolveApiKey === 'function'
    ? await config.resolveApiKey()
    : process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set (no process.env and no ctx.credentials resolver)')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const resp = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error(`vision API ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
    const data = await resp.json()
    const summary = data?.choices?.[0]?.message?.content ?? ''
    if (typeof summary !== 'string' || summary.trim().length === 0) throw new Error('empty vision summary')
    return summary.slice(0, config.maxSummaryChars)
  } finally {
    clearTimeout(timer)
  }
}

async function summarizeImage(imagePathOrPaths, config) {
  const paths = Array.isArray(imagePathOrPaths) ? imagePathOrPaths : [imagePathOrPaths]
  const batch = Math.max(1, config.pagesPerBatch ?? 4)
  if (paths.length <= batch) {
    return callVisionApi(buildVisionContent(paths, config.prompt, 0, paths.length), config)
  }
  // Batched summaries: every batch covers its pages fully
  const chunks = splitChunks(paths, batch)
  const partSummaries = []
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]
    const offset = ci * batch
    const chunkPrompt = `The following are pages ${offset + 1}-${offset + chunk.length} of one long document (${paths.length} pages total). ${config.prompt}`
    partSummaries.push(await callVisionApi(buildVisionContent(chunk, chunkPrompt, offset, paths.length), config))
  }
  // Plain-text merge (no images): no segment may be dropped
  const mergePrompt = `Below are ${partSummaries.length} summary segments of one long document, in original order. Merge them into one concise, accurate summary in the language of the source; keep key numbers, proper nouns, and structural points; do not omit any segment's core content; do not add new information.\n\n${partSummaries.map((s, i) => `=== segment ${i + 1} ===\n${s}`).join('\n\n')}`
  return callVisionApi([{ type: 'text', text: mergePrompt }], config)
}

function saveOriginal(text, dir = ORIGINAL_DIR) {
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `t2i-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
    writeFileSync(file, text, 'utf8')
    return file
  } catch {
    return null
  }
}

export function createText2imgModule(ctx, config, stats, deps = {}) {
  const renderer = deps.renderToPng ?? renderToPng
  const summarizer = deps.summarizeImage ?? summarizeImage
  const summaryCache = makeSummaryCache(deps.cacheDir ?? join(homedir(), '.dsh', 'token-optimizer', 'text2img-summary-cache'))
  const originalDir = deps.originalDir ?? ORIGINAL_DIR
  const listeners = []
  if (typeof ctx?.on !== 'function') return () => {}

  // The userQuestions service (optional): at the threshold, ask "convert to image summary / read the original".
  // Core fact: the web provider (dsh-host-apiproxy) requires request.agent
  // (without an agent it rejects with ASK_MISSING_AGENT), so the agent must be included --
  // the pre-step payload has no agent, so track "the currently running agent" from agent/status events
  // (the running event fires before that agent's in-turn pre-step).
  let userQuestions
  let currentAgent
  try {
    ctx.inject?.(['userQuestions'], (sctx) => {
      userQuestions = sctx.userQuestions
    })
  } catch { /* inject unavailable: silently skip asking */ }
  const onStatus = (payload) => {
    if (payload?.status === 'running' && payload?.agent) currentAgent = payload.agent
  }
  ctx.on?.('agent/status', onStatus)
  listeners.push(() => ctx.off?.('agent/status', onStatus))

  // Ask once per text: fingerprint -> the user's last choice (prevents repeat popups from multi-message or replay)
  const askedFingerprints = new Map()
  function fingerprintOf(text) {
    return `${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`
  }
  // Default path by content type (the fallback when asking times out, is unavailable, or the ask quota is spent)
  function defaultPathFor(nl) {
    return nl.ok ? 'img' : 'raw'
  }
  let askCount = 0 // popups used this session (maxAsksPerSession quota)

  // ask with a timeout: the provider only ends on signal abort (no built-in timeout); the timeout is driven plugin-side.
  // Timeout -> abort the popup (dismissed on the web) -> fall back to the content-type default.
  function askWithTimeout(req, timeoutMs) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      let timedOut = false
      const timer = timeoutMs > 0
        ? setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
        : null
      const ext = req.signal
      const onExtAbort = () => controller.abort()
      if (ext && typeof ext.addEventListener === 'function') {
        if (ext.aborted) { if (timer) clearTimeout(timer); controller.abort() }
        else ext.addEventListener('abort', onExtAbort, { once: true })
      }
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        if (ext && typeof ext.removeEventListener === 'function') ext.removeEventListener('abort', onExtAbort)
      }
      userQuestions.ask({ ...req, signal: controller.signal })
        .then((resp) => { cleanup(); resolve({ resp, timedOut: false }) })
        .catch((err) => {
          cleanup()
          if (timedOut) resolve({ resp: null, timedOut: true })
          else reject(err)
        })
    })
  }

  // v2.1 main path: always ask at the threshold. Returns 'img' (image summary) or 'raw' (read the original).
  async function choosePath(text, nl, signal) {
    const fp = fingerprintOf(text)
    const prev = askedFingerprints.get(fp)
    if (prev) return prev
    if (askedFingerprints.size > 64) askedFingerprints.clear()

    // Asking disabled: v2.0 automatic behavior (natural language auto-converts; strongly structural skips)
    if (config.askOnSkip === false) return defaultPathFor(nl)
    // Ask quota spent: silently apply the content-type default
    if (config.maxAsksPerSession > 0 && askCount >= config.maxAsksPerSession) {
      const def = defaultPathFor(nl)
      askedFingerprints.set(fp, def)
      console.log(`[dsh-token-optimizer] text2img: session ask limit reached (${config.maxAsksPerSession}); content-type default applied: ${def === 'img' ? 'image summary' : 'read original'}`)
      return def
    }
    // Asking unavailable: silently read the original (better to save no tokens than silently lose detail)
    if (!userQuestions || typeof userQuestions.ask !== 'function') {
      console.log('[dsh-token-optimizer] text2img: no userQuestions service; skipping the ask (reading the original)')
      return 'raw'
    }
    if (!currentAgent) {
      console.log('[dsh-token-optimizer] text2img: cannot locate the current agent; skipping the ask (reading the original)')
      return 'raw'
    }

    // Put the recommended option first (its label carries "(recommended)") -- the option protocol has no highlight field
    const imgOpt = { id: 'text2img_convert', label: nl.ok ? 'Convert to image summary (recommended)' : 'Convert to image summary' }
    const rawOpt = { id: 'text2img_raw', label: nl.ok ? 'Read the original as-is' : 'Read the original as-is (recommended)' }
    const options = nl.ok ? [imgOpt, rawOpt] : [rawOpt, imgOpt]
    // Economics: for short texts the first round may not pay off (image base token overhead); the estimate is shown to the user
    const est = estimateEconomics(text, config)
    const econ = `The original is about ${est.origTokens} tokens; conversion needs ~${est.pages} image page(s) (about ${est.imageTokens} tokens) + a summary of at most ${est.cap} characters. Short texts may not save on the first round; the payoff grows in later turns of long sessions.`
    const question = nl.ok
      ? `Detected a natural-language text of ${text.length} characters. ${econ}The summary may be inaccurate (the original is always saved to disk for lookup). How should it be handled?`
      : `Detected a long text of ${text.length} characters with content type "${nl.reason}" (strongly structural/code-like). ${econ}Converting to images would damage tables and code structure, and a visual summary may be inaccurate (the original is always saved to disk for lookup). How should it be handled?`
    try {
      stats?.bump('text2img.asked', 1)
      askCount += 1
      const { resp, timedOut } = await askWithTimeout({
        questions: [{ id: 'text2img_path', question, options }],
        agent: currentAgent,
        signal,
      }, config.askTimeoutMs)
      let chosen
      if (timedOut) {
        chosen = defaultPathFor(nl)
        console.log(`[dsh-token-optimizer] text2img: ask timed out (${config.askTimeoutMs}ms); content-type default applied: ${chosen === 'img' ? 'image summary' : 'read original'}`)
      } else {
        const selected = resp?.answers?.[0]?.selected ?? []
        const isImg = selected.some((s) => s === imgOpt.label || s === imgOpt.id)
        chosen = isImg ? 'img' : 'raw'
      }
      if (chosen === 'img' && !nl.ok) stats?.bump('text2img.forced', 1)
      askedFingerprints.set(fp, chosen)
      return chosen
    } catch (err) {
      // NO_PROVIDER / CALLER_NOT_LIVE / user cancelled / interrupted: fall back to reading the original (fail-safe)
      console.log(`[dsh-token-optimizer] text2img: ask did not complete (${err?.code ?? err?.message ?? err}); reading the original`)
      return 'raw'
    }
  }

  // Injected API-key resolution: the same credential-resolution pattern as dsh-llm-deepseek
  const resolveApiKey = async () => {
    dbg('resolveApiKey: begin')
    try {
      const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
      dbg('resolveApiKey: credentials=' + (credentials ? typeof credentials.resolve : 'undefined'))
      if (credentials && typeof credentials.resolve === 'function') {
        const ref = 'DEEPSEEK_API_KEY'
        const hit = await credentials.resolve(ref)
        dbg('resolveApiKey: hit=' + (hit ? 'yes' : 'undefined'))
        if (hit && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
      } else {
        dbg('resolveApiKey: credentials.resolve missing')
      }
    } catch (e) {
      dbg('resolveApiKey: credentials error: ' + (e?.message ?? e))
    }
    const ambient = process.env.DEEPSEEK_API_KEY
    dbg('resolveApiKey: ambient=' + (ambient ? 'set' : 'missing'))
    if (ambient && ambient.length > 0) return ambient
    return null
  }
  const effectiveConfig = { ...config, resolveApiKey }

  const handler = async (payload, next) => {
    dbg('pre-step: begin')
    const decision = await next()
    if (!decision || decision.kind !== 'enter') { dbg('pre-step: not enter, kind=' + decision?.kind); return decision }
    const messages = decision.messages
    if (!Array.isArray(messages) || messages.length === 0) { dbg('pre-step: no messages'); return decision }

    const out = []
    let changed = false
    let savedChars = 0
    for (const message of messages) {
      // Process only real user messages (source.kind='user').
      // The runtime context snapshot DSH injects each turn (dsh-system-prompt, source.kind='plugin',
      // carrying file policy/project memory; it grows with memory and shifts slightly each turn) is not user input -- converting it would misfire,
      // and snapshot changes defeat fingerprint dedup, popping the ask every turn (measured incident: a 30-character instruction plus a 2,864-character snapshot
      // made the ask point at the snapshot rather than the instruction).
      const srcKind = message?.source?.kind
      if (srcKind !== undefined && srcKind !== 'user') {
        out.push(message)
        continue
      }
      const content = message?.content
      const text = typeof content === 'string' ? content
        : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
        : ''
      dbg('pre-step: msg len=' + text.length + ' threshold=' + effectiveConfig.threshold)
      if (text.length < effectiveConfig.threshold) {
        out.push(message)
        continue
      }
      const nl = isNaturalLanguage(text)
      const path = await choosePath(text, nl, payload?.signal)
      if (path === 'raw') {
        // Not converting an over-threshold text must be visible: passing it silently looks like "the feature is off" (a real user hit this)
        stats?.bump('text2img.skipped', 1)
        console.log(`[dsh-token-optimizer] text2img: not converted; original kept (${text.length} characters${nl.ok ? '' : '; reason: ' + nl.reason})`)
        out.push(message)
        continue
      }

      dbg('text2img: TRIGGERED, len=' + text.length)
      console.log(`[dsh-token-optimizer] text2img triggered: ${text.length} characters -> render images -> vision summary`)
      try {
        const hash = hashOf(text)
        const promptHash = hashOf(effectiveConfig.prompt)
        const cached = effectiveConfig.summaryCache ? summaryCache.read(hash, promptHash) : null
        let summary
        let cacheHit = false
        let originalFile = null
        if (cached) {
          cacheHit = true
          summary = cached.summary
          // Reuse the original path from the first conversion; when DSH resends the same message each step, it is not saved again
          if (effectiveConfig.saveOriginal) {
            originalFile = cached.original && existsSync(cached.original) ? cached.original : saveOriginal(text, originalDir)
            if (!cached.original) summaryCache.write(hash, summary, originalFile, promptHash) // backfill the path
          }
          stats?.bump('text2img.cacheHits', 1)
          dbg('text2img: cache HIT, skip render+vision')
          console.log('[dsh-token-optimizer] text2img: summary cache hit; skipping rendering and the vision call')
        } else {
          dbg('text2img: rendering...')
          const tier = tierFor(text.length, effectiveConfig)
          const png = await renderer(text, tier)
          dbg('text2img: rendered=' + png)
          // The summary cap scales with the input: guarantees the replacement is shorter than the original
          const cap = summaryCapFor(text.length, effectiveConfig)
          summary = await summarizer(png, { ...effectiveConfig, maxSummaryChars: cap })
          dbg('text2img: summary len=' + (summary?.length ?? -1) + ' cap=' + cap)
          originalFile = effectiveConfig.saveOriginal ? saveOriginal(text, originalDir) : null
          if (effectiveConfig.summaryCache) summaryCache.write(hash, summary, originalFile, promptHash)
        }
        const marker = originalFile ? `(original full text: ${originalFile})` : '(original full text not saved to disk)'
        const replaced = `[dsh-token-optimizer text2img: the oversized text was rendered to images and summarized by a vision model (the summary may be inaccurate; before quoting any detail you must read the original file to verify it, and never guess from the summary) ${marker}${cacheHit ? '; summary served from disk cache' : ''}]\n\n${summary}`
        if (replaced.length < text.length) {
          savedChars += text.length - replaced.length
          out.push({ ...message, content: [{ type: 'text', text: replaced }] })
          changed = true
          stats?.bump('text2img.messages', 1)
          stats?.bump('text2img.savedChars', savedChars)
          stats?.addSample({ module: 'text2img', savedChars: text.length - replaced.length })
          dbg('text2img: REPLACED, saved ' + (text.length - replaced.length) + ' chars')
          continue
        } else {
          dbg('text2img: replaced not shorter (' + replaced.length + ' >= ' + text.length + '), keep original')
        }
      } catch (error) {
        stats?.bump('text2img.failures', 1)
        console.warn(`[dsh-token-optimizer] text2img failed (${error?.message ?? error}); keeping the original`)
        dbg('text2img: FAILED: ' + (error?.message ?? error))
      }
      out.push(message)
    }
    return changed ? { ...decision, messages: out } : decision
  }

  ctx.on('agent/pre-step', handler)
  listeners.push(() => ctx.off('agent/pre-step', handler))
  return () => {
    for (const off of listeners) off()
  }
}

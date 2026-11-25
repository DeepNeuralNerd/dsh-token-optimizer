// outputLadder: a single pass on tools/post-execute that routes tool-result projections through a decision table.
//
// Merges v1's three modules and fixes their problems:
//   - compress (structural compression) / sample (sampling) moved here, applied per tool type
//   - the old pruning "truncation" intent became birth-point processing (v1 hooked agent/pre-step, but there
//     it could never see historical tool results; it was effectively dead code)
//   - sample's original 50000-character threshold was hollowed out by the core spill (50000 bytes, outermost in the chain and running first);
//     this now uses 8000 characters for shell-type tools only, covering the unprotected 8k-50k band
//
// Routing decision table (evaluated in order, first match returns; every replacement has a "only replace when shorter" guard):
//   1. read-type tools (first read kept in full; repeated reads are fileDiff's job) -> pass through
//   2. no text blocks -> pass through
//   3. result.isError -> error summary (errorSummaryChars); error text is often a very long traceback,
//      and structural compression would break its semantics, so it must be handled first
//   4. >= structureThreshold and JSON array/CSV -> structure-aware compression; the original is saved to disk, reversible.
//      Ahead of the byte check: structural compression keeps JSON/CSV information density far higher than the core spill's
//      head/tail preview; compressing first means spill then sees small content and does not spill again
//   5. >= spillBytes -> pass through to the core spill (the chain's outermost fallback; unstructured large outputs
//      get its head/tail preview + on-disk locator)
//   6. shell-type tool and >= shellThreshold -> head/tail + evenly spaced sampling (with line numbers); the original is saved to disk, reversible
//   7. everything else -> pass through

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ORIGINAL_DIR = join(homedir(), '.dsh', 'token-optimizer', 'originals')

function ensureDir() {
  try {
    mkdirSync(ORIGINAL_DIR, { recursive: true })
  } catch {
    // Degrade silently when the directory is not writable: compression still works without saving originals (only unrecoverable)
  }
}

function textBlocks(blocks) {
  return (blocks ?? []).filter((block) => block?.type === 'text')
}

function toText(blocks) {
  return textBlocks(blocks).map((block) => block.text).join('\n')
}

// Folded projection: the replacement goes into the first text block only; other text blocks are dropped (so the marker never repeats across blocks)
function foldTextBlocks(blocks, replacement) {
  let replacedFirst = false
  return (blocks ?? []).flatMap((block) => {
    if (block?.type !== 'text') return [block]
    if (!replacedFirst) {
      replacedFirst = true
      return [{ ...block, text: replacement }]
    }
    return []
  })
}

function saveOriginal(exec, text) {
  ensureDir()
  const name = String(exec?.name ?? 'tool').replace(/[^A-Za-z0-9_-]/g, '_')
  const file = join(ORIGINAL_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
  try {
    writeFileSync(file, text, 'utf8')
    return file
  } catch {
    return null
  }
}

// ---- JSON structural compression (migrated from v1 compress) ----
function compressJsonArray(text, { compressionRate, preserveHeadTail }) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length <= 4) return null

  const total = parsed.length
  // Sampling cap of 500: even larger arrays are capped in the summary (about 45k characters), so a huge array
  // cannot push the compressed result itself back into spill territory
  const sampleCount = Math.max(2, Math.min(total, 500, Math.ceil(total * compressionRate)))
  const step = total / sampleCount
  const picked = []
  for (let i = 0; i < sampleCount; i++) picked.push(parsed[Math.min(total - 1, Math.floor(i * step))])

  // Extract the schema: the first element's key set becomes the column names
  const first = parsed[0]
  const columns = first && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first) : null

  const summary = {
    kind: 'json-array-compressed',
    totalRows: total,
    sampledRows: picked.length,
    columns,
    sample: picked,
  }
  const out = JSON.stringify(summary)
  if (out.length >= text.length) return null // no compression unless characters are actually saved
  return out
}

// ---- CSV structural compression (migrated from v1 compress) ----
// v1's flaw: any multi-line text was treated as CSV (including pwsh output). A column-consistency
// heuristic is added here: only a delimiter-bearing header plus matching column counts in the first body lines counts as CSV.
function compressCsv(text, { preserveHeadTail }) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length <= 8) return null
  const header = lines[0]
  const delim = header.includes('\t') ? '\t' : header.includes(',') ? ',' : null
  if (!delim) return null
  const headerCols = header.split(delim).length
  if (headerCols < 2) return null
  const checks = lines.slice(1, 4).map((line) => line.split(delim).length)
  if (!checks.every((count) => count === headerCols)) return null
  const body = lines.slice(1)
  const total = body.length
  const head = body.slice(0, preserveHeadTail)
  const tail = body.slice(-preserveHeadTail)
  const out = [header, `[... ${total - head.length - tail.length} rows omitted, original data saved to disk ...]`, ...head, ...tail].join('\n')
  if (out.length >= text.length) return null
  return out
}

// ---- Error summary (new; replaces v1 pruning's "delete stale failure output" intent) ----
function summarizeError(text, maxChars) {
  if (text.length <= maxChars) return null
  const head = text.slice(0, maxChars)
  return `${head}\n\n[... dsh-token-optimizer outputLadder: error output summarized (was ${text.length} characters, first ${maxChars} characters kept) ...]`
}

// ---- Shell output sampling (migrated from v1 sample, shell-type tools only; now reversible via on-disk originals) ----
function sampleShell(text, config) {
  const lines = text.split(/\r?\n/)
  if (lines.length <= config.headLines + config.tailLines + 2) return null

  const head = lines.slice(0, config.headLines)
  const tail = lines.slice(-config.tailLines)
  const middle = lines.slice(config.headLines, lines.length - config.tailLines)

  const sampled = []
  for (let i = 0; i < middle.length; i += config.sampleInterval) {
    const originalIndex = config.headLines + i
    sampled.push(`${originalIndex + 1}\t${middle[i]}`)
  }

  const numbered = (lines2, start) => lines2.map((line, i) => `${start + i + 1}\t${line}`)
  const headNumbered = numbered(head, 0)
  const tailNumbered = numbered(tail, lines.length - tail.length)

  return [
    `[dsh-token-optimizer outputLadder: ${lines.length} lines total; sampled view = head ${config.headLines} lines + evenly spaced ${sampled.length} lines + tail ${config.tailLines} lines]`,
    ...headNumbered,
    ...sampled,
    ...tailNumbered,
  ].join('\n')
}

export function createOutputLadderModule(ctx, config, stats) {
  const listeners = []
  if (typeof ctx?.on !== 'function') return () => {}

  const readTools = new Set(config.readTools ?? [])
  const shellTools = new Set(config.shellTools ?? [])

  const handler = async (exec, result, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'accept') return decision

    // 1) read-type tools are exempt: first read kept in full; repeated reads are fileDiff's job
    if (readTools.has(exec?.name)) return decision

    // T7 (layer-order-sensitive): use decision.content ?? result.content as the baseline --
    // this plugin sits toward the inner layers of the profile bundles, and outer handlers (better-edit/spill-policy, etc.)
    // may already have rewritten content; taking the baseline from decision avoids clobbering inner rewrites.
    // The return must spread decision: it keeps downstream fields such as additionalContexts (on the accept path
    // the kernel concatenates result and decision contexts, result first).
    const blocks = decision.content ?? result?.content
    const text = toText(blocks)
    // 2) no text blocks
    if (text.length === 0) return decision

    let replacement = null
    let branch = null

    // 3) error results: summarize (must be first; error text is often a very long traceback)
    if (result?.isError === true) {
      replacement = summarizeError(text, config.errorSummaryChars)
      branch = 'error'
    }

    // 4) structure-aware compression (JSON array/CSV), before the byte check: after compression spill will not intervene again
    if (!replacement && text.length >= config.structureThreshold) {
      replacement = compressJsonArray(text, config) ?? compressCsv(text, config)
      branch = 'structured'
    }

    // 5) >= spillBytes: leave it to the core spill (the chain's outermost fallback); do not duplicate it
    if (!replacement && Buffer.byteLength(text, 'utf8') >= config.spillBytes) {
      stats?.bump('ladder.spillSkip', 1)
      return decision
    }

    // 6) shell-type tool output sampling
    if (!replacement && shellTools.has(exec?.name) && text.length >= config.shellThreshold) {
      replacement = sampleShell(text, config)
      branch = 'shell'
    }

    if (!replacement || replacement.length >= text.length) return decision

    // Save the original to disk (reversible); the marker carries the original path
    let marker
    if (config.saveOriginal) {
      const savedFile = saveOriginal(exec, text)
      marker = savedFile ? `(original data: ${savedFile})` : '(original data not saved to disk)'
    } else {
      marker = '(saveOriginal off)'
    }
    const final = `${replacement}\n\n[processed by dsh-token-optimizer outputLadder.${branch} ${marker}]`

    const savedChars = text.length - final.length
    if (savedChars <= 0) return decision

    stats?.bump(`ladder.${branch === 'error' ? 'errors' : branch}`, 1)
    stats?.bump('ladder.savedChars', savedChars)
    stats?.addSample({ module: 'outputLadder', tool: exec?.name, branch, savedChars })

    // T7: spread decision to pass through additionalContexts etc.; content is rebuilt from the baseline
    return {
      ...decision,
      content: foldTextBlocks(blocks, final),
    }
  }

  ctx.on('tools/post-execute', handler)
  listeners.push(() => ctx.off('tools/post-execute', handler))
  return () => {
    for (const off of listeners) off()
  }
}

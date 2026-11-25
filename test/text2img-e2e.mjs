// text2img real end-to-end check (needs the DEEPSEEK_API_KEY environment variable and consumes a small amount of API credit)
// usage: node test/text2img-e2e.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { createStats } from '../src/stats.js'
import { createText2imgModule } from '../src/modules/text2img.js'

function makeFakeCtx() {
  const handlers = new Map()
  return {
    on(event, handler) { handlers.set(event, handler) },
    off(event, handler) { if (handlers.get(event) === handler) handlers.delete(event) },
    async emit(event, ...args) {
      const h = handlers.get(event)
      if (!h) throw new Error(`no handler for ${event}`)
      return h(...args)
    },
  }
}

// generate 6000+ characters of natural-language text (above the default threshold 5000)
let text = ''
for (let i = 1; i <= 60; i++) {
  text += `part ${i} : this is natural-language content for the end-to-end check of the long-text-to-image feature.`
  text += ` We are testing whether the DeepSeek vision model can accurately read the text rendered in images.`
  text += `key number marker: part ${i}. The end.\n`
}
console.log(`test text length: ${text.length} characters`)

const ctx = makeFakeCtx()
const stats = createStats()
const cfg = resolveConfig({})
createText2imgModule(ctx, cfg.text2img, stats)

const next = async () => ({ kind: 'enter', messages: [{ role: 'user', content: text }] })
console.log('trigger agent/pre-step...')
const decision = await ctx.emit('agent/pre-step', { signal: {} }, next)

const replaced = decision.messages[0].content
console.log('--- replaced content (first 400 characters) ---')
console.log(replaced.slice(0, 400))
console.log('---')
const saved = text.length - replaced.length
console.log(`original: ${text.length} characters -> replaced: ${replaced.length} characters -> saved: ${saved} characters (${(saved / text.length * 100).toFixed(1)}%)`)
console.log(`stats: ${JSON.stringify(stats.snapshot().counters)}`)

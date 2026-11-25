// real-machine verification of the text2img render chain (needs a normal terminal / real-machine permissions)
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/render-text.ps1', import.meta.url))
console.log('render script:', script)
const text = 'part 1 :this is real-environment render-test content.'.repeat(300)
const out = join(tmpdir(), `t2i-live-${Date.now()}.png`)
console.log('out:', out)
console.log('text chars:', text.length)

const child = spawn('powershell', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
  '-text', text, '-outPath', out, '-width', '1200', '-fontSize', '16',
], { windowsHide: true })

let stderr = ''
child.stderr.on('data', (d) => { stderr += d })
child.on('error', (e) => { console.log('SPAWN ERROR:', e.message) })
child.on('close', (code) => {
  console.log('close code:', code)
  console.log('stderr:', stderr.slice(0, 300))
  console.log('png exists:', existsSync(out), existsSync(out) ? `${statSync(out).size} bytes` : '')
})

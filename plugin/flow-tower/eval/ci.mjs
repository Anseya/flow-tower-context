#!/usr/bin/env node
/**
 * Local CI: unit tests + offline/relations/real-session evals (if fixtures exist).
 * Run: node eval/ci.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const steps = [
  ['unit tests', ['--test', 'test/flow-tower.test.js', 'test/apply.test.js', 'test/manager.test.js']],
  ['offline eval', ['eval/offline-eval.mjs']],
  ['relations bench', ['eval/relations-bench.mjs', '--entries=1000', '--edges=5000', '--queries=50']],
]
if (existsSync(join(root, 'eval', 'real-session-eval.mjs'))) steps.push(['real-session eval (optional)', ['eval/real-session-eval.mjs']])
let failed = false
for (const [name, args] of steps) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', timeout: 120000 })
  if (result.status !== 0) {
    process.stdout.write(`\nCI step failed: ${name}\n`)
    failed = true
    if (name !== 'real-session eval (optional)') break
  }
}
process.exitCode = failed ? 1 : 0

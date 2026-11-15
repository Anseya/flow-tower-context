/**
 * Long-session stress harness for the dictionary compiler.
 *
 * It is intentionally Host-independent: it drives the real Compiler + SQLite
 * store with a synthetic long session, then forces memory pressure to prove the
 * persisted deferred queue survives and is replayed on the next compile.
 *
 * Run:
 *   node eval/stress-long-session.mjs --rounds 300
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { FlowStore } from '../lib/store.js'
import { resolveConfig } from '../lib/config.js'
import { Compiler } from '../lib/compiler.js'
import { buildDigest } from '../lib/catalog.js'
import { createFakeSession } from '../test/fixtures.js'

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? Number(process.argv[index + 1]) : fallback
}
const rounds = Math.max(20, Math.min(5000, arg('rounds', 300)))
const project = mkdtempSync(join(tmpdir(), 'flow-tower-stress-'))
const dbPath = join(project, '.flow-tower', 'flow_tower.db')
const session = createFakeSession({ id: 'session-stress', cwd: project })
const base = resolveConfig({ storageMode: 'project', resourceProfile: 'off', memoryGuard: false, maxEntries: 6000 })
const store = FlowStore.open({ dbPath })
const log = { info() {}, warn(message) { if (process.env.FT_STRESS_VERBOSE) console.warn(message) } }
const compiler = new Compiler({ store, config: base, log })

function addEvidence(round) {
  const seqs = []
  seqs.push(session.addUser(`第 ${round} 轮：保持在 plugin/flow-tower/lib/compiler.js 中修复 deferred 队列，并记录决策。`))
  seqs.push(session.addAssistant(`修改 src/compiler-${round % 17}.js，任务 task-${round % 31} 完成；错误 ERR_${round % 13} 已修复。`))
  seqs.push(session.addToolResult(`src/module-${round % 23}.ts: 编辑成功，TODO：补充 stress 回归。`))
  return seqs
}

function ingestRound(index) {
  const seqs = addEvidence(index)
  compiler.ingest(session, {
    type: 'compaction/summary',
    seq: session.events.length,
    time: 1_760_000_000_000 + index * 60_000,
    data: {
      compactionId: `compaction-${index}`,
      summary: [{ type: 'text', text: `第 ${index} 轮压缩摘要：修复 compiler deferred 队列与项目记忆注入。` }],
      shadowedSeqs: seqs,
    },
  })
}

const rssStart = process.memoryUsage().rss
const started = performance.now()
for (let index = 0; index < rounds; index += 1) ingestRound(index)
await compiler.drain()
const elapsedMs = performance.now() - started
const rssAfter = process.memoryUsage().rss
const volumes = store.listVolumes({ limit: 10 })
const digest = buildDigest(store, session.id, base)
const result = {
  rounds,
  events: session.events.length,
  elapsedMs: Math.round(elapsedMs),
  rssStartBytes: rssStart,
  rssAfterBytes: rssAfter,
  rssGrowthBytes: rssAfter - rssStart,
  dbBytes: statSync(dbPath).size,
  entries: volumes.reduce((sum, item) => sum + item.entryCount, 0),
  digestChars: digest.length,
  deferredSeqs: store.countAllDeferredSeqs(),
  ok: true,
}

// Pressure path: force the guard, write new evidence, and confirm the queue is
// persisted rather than kept only in the process.
const pressure = new Compiler({
  store,
  config: { ...base, memoryGuard: true, maxRssBytes: 1 },
  log,
})
const pressureSeqs = addEvidence(rounds + 1)
pressure.ingest(session, {
  type: 'compaction/summary',
  seq: session.events.length,
  time: 1_760_000_000_000 + (rounds + 1) * 60_000,
  data: {
    compactionId: `compaction-pressure-${rounds + 1}`,
    summary: [{ type: 'text', text: 'pressure round' }],
    shadowedSeqs: pressureSeqs,
  },
})
await pressure.drain()
result.deferredAfterPressure = store.countAllDeferredSeqs()
result.deferredPersisted = result.deferredAfterPressure > 0

// Recovery: a fresh Compiler with the guard off must replay the pending seqs.
const recovery = new Compiler({
  store,
  config: { ...base, memoryGuard: false },
  log,
})
recovery.ingest(session, {
  type: 'compaction/summary',
  seq: session.events.length,
  time: 1_760_000_000_000 + (rounds + 2) * 60_000,
  data: {
    compactionId: `compaction-recovery-${rounds + 2}`,
    summary: [{ type: 'text', text: 'recovery round' }],
    shadowedSeqs: [],
  },
})
await recovery.drain()
result.deferredAfterRecovery = store.countAllDeferredSeqs()
result.deferredReplayed = result.deferredAfterPressure > 0 && result.deferredAfterRecovery === 0
result.ok = result.deferredPersisted && result.deferredReplayed
result.volumes = volumes.length

store.close()
rmSync(project, { recursive: true, force: true })
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1

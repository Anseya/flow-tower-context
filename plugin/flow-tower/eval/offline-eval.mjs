#!/usr/bin/env node
/**
 * Offline evaluation harness for the flow-tower dictionary.
 *
 * It builds a synthetic session with 20 known facts, compiles it through the
 * real observation-only compiler, then answers 20 queries using the real
 * `dict_lookup` + `dict_cite` tool definitions. Metrics mirror the design's
 * acceptance criteria (design/flow-tower/05-择优而用-取舍录.md §11-4):
 *
 * - hitRate: lookup found a definition for the queried headword
 * - avgCalls: tool calls per answered question (target <= 2)
 * - citeFidelity: the cited raw replay contains the expected evidence
 * - digestTokens: size of the per-session digest
 *
 * Run: node eval/offline-eval.mjs [--json]
 * Exit code 1 when a threshold fails, so CI can gate on it.
 */

import { resolveConfig } from '../lib/config.js'
import { FlowStore } from '../lib/store.js'
import { Compiler } from '../lib/compiler.js'
import { buildDigest } from '../lib/catalog.js'
import { buildToolDefinitions } from '../lib/tools.js'
import { estimateTokens } from '../lib/util.js'
import { createFakeSession, createNoopLogger } from '../test/fixtures.js'

const THRESHOLDS = { hitRate: 0.9, avgCalls: 2.1, citeFidelity: 0.9 }

/**
 * Build the synthetic conversation + 20 questions.
 * @returns {{ session: any, seqs: number[], questions: { term: string, expected: string }[] }}
 */
function buildCorpus() {
  const session = createFakeSession({ id: 'eval-session', cwd: 'E:/eval/demo' })
  const seqs = []
  const questions = []

  for (let index = 0; index < 8; index += 1) {
    const path = `src/feature-${index}.ts`
    seqs.push(session.addAssistant(`Edited file ${path} successfully; it exports feature${index}().`))
    questions.push({ term: path, expected: path })
  }
  for (let index = 0; index < 6; index += 1) {
    const plan = `方案A${index}`
    seqs.push(session.addUser(`决定采用${plan}。`))
    questions.push({ term: `决定采用${plan}`, expected: plan })
  }
  for (let index = 0; index < 4; index += 1) {
    const code = `ERR_TEST_${index}`
    seqs.push(session.addToolResult(`failure ${code} occurred while running the suite.`))
    questions.push({ term: code, expected: code })
  }
  for (let index = 0; index < 2; index += 1) {
    const command = `npm run test-${index}`
    seqs.push(session.addAssistant(`$ ${command}`))
    questions.push({ term: command, expected: command })
  }
  // Feature dimension: capability units extracted from intent phrases.
  const features = ['实现登录功能', '支持离线缓存', '修复时间轴排序']
  for (const phrase of features) {
    seqs.push(session.addUser(`${phrase}，记录到项目词典。`))
    questions.push({ term: phrase, expected: phrase.replace(/^(实现|支持|修复)/, '') })
  }
  // Task dimension: one open item and one done item (unrelated words, so closure
  // matching must NOT close the open one).
  const openTask = 'TODO: 补齐时间轴评测'
  const doneTask = '任务已完成：登录页样式修复'
  seqs.push(session.addUser(`${openTask}。`))
  seqs.push(session.addAssistant(`${doneTask}。`))
  questions.push({ term: openTask, expected: '时间轴评测' })
  questions.push({ term: doneTask, expected: '登录页样式' })
  return { session, seqs, questions, openTask, doneTask }
}

/**
 * @param {{ term: string, expected: string }} question
 * @param {{ lookup: any, cite: any, exec: any }} tools
 * @returns {Promise<{ hit: boolean, calls: number, fidelity: boolean, citeId: string | null }>}
 */
async function answerQuestion(question, tools) {
  let calls = 0
  const lookup = await tools.lookup.execute({ term: question.term }, tools.exec)
  calls += 1
  const hit = /Definition:/.test(lookup.text)
  const citeId = lookup.text.match(/c_[0-9a-f]+/)?.[0] ?? null
  if (citeId === null) return { hit, calls, fidelity: false, citeId }
  const cite = await tools.cite.execute({ cite_id: citeId }, tools.exec)
  calls += 1
  const fidelity = cite.text.includes(question.expected)
  return { hit, calls, fidelity, citeId }
}

async function main() {
  const startedAt = Date.now()
  const config = resolveConfig()
  const store = FlowStore.open({ dbPath: ':memory:' })
  const compiler = new Compiler({ store, config, log: createNoopLogger() })
  const { session, seqs, questions, openTask } = buildCorpus()

  compiler.ingest(session, session.addCompaction({
    compactionId: 'eval-cmp-1',
    seqs,
    summary: '合成评测会话：包含文件、决定、错误与命令四类事实。',
  }))
  await compiler.drain()

  const volume = store.getVolume(session.id)
  const tools = buildToolDefinitions({ ctx: { get: () => undefined }, store, config, log: createNoopLogger() })
  const exec = { agent: { session }, signal: new AbortController().signal }
  const toolSet = { lookup: tools[1], cite: tools[2], timeline: tools[3], exec }
  const timeline = await toolSet.timeline.execute({ volume: session.id }, exec)
  const timelineLines = timeline.text.split('\n').filter((line) => line.startsWith('- '))
  const openTasks = store.openTasks(session.id, 50)
  const modules = store.recentModules(session.id, 10)

  const results = []
  for (const question of questions) {
    // eslint-disable-next-line no-await-in-loop
    results.push({ ...(await answerQuestion(question, toolSet)), question })
  }

  const answered = results.length
  const hitRate = results.filter((result) => result.hit).length / answered
  const citeFidelity = results.filter((result) => result.fidelity).length / answered
  const avgCalls = results.reduce((sum, result) => sum + result.calls, 0) / answered
  const digestText = buildDigest(store, session.id, config)

  const report = {
    volume: {
      entryCount: volume?.entryCount ?? 0,
      kinds: store.countByKind(session.id),
      version: volume?.version ?? 0,
      project: volume?.project ?? '',
    },
    questions: answered,
    hitRate: Number(hitRate.toFixed(3)),
    citeFidelity: Number(citeFidelity.toFixed(3)),
    avgCalls: Number(avgCalls.toFixed(2)),
    digestTokens: estimateTokens(digestText),
    taskOpen: openTasks.length,
    taskOpenHasExpected: openTasks.some((entry) => entry.headword.includes(openTask)),
    timelineEntries: timelineLines.length,
    modules: modules.length,
    thresholds: THRESHOLDS,
    failures: results.filter((result) => !result.hit || !result.fidelity).map((result) => ({
      term: result.question.term,
      expected: result.question.expected,
      hit: result.hit,
      fidelity: result.fidelity,
    })),
    elapsedMs: Date.now() - startedAt,
  }

  const failed = hitRate < THRESHOLDS.hitRate
    || citeFidelity < THRESHOLDS.citeFidelity
    || avgCalls > THRESHOLDS.avgCalls
    || openTasks.length < 1
    || timelineLines.length < 5

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`flow-tower offline eval: ${failed ? 'FAIL' : 'PASS'}\n`)
    process.stdout.write(`  entries=${report.volume.entryCount} kinds=${JSON.stringify(report.volume.kinds)}\n`)
    process.stdout.write(`  hitRate=${report.hitRate} citeFidelity=${report.citeFidelity} avgCalls=${report.avgCalls} digestTokens=${report.digestTokens}\n`)
    process.stdout.write(`  project=${report.volume.project} openTasks=${report.taskOpen} timelineEntries=${report.timelineEntries} modules=${report.modules}\n`)
    for (const failure of report.failures) {
      process.stdout.write(`  - ${failure.term}: hit=${failure.hit} fidelity=${failure.fidelity}\n`)
    }
  }

  store.close()
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => {
  console.error('flow-tower offline eval crashed:', error)
  process.exitCode = 2
})

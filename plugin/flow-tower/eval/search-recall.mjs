#!/usr/bin/env node
/**
 * Offline search-recall eval: lexical vs sparse-semantic vs hybrid.
 *
 * It compiles one synthetic session, then asks recall-style queries that are NOT
 * the exact headword (truncated headwords, gloss fragments and zh<->en pairs).
 * For every query the expected entry must appear in the top-5; exact-headword
 * queries stay as a sanity baseline. No network, no model.
 *
 * Run: node eval/search-recall.mjs [--json]
 * Exit code 1 when hybrid recall is below the lexical baseline.
 */

import { resolveConfig } from '../lib/config.js'
import { FlowStore } from '../lib/store.js'
import { Compiler } from '../lib/compiler.js'
import { semanticSearch } from '../lib/semantic.js'
import { hybridSearch } from '../lib/hybrid-search.js'
import { createFakeSession, createNoopLogger } from '../test/fixtures.js'

const TOP_K = 5
const THRESHOLDS = { exact: 0.95, gloss: 0.5, hybridVsLexical: 0 }

/** @returns {{ session: any, seqs: number[] }} */
function buildCorpus() {
  const session = createFakeSession({ id: 'search-eval', cwd: 'E:/eval/search' })
  const seqs = []
  const add = (seq) => { seqs.push(seq); return seq }
  const projectFacts = [
    ['决定采用缓存压缩策略，检索层保持 BM25。', 'user'],
    ['已更新 src/cache.ts 与 src/search.ts；缓存淘汰策略使用 LRU。', 'assistant'],
    ['ERR_CACHE_MISS occurred while 检索 缓存 索引 回放。', 'tool'],
    ['TODO: 优化检索召回与时间轴缓存。', 'user'],
    ['实现上下文记忆的摘要注入与关系图。', 'user'],
    ['compaction summary is compiled into a dictionary with citations.', 'assistant'],
    ['向量嵌入暂时关闭，语义召回使用稀疏 TF-IDF 与共现扩展。', 'user'],
    ['前端搜索面板支持语义与智能检索。', 'user'],
  ]
  for (const [text, role] of projectFacts) {
    if (role === 'user') add(session.addUser(text))
    else if (role === 'assistant') add(session.addAssistant(text))
    else add(session.addToolResult(text))
  }
  for (let index = 0; index < 4; index += 1) {
    add(session.addAssistant(`编辑 src/module-${index}.ts 成功，导出 feature${index}()。`))
  }
  return { session, seqs }
}

/**
 * @param {any[]} entries
 * @param {number} limit
 * @returns {any[]}
 */
function sample(entries, limit) {
  if (entries.length <= limit) return entries.slice()
  const out = []
  const step = Math.max(1, Math.floor(entries.length / limit))
  for (let index = 0; index < entries.length && out.length < limit; index += step) out.push(entries[index])
  return out
}

const CROSS_PAIRS = [
  ['缓存', 'cache'], ['压缩', 'compaction'], ['上下文', 'context'], ['记忆', 'memory'],
  ['检索', 'search'], ['摘要', 'summary'], ['关系', 'relation'], ['注入', 'inject'],
]

/**
 * @param {any} store
 * @param {string} volumeId
 * @param {any[]} entries
 * @returns {{ query: string, expectedId: string, type: string }[]}
 */
function buildQueries(store, volumeId, entries) {
  const queries = []
  for (const entry of sample(entries, 24)) {
    queries.push({ query: entry.headword, expectedId: entry.entryId, type: 'exact' })
    const head = String(entry.headword ?? '').trim()
    if (head.length >= 5) {
      queries.push({ query: head.slice(0, head.length - 1), expectedId: entry.entryId, type: 'truncated' })
    }
    const gloss = String(entry.gloss ?? '').trim()
    if (gloss.length >= 8) {
      queries.push({ query: gloss.slice(0, 8), expectedId: entry.entryId, type: 'gloss' })
    }
    const text = `${entry.headword} ${entry.gloss}`
    for (const [zh, en] of CROSS_PAIRS) {
      if (text.includes(zh) && !text.toLowerCase().includes(en)) {
        queries.push({ query: en, expectedId: entry.entryId, type: 'cross' })
      } else if (text.toLowerCase().includes(en) && !text.includes(zh)) {
        queries.push({ query: zh, expectedId: entry.entryId, type: 'cross' })
      }
    }
  }
  // De-duplicate identical query strings while keeping the first expectation.
  const seen = new Set()
  return queries.filter((item) => {
    const key = `${item.type}:${item.query}:${item.expectedId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * @param {{ results: any[] }} output
 * @param {string} expectedId
 * @returns {boolean}
 */
function hitAtK(output, expectedId) {
  return output.results.slice(0, TOP_K).some((hit) => hit.entry?.entryId === expectedId)
}

/**
 * @param {string} query
 * @param {any} store
 * @param {string} volumeId
 * @param {'lexical' | 'semantic' | 'hybrid'} mode
 * @param {number} limit
 * @returns {{ results: any[] }}
 */
function search(query, store, volumeId, mode, limit) {
  if (mode === 'semantic') return { results: semanticSearch(store, query, { volumeId, limit }) }
  if (mode === 'hybrid') return hybridSearch(store, query, { volumeId, limit })
  return { results: store.searchRanked(query, { volumeId, limit }) }
}

async function main() {
  const startedAt = Date.now()
  const config = resolveConfig()
  const store = FlowStore.open({ dbPath: ':memory:' })
  const compiler = new Compiler({ store, config, log: createNoopLogger() })
  const { session, seqs } = buildCorpus()
  compiler.ingest(session, session.addCompaction({
    compactionId: 'search-eval-cmp',
    seqs,
    summary: '检索召回评测：缓存、压缩、上下文、语义与关系。',
  }))
  await compiler.drain()
  const volume = store.getVolume(session.id)
  if (volume === null) throw new Error('compile produced no volume')
  const entries = store.listEntries(session.id, { limit: 1000 })
    .filter((entry) => String(entry.headword ?? '').length >= 3)
  const queries = buildQueries(store, session.id, entries)
  const modes = ['lexical', 'semantic', 'hybrid']
  const byType = {}
  const overall = {}
  for (const mode of modes) {
    overall[mode] = { hits: 0, total: 0 }
    byType[mode] = {}
    for (const item of queries) {
      const ok = hitAtK(search(item.query, store, session.id, mode, 10), item.expectedId)
      const bucket = byType[mode][item.type] ?? (byType[mode][item.type] = { hits: 0, total: 0 })
      bucket.total += 1
      overall[mode].total += 1
      if (ok) { bucket.hits += 1; overall[mode].hits += 1 }
    }
  }
  const rate = (bucket) => (bucket.total === 0 ? null : Number((bucket.hits / bucket.total).toFixed(3)))
  const report = {
    entries: entries.length,
    queries: queries.length,
    topK: TOP_K,
    overall: Object.fromEntries(modes.map((mode) => [mode, rate(overall[mode])])),
    byType: Object.fromEntries(modes.map((mode) => [
      mode,
      Object.fromEntries(Object.entries(byType[mode]).map(([type, bucket]) => [type, rate(bucket)])),
    ])),
    elapsedMs: Date.now() - startedAt,
  }
  if (process.argv.includes('--failures')) {
    for (const item of queries) {
      const results = search(item.query, store, session.id, 'hybrid', 10).results
      const rank = results.findIndex((hit) => hit.entry?.entryId === item.expectedId)
      if (rank >= 0 && rank < TOP_K) continue
      const lexicalResults = search(item.query, store, session.id, 'lexical', 10).results
      const lexicalRank = lexicalResults.findIndex((hit) => hit.entry?.entryId === item.expectedId)
      const expected = store.getEntry(item.expectedId)?.headword
      process.stdout.write(`  MISS ${item.type} query=${JSON.stringify(item.query)} expected=${JSON.stringify(expected)} lexicalRank=${lexicalRank} hybridRank=${rank}\n`)
      process.stdout.write(`    top=${JSON.stringify(results.slice(0, 5).map((hit) => hit.entry?.headword))}\n`)
    }
  }
  const exact = report.byType.hybrid.exact ?? 0
  const gloss = report.byType.hybrid.gloss ?? 0
  const hybrid = report.overall.hybrid ?? 0
  const lexical = report.overall.lexical ?? 0
  report.pass = exact >= THRESHOLDS.exact && gloss >= THRESHOLDS.gloss && hybrid >= lexical
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`flow-tower search recall: ${report.pass ? 'PASS' : 'FAIL'}\n`)
    process.stdout.write(`  entries=${report.entries} queries=${report.queries} topK=${TOP_K}\n`)
    process.stdout.write(`  overall lexical=${report.overall.lexical} semantic=${report.overall.semantic} hybrid=${report.overall.hybrid}\n`)
    for (const type of Object.keys(report.byType.hybrid)) {
      process.stdout.write(`  - ${type}: lexical=${report.byType.lexical[type]} semantic=${report.byType.semantic[type]} hybrid=${report.byType.hybrid[type]}\n`)
    }
  }
  store.close()
  process.exitCode = report.pass ? 0 : 1
}

main().catch((error) => {
  console.error('search-recall eval crashed:', error)
  process.exitCode = 2
})

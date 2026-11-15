/**
 * Offline test suite: exercises the whole plugin without a Harness process.
 * Run with the bundled Node: `node --test test/`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { FlowStore } from '../lib/store.js'
import { extractCandidates, deriveModule } from '../lib/extract.js'
import { runMaintenance } from '../lib/maintenance.js'
import { WARN_LINES, moduleDebt } from '../lib/code-health.js'
import { adaptDigestBudget } from '../lib/adaptive-budget.js'
import { classifyTask, detectCheckpoint, resolveInjectionPlan } from '../lib/injection-policy.js'
import { entryIdFor, ingestCandidates, normHeadword } from '../lib/vocabulary.js'
import { Compiler } from '../lib/compiler.js'
import { browseText, buildDigest, buildLegend, buildSharedDigest, lookupText, timelineText, treeText } from '../lib/catalog.js'
import { lastSummarizeRun } from '../lib/web-common.js'
import { renderSeqRange } from '../lib/raw.js'
import { projectEventMessage, readSessionEvents, renderEvents, sampleFromEvents } from '../lib/session-read.js'
import { buildToolDefinitions } from '../lib/tools.js'
import { clampTokens, estimateTokens, normalizeProjectPath, retryBusy } from '../lib/util.js'
import { createFakeSession, createNoopLogger, seedConversation } from './fixtures.js'
import { StoreManager } from '../lib/manager.js'
import { dbPathForProject } from '../lib/manager.js'
import { processProposals, proposalsDir } from '../lib/proposals.js'
import { buildApiPayload, createWebHandler, closeTask, handleWritePayload } from '../lib/web.js'
import { semanticSearch } from '../lib/semantic.js'
import { hybridSearch } from '../lib/hybrid-search.js'
import { rebuildSummaryTree, summaryTreeText } from '../lib/summary.js'
import { buildProposalPrompt, generateProposalsFromText, parseProposalJson, writeProposal } from '../tools/propose-agent.mjs'
import {
  addRelation, canonicalType, exportGraph, findCycles, importGraph, incoming, nodeIdForEntry,
  nodeIdForHost, nodeIdForVolume, outgoing, rollbackBatch, syncRelations, validateRelations,
} from '../lib/relations.js'
import { withLock } from '../lib/lock.js'
import { createHostModelCaller } from '../lib/llm.js'
import { mergeProjects } from '../tools/merge-projects.mjs'

/** Windows may hold the just-closed SQLite WAL handle briefly. */
function rmWithRetry(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      const until = Date.now() + 25
      while (Date.now() < until) { /* short spin */ }
    }
  }
}

/** @returns {{ store: FlowStore, config: any }} */
function freshStore() {
  const config = resolveConfig()
  const store = FlowStore.open({ dbPath: ':memory:' })
  return { store, config }
}

test('config: defaults resolve and invalid values fail fast', () => {
  const config = resolveConfig()
  assert.equal(config.nodeBudgetTokens, 2400)
  assert.equal(config.digestMode, 'on-change')
  assert.equal(config.adaptiveDigestBudget, true)
  assert.throws(() => resolveConfig({ adaptiveDigestBudget: 'yes' }), /adaptiveDigestBudget/)
  assert.throws(() => resolveConfig({ maxEntries: 0 }), /positive safe integer/)
  assert.throws(() => resolveConfig({ digestMode: 'always' }), /digestMode/)
  assert.throws(() => resolveConfig({ glossTokens: 5000, nodeBudgetTokens: 900 }), /glossTokens/)
})

test('util: token estimate and clamp are monotonic and bounded', () => {
  assert.ok(estimateTokens('hello world') > 0)
  assert.ok(estimateTokens('你好世界') >= 4)
  const clamped = clampTokens('a'.repeat(4000), 10)
  assert.ok(estimateTokens(clamped) <= 12)
  assert.ok(clamped.endsWith('…'))
})

test('extract: deterministic rules find files, commands, errors, decisions, tasks, symbols', () => {
  const text = [
    '我们决定采用观察式接入，不替换 compaction。',
    '请修改 plugin/flow-tower/index.js 并运行 `node --test`。',
    '错误 ERR_MODULE_NOT_FOUND 已修复；TODO: add router view.',
    '已更新 `buildToolDefinitions()`。',
    'git status --short',
  ].join('\n')
  const candidates = extractCandidates([{ seq: 1, role: 'assistant', text }])
  const kinds = new Set(candidates.map((candidate) => candidate.kind))
  for (const expected of ['file', 'command', 'error', 'decision', 'task', 'api-symbol']) {
    assert.ok(kinds.has(expected), `missing kind ${expected}: ${JSON.stringify([...kinds])}`)
  }
  const file = candidates.find((candidate) => candidate.kind === 'file')
  assert.match(file.headword, /plugin\/flow-tower\/index\.js/)
  const task = candidates.find((candidate) => candidate.kind === 'task')
  assert.ok(task !== undefined)
  assert.ok(!/^TODO/i.test(task.headword), `task headword should be cleaned: ${task.headword}`)
  // system messages never produce candidates
  const none = extractCandidates([{ seq: 2, role: 'system', text }])
  assert.equal(none.length, 0)
})

test('extract: source role and self-reference gate noisy tasks', () => {
  // Our own injected digest re-enters the conversation via tool output; it must
  // never be mined back into entries.
  const selfDigest = [
    '[flow-tower] Project map · demo',
    'Open: stats --- chars 2698 estTokens 675 line 237 Goal: Build a DS…',
    'Modules:',
  ].join('\n')
  assert.equal(extractCandidates([{ seq: 1, role: 'tool', text: selfDigest }]).length, 0)

  // Assistant "next step" advice is not an open task.
  const advice = extractCandidates([{ seq: 2, role: 'assistant', text: '下一步仍然需要你空闲时按一次 `/compact`。' }])
  assert.ok(!advice.some((candidate) => candidate.kind === 'task'), JSON.stringify(advice))

  // Tool output cannot mint tasks from numbering/headings.
  const tool = extractCandidates([{ seq: 3, role: 'tool', text: '## 四、建议下一步 1. 然后执行 npm run build' }])
  assert.ok(!tool.some((candidate) => candidate.kind === 'task'), JSON.stringify(tool))

  // A real TODO marker in code shown by a tool result is still a work item.
  const code = extractCandidates([{ seq: 4, role: 'tool', text: '// TODO: add router view.' }])
  const todo = code.find((candidate) => candidate.kind === 'task')
  assert.ok(todo !== undefined, JSON.stringify(code))
  assert.equal(todo.headword, 'add router view.')

  // User requests still create tasks.
  const user = extractCandidates([{ seq: 5, role: 'user', text: '下一步要修复注入链路的 compact 记录。' }])
  assert.ok(user.some((candidate) => candidate.kind === 'task'), JSON.stringify(user))
})

test('store: volumes, entries, citations, coverage and idempotent runs', () => {
  const { store } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 's1', scope: 'project:E:/demo', now })
  assert.equal(store.getVolume('s1').version, 0)

  const norm = normHeadword('file', 'src/a.ts')
  store.insertEntry({
    entryId: entryIdFor('s1', norm),
    volumeId: 's1',
    kind: 'file',
    headword: 'src/a.ts',
    headwordNorm: norm,
    gloss: 'the entry file',
    createdAt: now,
    updatedAt: now,
  })
  store.addEntryCount('s1', 1, now)
  assert.equal(store.findEntryByWord('s1', norm).headword, 'src/a.ts')
  assert.equal(store.countEntries('s1'), 1)

  const entryId = store.findEntryByWord('s1', norm).entryId
  const inserted = store.insertCitation({
    citeId: 'c_1', entryId, sessionId: 's1', seqStart: 5, seqEnd: 5, excerpt: 'x', createdAt: now,
  })
  assert.equal(inserted, true)
  const duplicate = store.insertCitation({
    citeId: 'c_1b', entryId, sessionId: 's1', seqStart: 5, seqEnd: 5, excerpt: 'x', createdAt: now,
  })
  assert.equal(duplicate, false)
  assert.equal(store.citationCount(entryId), 1)
  assert.deepEqual([...store.coveredSeqs('s1')], [5])

  assert.equal(store.beginRun({ runId: 'r1', volumeId: 's1', compactionId: 'c1', deltaHash: 'h1' }), true)
  assert.equal(store.beginRun({ runId: 'r1b', volumeId: 's1', compactionId: 'c1', deltaHash: 'h1' }), false)

  assert.throws(() => store.transaction(() => {
    store.ensureVolume({ volumeId: 's2' })
    throw new Error('boom')
  }), /boom/)
  assert.equal(store.getVolume('s2'), null)
  store.close()
})

test('vocabulary: one entry per normalized headword, citations dedupe', () => {
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 's1', now })
  const options = {
    volumeId: 's1',
    sessionId: 's1',
    now,
    config,
  }
  const first = ingestCandidates(store, {
    ...options,
    candidates: [
      { kind: 'file', headword: 'src/a.ts', gloss: 'first gloss', seq: 1 },
      { kind: 'file', headword: 'src/a.ts', gloss: 'another gloss', seq: 2 },
    ],
  })
  assert.equal(first.created, 1)
  // Same headword in the same batch is deduped before insert.
  assert.equal(store.countEntries('s1'), 1)

  const second = ingestCandidates(store, {
    ...options,
    candidates: [{ kind: 'file', headword: 'src/a.ts', gloss: 'longer and better gloss', seq: 3 }],
  })
  assert.equal(second.created, 0)
  assert.equal(second.citations, 1)
  const entry = store.findEntryByWord('s1', normHeadword('file', 'src/a.ts'))
  assert.equal(store.citationCount(entry.entryId), 2)
  assert.match(entry.gloss, /longer and better gloss/)
  store.close()
})

test('compiler: compaction summaries compile into entries; replays are idempotent', async () => {
  const { store, config } = freshStore()
  const log = createNoopLogger()
  const compiler = new Compiler({ store, config, log })
  const session = createFakeSession()
  const seqs = seedConversation(session)
  const event = session.addCompaction({ compactionId: 'cmp-1', seqs, summary: '我们决定采用观察式接入并修复了模块导入错误。' })

  compiler.ingest(session, event)
  await compiler.drain()

  const volume = store.getVolume(session.id)
  assert.ok(volume !== null)
  assert.ok(volume.entryCount >= 4, `expected several entries, got ${volume.entryCount}`)
  assert.ok(volume.version >= 1)
  assert.match(volume.abstract, /观察式接入/)
  const kinds = store.countByKind(session.id)
  assert.ok((kinds.file ?? 0) >= 1)
  assert.ok((kinds.error ?? 0) >= 1)
  assert.ok((kinds.decision ?? 0) >= 1)

  // Replaying the same compaction must not create anything new.
  const before = store.countEntries(session.id)
  const versionBefore = store.getVolume(session.id).version
  compiler.ingest(session, event)
  await compiler.drain()
  assert.equal(store.countEntries(session.id), before)
  assert.equal(store.getVolume(session.id).version, versionBefore)

  // A second compaction only compiles the new delta.
  const extra = session.addAssistant('新增约定：禁止修改 profile。相关文件 src/router.js。')
  const event2 = session.addCompaction({
    compactionId: 'cmp-2',
    seqs: [...seqs, extra],
    summary: '新增约定：禁止修改 profile。',
  })
  compiler.ingest(session, event2)
  await compiler.drain()
  assert.ok(store.getVolume(session.id).entryCount >= before)
  store.close()
})

test('catalog: digest is stable, browse/lookup render entries with citations', async () => {
  const { store, config } = freshStore()
  const compiler = new Compiler({ store, config, log: createNoopLogger() })
  const session = createFakeSession()
  const seqs = seedConversation(session)
  compiler.ingest(session, session.addCompaction({ compactionId: 'cmp-1', seqs, summary: '会话摘要。' }))
  await compiler.drain()

  const digest1 = buildDigest(store, session.id, config)
  const digest2 = buildDigest(store, session.id, config)
  assert.equal(digest1, digest2)
  assert.match(digest1, /flow-tower/)
  assert.ok(estimateTokens(digest1) <= config.digestBudgetTokens + 20)

  const browse = browseText(store, { volumeId: session.id, limit: 50 })
  assert.match(browse, /Dictionary volume/)
  assert.match(browse, /file/)

  const lookup = lookupText(store, {
    term: 'plugin/flow-tower/index.js',
    volumeId: session.id,
    now: Date.now(),
    maxCitationsPerEntry: config.maxCitationsPerEntry,
    glossTokens: config.glossTokens,
  })
  assert.match(lookup, /Definition:/)
  assert.match(lookup, /Citations:/)
  assert.match(lookup, /dict_cite/)
  assert.ok(lookup.includes('c_'), 'lookup should expose citation ids')

  const missing = lookupText(store, {
    term: 'definitely-not-in-dictionary-xyz',
    volumeId: session.id,
    now: Date.now(),
    maxCitationsPerEntry: config.maxCitationsPerEntry,
    glossTokens: config.glossTokens,
  })
  assert.match(missing, /No entry|No exact entry/)

  assert.match(buildLegend(), /flow-tower-dictionary/)
  store.close()
})

test('raw + tools: dict_cite replays verbatim source messages', async () => {
  const { store, config } = freshStore()
  const compiler = new Compiler({ store, config, log: createNoopLogger() })
  const session = createFakeSession()
  const seqs = seedConversation(session)
  compiler.ingest(session, session.addCompaction({ compactionId: 'cmp-1', seqs, summary: '摘要。' }))
  await compiler.drain()

  const direct = renderSeqRange(session, seqs, { maxTokens: 4000 })
  assert.match(direct.text, /plugin\/flow-tower\/index\.js/)
  assert.equal(direct.count, seqs.length)

  const ctx = { get: () => undefined }
  const tools = buildToolDefinitions({ ctx, store, config, log: createNoopLogger() })
  assert.deepEqual(tools.map((tool) => tool.name), ['dict_browse', 'dict_lookup', 'dict_cite', 'dict_timeline', 'dict_search', 'dict_relate'])
  const exec = { agent: { session }, signal: new AbortController().signal }

  const lookupTool = tools[1]
  const lookupResult = await lookupTool.execute(
    { term: 'plugin/flow-tower/index.js', volume: session.id },
    exec,
  )
  assert.match(lookupResult.text, /Definition:/)
  const citeId = lookupResult.text.match(/c_[0-9a-f]+/)?.[0]
  assert.ok(citeId, 'expected a citation id in lookup output')

  const citeTool = tools[2]
  const citeResult = await citeTool.execute({ cite_id: citeId }, exec)
  assert.match(citeResult.text, /citation c_/)
  assert.match(citeResult.text, /plugin\/flow-tower\/index\.js/)
  assert.match(citeResult.text, /user/)

  const unknown = await citeTool.execute({ cite_id: 'c_not_real' }, exec)
  assert.match(unknown.text, /Unknown citation id/)

  const browseResult = await tools[0].execute({ volume: session.id }, exec)
  assert.match(browseResult.text, /Dictionary volume/)
  store.close()
})

test('session-read: projects and renders events from a queried log', async () => {
  const events = [
    {
      seq: 0,
      type: 'system/message',
      time: 1000,
      data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } } },
    },
    {
      seq: 1,
      type: 'user/message',
      time: 2000,
      data: { role: 'user', content: [{ type: 'text', text: 'hello raw' }], source: { kind: 'user' } },
    },
    {
      seq: 2,
      type: 'assistant/message',
      time: 3000,
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'reply raw' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    },
  ]
  assert.equal(projectEventMessage(events[1]).role, 'user')
  assert.equal(projectEventMessage(events[2]).role, 'assistant')
  const rendered = renderEvents(events, [1, 2], { maxTokens: 1000 })
  assert.equal(rendered.count, 2)
  assert.match(rendered.text, /hello raw/)
  assert.match(rendered.text, /reply raw/)
  const samples = sampleFromEvents(events, [0, 1, 2])
  assert.equal(samples.length, 2, 'system messages are not sampled')
  const queried = await readSessionEvents(
    { get: (name) => (name === 'sessionQuery' ? { readSession: async () => ({ events }) } : undefined) },
    'persisted',
    null,
  )
  assert.equal(queried.length, 3)
})

test('tools: dict_cite replays persisted non-live sessions through sessionQuery', async () => {
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'persisted-1', now })
  store.insertEntry({
    entryId: entryIdFor('persisted-1', normHeadword('file', 'src/old.ts')),
    volumeId: 'persisted-1',
    kind: 'file',
    headword: 'src/old.ts',
    headwordNorm: 'src/old.ts',
    gloss: 'old file',
    createdAt: now,
    updatedAt: now,
  })
  store.addEntryCount('persisted-1', 1, now)
  const citeId = 'c_persisted'
  store.insertCitation({
    citeId,
    entryId: entryIdFor('persisted-1', 'src/old.ts'),
    sessionId: 'persisted-1',
    seqStart: 5,
    seqEnd: 5,
    excerpt: 'persisted evidence',
    createdAt: now,
  })
  const events = [{
    seq: 5,
    type: 'user/message',
    time: now,
    data: { role: 'user', content: [{ type: 'text', text: 'persisted evidence text' }], source: { kind: 'user' } },
  }]
  const ctx = {
    get: (name) => (name === 'sessionQuery'
      ? { readSession: async (id) => (id === 'persisted-1' ? { events } : { events: [] }) }
      : undefined),
  }
  const current = createFakeSession({ id: 'current-session' })
  const tools = buildToolDefinitions({ ctx, store, config, log: createNoopLogger() })
  const exec = { agent: { session: current }, signal: new AbortController().signal }
  const result = await tools[2].execute({ cite_id: citeId }, exec)
  assert.match(result.text, /persisted evidence text/)
  assert.match(result.text, /user/)
  store.close()
})

test('tools: cross-session citation degrades explicitly when no log source exists', async () => {  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'other-session', now })
  store.insertEntry({
    entryId: entryIdFor('other-session', 'src/x.ts'),
    volumeId: 'other-session',
    kind: 'file',
    headword: 'src/x.ts',
    headwordNorm: 'src/x.ts',
    gloss: 'x file',
    createdAt: now,
    updatedAt: now,
  })
  store.addEntryCount('other-session', 1, now)
  store.insertCitation({
    citeId: 'c_other',
    entryId: entryIdFor('other-session', 'src/x.ts'),
    sessionId: 'other-session',
    seqStart: 3,
    seqEnd: 3,
    excerpt: 'cross session',
    createdAt: now,
  })
  const session = createFakeSession({ id: 'current-session' })
  const ctx = { get: () => undefined }
  const tools = buildToolDefinitions({ ctx, store, config, log: createNoopLogger() })
  const exec = { agent: { session }, signal: new AbortController().signal }
  const result = await tools[2].execute({ cite_id: 'c_other' }, exec)
  assert.match(result.text, /not readable/)
  store.close()
})

test('dimensions: narrative corpus yields chapter markers and frequent persons', () => {
  const text = [
    '第一卷 七玄门风云 第一章 山边小村',
    '韩立道：“你好。”',
    '墨大夫道：“嗯。”',
    '韩立道：“再见。”',
    '墨大夫说道：“小心。”',
    '韩立说道：“走。”',
    '铁那里知道：“不对。”',
    '他笑道：“别走。”',
  ].join('\n')
  const candidates = extractCandidates([{ seq: 1, role: 'user', text, time: 1000 }])
  const chapters = candidates.filter((candidate) => candidate.kind === 'chapter')
  assert.ok(chapters.some((candidate) => /第一卷/.test(candidate.headword)), JSON.stringify(chapters))
  const persons = candidates.filter((candidate) => candidate.kind === 'person').map((candidate) => candidate.headword)
  assert.ok(persons.includes('韩立'), `persons=${JSON.stringify(persons)}`)
  assert.ok(persons.includes('墨大夫'), `persons=${JSON.stringify(persons)}`)
  assert.ok(!persons.includes('铁那里知'), 'verb+name noise must be filtered')
  assert.ok(!persons.some((name) => name.includes('知道')), '知道 must not be a person')
})

test('capacity: rolling eviction keeps high-value kinds and bounds the volume', () => {
  const { store } = freshStore()
  const now = Date.now()
  const config = { ...resolveConfig(), maxEntries: 4 }
  store.ensureVolume({ volumeId: 'cap', now })
  const candidates = [
    { kind: 'task', headword: 'TODO: keep this task', gloss: 'open', seq: 1, time: now, status: 'open' },
    { kind: 'decision', headword: '决定采用滚动淘汰', gloss: 'keep decisions', seq: 2, time: now },
  ]
  for (let index = 0; index < 8; index += 1) {
    candidates.push({ kind: 'topic', headword: `topic-number-${index}`, gloss: 'noise', seq: 3 + index, time: now + index })
  }
  const stats = ingestCandidates(store, { volumeId: 'cap', sessionId: 'cap', candidates, now, config })
  assert.ok(stats.evicted > 0, 'rolling retention should evict something')
  assert.ok(store.listArchived('cap').length > 0, 'evicted entries should be archived')
  const archivedId = store.listArchived('cap')[0].entry.entryId
  assert.equal(store.restoreArchived(archivedId), true, 'archived entry should restore')
  assert.ok(store.getEntry(archivedId) !== null)
  assert.ok(store.countEntries('cap') <= 5, 'restore intentionally goes one over the cap')
  assert.equal(store.listEntries('cap', { kind: 'task' }).length, 1, 'tasks are protected')
  assert.equal(store.listEntries('cap', { kind: 'decision' }).length, 1, 'decisions are protected')
  store.close()
})

test('tasks: completion statement closes a matching open task', () => {
  const { store } = freshStore()
  const now = Date.now()
  const config = resolveConfig()
  store.ensureVolume({ volumeId: 'closure', now })
  ingestCandidates(store, {
    volumeId: 'closure',
    sessionId: 'closure',
    now,
    config,
    candidates: [
      { kind: 'task', headword: 'TODO: 修复时间轴排序', gloss: 'pending', seq: 1, time: now, status: 'open' },
    ],
  })
  assert.equal(store.openTasks('closure').length, 1)
  const second = ingestCandidates(store, {
    volumeId: 'closure',
    sessionId: 'closure',
    now: now + 1000,
    config,
    candidates: [
      { kind: 'task', headword: '任务已完成：修复时间轴排序问题', gloss: 'done', seq: 2, time: now + 1000, status: 'done' },
    ],
  })
  assert.ok(second.tasksClosed >= 1, `expected closure, stats=${JSON.stringify(second)}`)
  assert.equal(store.openTasks('closure').length, 0, 'matching open task should be closed')
  assert.ok(store.listEntries('closure', { kind: 'task', status: 'done' }).length >= 1)
  store.close()
})

test('search: hybrid fuses lexical + sparse hits and honors structured filters', () => {
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'hybrid-vol', project: 'e:/hybrid', now })
  ingestCandidates(store, {
    volumeId: 'hybrid-vol',
    sessionId: 'hybrid-vol',
    now,
    config,
    candidates: [
      { kind: 'file', headword: 'src/cache.ts', gloss: 'compaction cache module', seq: 1, time: now },
      { kind: 'decision', headword: '采用混合检索', gloss: 'lexical 与 sparse semantic 融合', seq: 2, time: now },
    ],
  })
  store.rebuildGroups('hybrid-vol')
  const fused = hybridSearch(store, '混合检索', { volumeId: 'hybrid-vol', limit: 5 })
  assert.ok(fused.results.length > 0)
  assert.equal(fused.results[0].entry.headword, '采用混合检索')
  assert.ok(fused.meta.lexical > 0)
  assert.ok(fused.results[0].sources.length > 0)
  assert.equal(hybridSearch(store, 'cache', { volumeId: 'hybrid-vol', kind: 'decision' }).results.length, 0)
  const recent = hybridSearch(store, 'cache', { volumeId: 'hybrid-vol', sort: 'recent' })
  assert.ok(recent.results.length > 0)
})

test('search: ranked lexical search orders by IDF-weighted term match', () => {
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'search-vol', project: 'e:/search', now })
  ingestCandidates(store, {
    volumeId: 'search-vol',
    sessionId: 'search-vol',
    now,
    config,
    candidates: [
      { kind: 'file', headword: 'src/compiler/cache.ts', gloss: 'compaction cache module', seq: 1, time: now },
      { kind: 'file', headword: 'docs/readme.md', gloss: 'readme documentation', seq: 2, time: now },
      { kind: 'decision', headword: '决定缓存策略', gloss: 'cache strategy decision', seq: 3, time: now },
    ],
  })
  const byAscii = store.searchRanked('compiler cache')
  assert.ok(byAscii.length >= 1)
  assert.equal(byAscii[0].entry.headword, 'src/compiler/cache.ts')
  const byCjk = store.searchRanked('缓存策略')
  assert.ok(byCjk.length >= 1)
  assert.match(byCjk[0].entry.headword, /缓存/)
  store.close()
})

test('topics + hierarchy: compile produces TF-IDF topics and a volume tree', async () => {
  const { store, config } = freshStore()
  const compiler = new Compiler({ store, config, log: createNoopLogger() })
  const session = createFakeSession()
  const seqs = []
  for (let index = 0; index < 5; index += 1) {
    seqs.push(session.addUser(`时间轴缓存优化方案第${index}次讨论；确认缓存命中率与时间轴排序。`))
  }
  compiler.ingest(session, session.addCompaction({ compactionId: 'topic-1', seqs, summary: '时间轴缓存优化。' }))
  await compiler.drain()

  const topics = store.listEntries(session.id, { kind: 'topic', limit: 20 })
  assert.ok(topics.length > 0, 'expected deterministic topic entries')
  assert.ok(topics.some((entry) => /时间|缓存/.test(entry.headword)), JSON.stringify(topics.map((entry) => entry.headword)))

  const roots = store.listGroups(session.id, null)
  assert.equal(roots.length, 1)
  assert.equal(roots[0].kind, 'root')
  const groups = store.listGroups(session.id, roots[0].groupId)
  assert.ok(groups.length > 0, 'expected kind/module groups')
  const tree = treeText(store, session.id)
  assert.match(tree, /# Tree — volume/)
  assert.match(tree, /\[kind\]|\[module\]/)
  assert.ok(store.searchRanked('时间轴缓存').length > 0, 'search index should cover compiled entries')
  store.close()
})

test('merge: cross-project migration imports volumes and merges headwords', () => {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'flow-tower-merge-'))
  process.env.DSH_HOME = home
  try {
    const sourceProject = normalizeProjectPath(join(home, 'proj-src'))
    const targetProject = normalizeProjectPath(join(home, 'proj-dst'))
    const now = Date.now()
    const source = FlowStore.open({ dbPath: dbPathForProject(sourceProject) })
    source.ensureVolume({ volumeId: 'merge-vol', project: sourceProject, now })
    ingestCandidates(source, {
      volumeId: 'merge-vol',
      sessionId: 'merge-vol',
      now,
      config: resolveConfig(),
      candidates: [
        { kind: 'file', headword: 'src/shared.ts', gloss: 'shared file', seq: 1, time: now },
        { kind: 'task', headword: 'TODO: review shared.ts', gloss: 'pending', seq: 2, time: now, status: 'open' },
      ],
    })
    source.close()

    // A distinct target volume makes the volume-level mergedFrom edge observable.
    const targetPre = FlowStore.open({ dbPath: dbPathForProject(targetProject) })
    targetPre.ensureVolume({ volumeId: 'dst-vol', project: targetProject, now })
    targetPre.close()

    const stats = mergeProjects(sourceProject, targetProject)
    assert.ok(stats.volumes >= 1)
    assert.ok(stats.entries >= 2)

    const target = FlowStore.open({ dbPath: dbPathForProject(targetProject) })
    assert.ok(target.getVolume('merge-vol') !== null)
    assert.ok(target.findEntryByWord('merge-vol', 'src/shared.ts') !== null)
    assert.ok(target.listGroups('merge-vol', null).length === 1, 'groups should be rebuilt after merge')
    const mergedEdges = outgoing(target, nodeIdForVolume('dst-vol'))
    assert.ok(mergedEdges.some((edge) => edge.type === 'mergedFrom'), JSON.stringify(mergedEdges.map((edge) => edge.type)))
    target.close()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmWithRetry(home)
  }
})

test('proposals: shadow audits, on mode commits validated entries, repeats skip', () => {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'flow-tower-proposal-'))
  process.env.DSH_HOME = home
  try {
    const project = normalizeProjectPath(join(home, 'proj-agent'))
    const dir = proposalsDir(project)
    mkdirSync(dir, { recursive: true })
    const proposalFile = join(dir, 'agent-1.json')
    writeFileSync(proposalFile, JSON.stringify({
      entries: [
        { kind: 'topic', headword: '单元测试提案', gloss: 'agent supplied topic entry', citations: [7] },
        { kind: 'task', headword: 'TODO: proposal review', gloss: 'agent supplied task', citations: [8], status: 'open' },
        { kind: 'bogus-kind', headword: 'bad', gloss: 'bad', citations: [9] },
      ],
    }), 'utf8')

    const store = FlowStore.open({ dbPath: dbPathForProject(project) })
    store.ensureVolume({ volumeId: 'proposal-vol', project, now: Date.now() })
    const config = { ...resolveConfig(), proposalMode: 'shadow' }
    const shadow = processProposals(store, 'proposal-vol', project, { mode: 'shadow', config, log: createNoopLogger() })
    assert.equal(shadow.files, 1)
    assert.equal(shadow.accepted, 2)
    assert.equal(shadow.rejected, 1)
    assert.equal(store.countEntries('proposal-vol'), 0, 'shadow mode must not commit')

    const on = processProposals(store, 'proposal-vol', project, { mode: 'on', config, log: createNoopLogger() })
    assert.equal(on.committed, 2)
    assert.equal(store.countEntries('proposal-vol'), 2)
    assert.ok(store.listEntries('proposal-vol', { kind: 'topic' }).length === 1)
    assert.ok(store.listEntries('proposal-vol', { kind: 'task' }).length === 1)
    assert.ok(store.citationsFor(store.listEntries('proposal-vol', { kind: 'topic' })[0].entryId).length === 1)

    const repeat = processProposals(store, 'proposal-vol', project, { mode: 'on', config, log: createNoopLogger() })
    // The committed file is moved to processed/, so a re-scan finds nothing new.
    assert.equal(repeat.files, 0)
    assert.equal(store.countEntries('proposal-vol'), 2)
    store.close()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmWithRetry(home)
  }
})

test('web: read-only API exposes catalog, search, lookup and task views', () => {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'flow-tower-web-'))
  process.env.DSH_HOME = home
  const manager = new StoreManager({ config: resolveConfig(), log: createNoopLogger() })
  try {
    const project = normalizeProjectPath(join(home, 'proj-web'))
    const store = manager.getStore(project)
    const now = Date.now()
    store.ensureVolume({ volumeId: 'web-vol', project, now })
    ingestCandidates(store, {
      volumeId: 'web-vol',
      sessionId: 'web-vol',
      now,
      config: resolveConfig(),
      candidates: [
        { kind: 'file', headword: 'src/cache.ts', gloss: 'compaction cache module', seq: 1, time: now },
        { kind: 'task', headword: 'TODO: review cache', gloss: 'pending review', seq: 2, time: now, status: 'open' },
      ],
    })
    store.rebuildGroups('web-vol')

    const catalog = buildApiPayload(manager, '/flow-tower/api/catalog')
    assert.equal(catalog.status, 200)
    assert.ok(catalog.json.projects.some((item) => item.project === project))

    const search = buildApiPayload(manager, '/flow-tower/api/search', new URLSearchParams({ q: 'cache', project }))
    assert.equal(search.status, 200)
    assert.equal(search.json.mode, 'hybrid')
    assert.ok(search.json.results.length >= 1)
    assert.equal(search.json.results[0].headword, 'src/cache.ts')
    assert.ok(Array.isArray(search.json.results[0].sources))
    const taskOnly = buildApiPayload(manager, '/flow-tower/api/search', new URLSearchParams({ q: 'cache', project, kind: 'task' }))
    assert.equal(taskOnly.status, 200)
    assert.ok(taskOnly.json.results.length >= 1)
    assert.ok(taskOnly.json.results.every((hit) => hit.kind === 'task'))
    const lexical = buildApiPayload(manager, '/flow-tower/api/search', new URLSearchParams({ q: 'cache', project, mode: 'lexical' }))
    assert.equal(lexical.json.mode, 'lexical')

    const lookup = buildApiPayload(manager, '/flow-tower/api/lookup', new URLSearchParams({ term: 'src/cache.ts', project }))
    assert.equal(lookup.status, 200)
    assert.match(lookup.json.text, /^## src\/cache\.ts/)

    const tasks = buildApiPayload(manager, '/flow-tower/api/tasks', new URLSearchParams({ project }))
    assert.equal(tasks.status, 200)
    assert.ok(tasks.json.tasks.some((task) => task.headword.includes('cache')))

    const graph = buildApiPayload(manager, '/flow-tower/api/graph', new URLSearchParams({ project, format: 'mermaid' }))
    assert.equal(graph.status, 200)
    assert.match(graph.json.text, /graph LR/)
    const relate = buildApiPayload(manager, '/flow-tower/api/relate', new URLSearchParams({ project, term: 'src/cache.ts' }))
    assert.equal(relate.status, 200)
    assert.match(relate.json.text, /relation\(s\)|derivedFrom/)
    const allGraph = buildApiPayload(manager, '/flow-tower/api/graph', new URLSearchParams({ project, scope: 'all', format: 'json' }))
    assert.equal(allGraph.status, 200)
    assert.ok(allGraph.json.graph.edges.length >= 1)
    const strongGraph = buildApiPayload(manager, '/flow-tower/api/graph', new URLSearchParams({ project, format: 'json', minConfidence: '0.9' }))
    assert.equal(strongGraph.status, 200)
    assert.ok(strongGraph.json.graph.edges.every((edge) => Number(edge.confidence) >= 0.9))

    const tree = buildApiPayload(manager, '/flow-tower/api/tree', new URLSearchParams({ project }))
    assert.equal(tree.status, 200)
    assert.match(tree.json.text, /# Tree — volume/)

    const handler = createWebHandler({ manager, log: createNoopLogger() })
    let html = ''
    handler(
      { url: '/flow-tower/', method: 'GET' },
      { setHeader: () => {}, end: (body) => { html = body }, statusCode: 0 },
    )
    assert.match(html, /Context Flow Tower/)
    assert.match(html, /renderGraph/)
    assert.match(html, /forceLayout/)
    assert.match(html, /strongonly/)
    let apiBody = ''
    handler(
      { url: `/flow-tower/api/catalog`, method: 'GET' },
      { setHeader: () => {}, end: (body) => { apiBody = body }, statusCode: 0 },
    )
    assert.ok(JSON.parse(apiBody).projects.length >= 1)
  } finally {
    manager.closeAll()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmWithRetry(home)
  }
})

test('semantic: sparse vectors + co-occurrence expansion find related entries', () => {
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'sem-vol', project: 'e:/sem', now })
  ingestCandidates(store, {
    volumeId: 'sem-vol',
    sessionId: 'sem-vol',
    now,
    config,
    candidates: [
      { kind: 'decision', headword: '决定缓存阈值', gloss: '缓存 与 时间轴 联动', seq: 1, time: now },
      { kind: 'decision', headword: '时间轴排序方案', gloss: '排序 稳定', seq: 2, time: now },
      { kind: 'file', headword: 'src/cache.ts', gloss: 'cache module', seq: 3, time: now },
    ],
  })
  const results = semanticSearch(store, '缓存', { limit: 10 })
  assert.ok(results.length >= 2, JSON.stringify(results.map((item) => item.entry.headword)))
  assert.ok(results.some((item) => item.entry.headword === '时间轴排序方案'), 'co-occurrence expansion should surface the related entry')
  store.close()
})

test('summary: recursive deterministic summary tree has levels and summaries', async () => {
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'sum-vol', project: 'e:/sum', now })
  ingestCandidates(store, {
    volumeId: 'sum-vol',
    sessionId: 'sum-vol',
    now,
    config,
    candidates: [
      { kind: 'file', headword: 'src/cache.ts', gloss: 'cache', seq: 1, time: now, module: 'src' },
      { kind: 'task', headword: 'TODO: cache review', gloss: 'review', seq: 2, time: now, status: 'open' },
      { kind: 'decision', headword: '决定缓存策略', gloss: 'strategy', seq: 3, time: now },
    ],
  })
  store.rebuildGroups('sum-vol')
  const built = rebuildSummaryTree(store, 'sum-vol')
  assert.ok(built.nodes >= 3, JSON.stringify(built))
  const nodes = store.listSummaryNodes('sum-vol')
  assert.ok(nodes.some((node) => node.level === 0))
  assert.ok(nodes.some((node) => node.level === 1 && node.label.startsWith('[category]')))
  const text = summaryTreeText(store, 'sum-vol')
  assert.match(text, /# Summary tree/)
  assert.match(text, /summary:/)
  assert.match(text, /\[category\]/)
  // Extractive summaries + summary-level search index.
  const summaryHits = store.searchSummariesRanked('cache')
  assert.ok(summaryHits.length > 0, JSON.stringify(summaryHits))
  assert.ok(store.listSummaryNodes('sum-vol').some((node) => node.citations.length > 0), 'summary nodes should carry citations')
  const searchTool = buildToolDefinitions({ ctx: { get: () => undefined }, store, config, log: createNoopLogger() })
  const dictSearch = searchTool.find((tool) => tool.name === 'dict_search')
  const searched = await dictSearch.execute({ query: 'cache', scope: 'summaries' }, { agent: { session: { id: 'sum-vol', header: { cwd: 'e:/sum' } } }, signal: new AbortController().signal })
  assert.match(searched.text, /Summary matches/)
  store.close()
})

test('web: smart-search route calls the host model and caches repeats', async () => {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'flow-tower-smart-'))
  process.env.DSH_HOME = home
  const manager = new StoreManager({ config: resolveConfig(), log: createNoopLogger() })
  try {
    const project = normalizeProjectPath(join(home, 'proj-smart'))
    const store = manager.getStore(project)
    const now = Date.now()
    store.ensureVolume({ volumeId: 'smart-vol', project, now })
    ingestCandidates(store, {
      volumeId: 'smart-vol',
      sessionId: 'smart-vol',
      now,
      config: resolveConfig(),
      candidates: [{ kind: 'file', headword: 'src/cache.ts', gloss: 'compaction cache module', seq: 1, time: now }],
    })
    store.rebuildGroups('smart-vol')
    const calls = []
    const modelCaller = async (prompt) => {
      calls.push(String(prompt))
      return String(prompt).includes('Rewrite') ? '{"queries":["compaction cache"]}' : '{"order":[]}'
    }
    const handler = createWebHandler({ manager, log: createNoopLogger(), modelCaller })
    const request = async () => new Promise((resolve) => {
      handler(
        { url: '/flow-tower/api/smart-search?q=cache&limit=5&project=' + encodeURIComponent(project), method: 'GET' },
        {
          statusCode: 0,
          setHeader: () => {},
          end: (body) => resolve({ status: 200, body: JSON.parse(String(body)) }),
        },
      )
    })
    const first = await request()
    assert.equal(first.body.mode, 'smart')
    assert.equal(first.body.cached, false)
    assert.ok(first.body.results.length >= 1)
    assert.equal(calls.length, 2, 'rewrite + rerank use the host model')
    const second = await request()
    assert.equal(second.body.cached, true)
    assert.equal(calls.length, 2, 'repeat query is served from the smart cache')
  } finally {
    manager.closeAll()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmWithRetry(home)
  }
})

test('web write: closing a task via the panel API updates status', () => {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'flow-tower-webtask-'))
  process.env.DSH_HOME = home
  const manager = new StoreManager({ config: resolveConfig(), log: createNoopLogger() })
  try {
    const project = normalizeProjectPath(join(home, 'proj-task'))
    const store = manager.getStore(project)
    const now = Date.now()
    store.ensureVolume({ volumeId: 'task-vol', project, now })
    ingestCandidates(store, {
      volumeId: 'task-vol',
      sessionId: 'task-vol',
      now,
      config: resolveConfig(),
      candidates: [{ kind: 'task', headword: 'TODO: close me', gloss: 'pending', seq: 1, time: now, status: 'open' }],
    })
    const task = store.listEntries('task-vol', { kind: 'task' })[0]
    const closed = closeTask(manager, project, task.entryId)
    assert.equal(closed.ok, true)
    assert.equal(closed.entry.status, 'done')
    const viaPayload = handleWritePayload(manager, '/flow-tower/api/task/close', { project, entryId: 'missing' })
    assert.equal(viaPayload.status, 400)
    // Manual relation annotation is intentionally not exposed (automation-only tool).
    assert.equal(handleWritePayload(manager, '/flow-tower/api/relation/add', { project }).status, 404)
  } finally {
    manager.closeAll()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmWithRetry(home)
  }
})

test('quality: tool payloads/markup are rejected and home paths are not modules', () => {
  const candidates = extractCandidates([
    { seq: 1, role: 'tool', text: 'tool-call write {"content":"# big json payload"}\n| col | col |\n' },
    { seq: 2, role: 'user', text: '我们决定采用方案：先做检索，再做摘要。' },
    { seq: 3, role: 'user', text: 'File /Users/wuhao/proj/src/a.ts done.' },
  ], { project: '' })
  for (const candidate of candidates) {
    assert.ok(!/[{}|]|tool-call|"content"/.test(candidate.headword), `noise headword: ${candidate.headword}`)
    assert.ok(candidate.headword.length <= 60, `headword too long: ${candidate.headword}`)
  }
  assert.equal(deriveModule('/Users/wuhao/proj/src/a.ts', ''), '')
  assert.equal(deriveModule('src/compiler/cache.ts', ''), 'src/compiler')
  let busyCalls = 0
  assert.equal(retryBusy(() => {
    busyCalls += 1
    if (busyCalls < 3) throw new Error('SQLITE_BUSY: database is locked')
    return 'ok'
  }), 'ok')
  assert.equal(busyCalls, 3)
})

test('llm proposer: prompt/parse/validate produce proposal files with real seq citations', async () => {
  const samples = [{ seq: 7, text: '我们决定采用缓存方案，并记录时间轴。' }]
  const prompt = buildProposalPrompt(samples)
  assert.match(prompt, /\[seq 7\]/)
  assert.match(parseProposalJson('```json\n{"entries":[{"kind":"decision","headword":"采用缓存方案","gloss":"决定采用缓存","citations":[7]}]}\n```') ? 'ok' : '', /ok/)
  const fakeCaller = async () => JSON.stringify({
    entries: [
      { kind: 'decision', headword: '采用缓存方案', gloss: '决定采用缓存方案', citations: [7] },
      { kind: 'topic', headword: 'bad-citation', gloss: 'wrong seq', citations: [99] },
      { kind: 'bogus', headword: 'bad-kind', gloss: 'invalid', citations: [7] },
    ],
  })
  const result = await generateProposalsFromText(samples, { callModel: fakeCaller })
  assert.equal(result.entries.length, 1)
  assert.ok(result.rejected.length >= 2)
  const dir = mkdtempSync(join(tmpdir(), 'flow-tower-propose-'))
  try {
    const file = writeProposal(dir, result.entries, { now: 1 })
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(written.entries.length, 1)
    assert.deepEqual(written.entries[0].citations, [7])
  } finally {
    rmWithRetry(dir)
  }
})

test('relations: canonical endpoints, inverse views and idempotent writes', () => {
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'rel-vol', project: 'e:/rel', now })
  ingestCandidates(store, {
    volumeId: 'rel-vol',
    sessionId: 'rel-vol',
    now,
    config,
    candidates: [{ kind: 'decision', headword: '决定关系测试', gloss: 'relation test', seq: 7, time: now }],
  })
  const entry = store.listEntries('rel-vol', { kind: 'decision' })[0]
  const entryNode = nodeIdForEntry(entry.entryId)
  // Inverse input type is normalized: v:x derivedTo entry == entry derivedFrom v:x.
  assert.equal(addRelation(store, { fromId: 'v:other', fromKind: 'volume', toId: entryNode, toKind: 'decision', type: 'derivedTo' }).ok, true)
  assert.equal(addRelation(store, { fromId: 'v:other', fromKind: 'volume', toId: entryNode, toKind: 'decision', type: 'derivedTo' }).ok, true)
  const out = outgoing(store, entryNode)
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'derivedFrom')
  assert.equal(out[0].toId, 'v:other')
  const incomingOnVolume = incoming(store, 'v:other')
  assert.equal(incomingOnVolume.length, 1)
  assert.equal(incomingOnVolume[0].type, 'derivedTo')
  assert.equal(canonicalType('derivedTo'), 'derivedFrom')
})

test('relations: cycle policy allows cites cycles and rejects derivedFrom cycles', () => {
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'cycle-vol', project: 'e:/cycle', now })
  ingestCandidates(store, {
    volumeId: 'cycle-vol',
    sessionId: 'cycle-vol',
    now,
    config,
    candidates: [
      { kind: 'decision', headword: '环测试A', gloss: 'a', seq: 1, time: now },
      { kind: 'decision', headword: '环测试B', gloss: 'b', seq: 2, time: now },
    ],
  })
  const [a, b] = store.listEntries('cycle-vol', { kind: 'decision' })
  addRelation(store, { fromId: a.entryId, fromKind: 'decision', toId: b.entryId, toKind: 'decision', type: 'derivedFrom' })
  addRelation(store, { fromId: b.entryId, fromKind: 'decision', toId: a.entryId, toKind: 'decision', type: 'derivedFrom' })
  assert.ok(findCycles(store, 'derivedFrom').cycles.length >= 1)
  addRelation(store, { fromId: a.entryId, fromKind: 'decision', toId: b.entryId, toKind: 'decision', type: 'cites' })
  addRelation(store, { fromId: b.entryId, fromKind: 'decision', toId: a.entryId, toKind: 'decision', type: 'cites' })
  assert.equal(findCycles(store, 'cites').cycles.length, 0, 'cites is allowed to be cyclic')
})

test('relations: sync builds derivedFrom host edges and is watermark-incremental', () => {
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'sync-vol', project: 'e:/sync', now })
  ingestCandidates(store, {
    volumeId: 'sync-vol',
    sessionId: 'sync-vol',
    now,
    config,
    candidates: [
      { kind: 'file', headword: 'src/relations.ts', gloss: 'relations', seq: 11, time: now },
      { kind: 'task', headword: 'TODO: relation review', gloss: 'review', seq: 12, time: now, status: 'open' },
    ],
  })
  store.rebuildGroups('sync-vol')
  const first = syncRelations(store, 'sync-vol', { now })
  assert.ok(first.edges >= 2, JSON.stringify(first))
  const second = syncRelations(store, 'sync-vol', { now: now + 1000 })
  const entries = store.listEntries('sync-vol', { limit: 10 })
  const file = entries.find((entry) => entry.kind === 'file')
  const out = outgoing(store, file.entryId)
  assert.ok(out.some((edge) => edge.type === 'derivedFrom' && edge.toId.startsWith('h:sync-vol:11')))
  assert.ok(out.some((edge) => edge.type === 'parent' && edge.toKind === 'group'), 'entry should point at its group')
  assert.ok(second.edges >= 0)
  const validation = validateRelations(store, { volumeId: 'sync-vol' })
  assert.equal(validation.dangling, 0)
  assert.equal(validation.unknownTypes, 0)
  const rolled = rollbackBatch(store, first.batchId)
  assert.ok(rolled.removed >= 2)
  // A later sync batch re-added hierarchy edges, so only derivedFrom must be gone.
  assert.ok(outgoing(store, file.entryId).every((edge) => edge.type !== 'derivedFrom'))
})

test('relations: export/import round-trips edges and preserves unknown types', () => {
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'exp-vol', project: 'e:/exp', now })
  ingestCandidates(store, {
    volumeId: 'exp-vol',
    sessionId: 'exp-vol',
    now,
    config,
    candidates: [{ kind: 'decision', headword: '导出导入测试', gloss: 'export import', seq: 3, time: now }],
  })
  const entry = store.listEntries('exp-vol')[0]
  addRelation(store, { fromId: entry.entryId, fromKind: 'decision', toId: 'h:exp-vol:3', toKind: 'host', type: 'derivedFrom', evidence: ['c1'], source: 'compiler' })
  addRelation(store, { fromId: entry.entryId, fromKind: 'decision', toId: 'e_missing', toKind: 'decision', type: 'cites' })
  const graph = exportGraph(store)
  assert.equal(graph.version, 'relations.v1')
  assert.ok(graph.edges.length >= 2)
  const target = freshStore().store
  const targetNow = Date.now()
  target.ensureVolume({ volumeId: 'exp-vol', project: 'e:/exp', now: targetNow })
  const stats = importGraph(target, graph, { volumeId: 'exp-vol' })
  assert.ok(stats.imported >= 2)
  const roundTrip = exportGraph(target)
  assert.equal(roundTrip.edges.length, graph.edges.length)
  const unknown = importGraph(target, { version: 'relations.v1', edges: [{ fromId: 'e_a', toId: 'e_b', type: 'mystery', fromKind: 'decision', toKind: 'decision' }] })
  assert.equal(unknown.unknown, 1)
  const validation = validateRelations(target)
  assert.ok(validation.unknownTypes >= 1)
})

test('relations: validator reports dangling endpoints', () => {
  const { store } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'dangle-vol', project: 'e:/dangle', now })
  addRelation(store, { fromId: 'e_missing_from', fromKind: 'decision', toId: 'e_missing_to', toKind: 'decision', type: 'cites' })
  const validation = validateRelations(store, { volumeId: 'dangle-vol' })
  assert.ok(validation.dangling >= 2)
  assert.ok(validation.issues.some((issue) => issue.code === 'dangling-endpoint'))
})

test('relations: dict_relate reads neighbors and auto-syncs once', () => {
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'tool-rel-vol', project: 'e:/toolrel', now })
  ingestCandidates(store, {
    volumeId: 'tool-rel-vol',
    sessionId: 'tool-rel-vol',
    now,
    config,
    candidates: [{ kind: 'decision', headword: '决定工具关系', gloss: 'tool relation', seq: 5, time: now }],
  })
  const tools = buildToolDefinitions({ ctx: { get: () => undefined }, store, config, log: createNoopLogger() })
  const relate = tools.find((tool) => tool.name === 'dict_relate')
  assert.ok(relate)
  const exec = { agent: { session: { id: 'tool-rel-vol', header: { cwd: 'e:/toolrel' } } }, signal: new AbortController().signal }
  return relate.execute({ term: '决定工具关系' }, exec).then((result) => {
    assert.match(result.text, /relation\(s\)|derivedFrom/)
    // Weak relatedTo (confidence 0.4) can be filtered out.
    const entries = store.listEntries('tool-rel-vol', { limit: 10 })
    addRelation(store, {
      fromId: entries[0].entryId, fromKind: entries[0].kind,
      toId: entries[1]?.entryId ?? entries[0].entryId + '_x', toKind: entries[1]?.kind ?? 'decision',
      type: 'relatedTo', source: 'test', confidence: 0.4,
    })
    return relate.execute({ term: '决定工具关系', minConfidence: 0.9 }, exec).then((filtered) => {
      assert.ok(!/relatedTo/.test(filtered.text), filtered.text)
    })
  }).then(() => {
    // relationsMode=on surfaces relation counts in the legacy focus digest.
    const onConfig = { ...config, relationsMode: 'on', digestStrategy: 'focus' }
    const digest = buildDigest(store, 'tool-rel-vol', onConfig)
    assert.match(digest, /Relations: \d+/)
    const toolsOn = buildToolDefinitions({ ctx: { get: () => undefined }, store, config: onConfig, log: createNoopLogger() })
    const lookup = toolsOn.find((tool) => tool.name === 'dict_lookup')
    return lookup.execute({ term: '决定工具关系' }, exec).then((lookupResult) => {
      assert.match(lookupResult.text, /Relations: \d+ \(/)
    })
  })
})

test('lock: exclusive lock serializes writers and breaks stale locks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-tower-lock-'))
  const lockPath = join(dir, 'flow.lock')
  try {
    assert.equal(withLock(lockPath, () => 'first'), 'first')
    assert.equal(existsSync(lockPath), false, 'lock must be released')
    writeFileSync(lockPath, '{"pid":1}')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath, old, old)
    assert.equal(withLock(lockPath, () => 'stale-ok', { staleMs: 1000 }), 'stale-ok')
    assert.equal(existsSync(lockPath), false)
    withLock(lockPath, () => {
      assert.throws(() => withLock(lockPath, () => 'nested', { timeoutMs: 50 }), /lock busy/)
    })
  } finally {
    rmWithRetry(dir)
  }
})

test('relations: legacy related lists migrate to symmetric relatedTo edges', () => {
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'related-vol', project: 'e:/related', now })
  ingestCandidates(store, {
    volumeId: 'related-vol',
    sessionId: 'related-vol',
    now,
    config,
    candidates: [
      { kind: 'decision', headword: '关联迁移A', gloss: 'a', seq: 1, time: now },
      { kind: 'decision', headword: '关联迁移B', gloss: 'b', seq: 2, time: now },
    ],
  })
  const [a, b] = store.listEntries('related-vol', { kind: 'decision' })
  store.db.prepare('UPDATE entries SET related = ? WHERE entry_id = ?').run(JSON.stringify([b.entryId]), a.entryId)
  store.rebuildGroups('related-vol')
  syncRelations(store, 'related-vol', { now: now + 10 })
  const related = [...outgoing(store, a.entryId), ...incoming(store, a.entryId)]
    .filter((edge) => edge.type === 'relatedTo')
  assert.ok(related.length >= 1, JSON.stringify(related))
  assert.ok(related.some((edge) => (edge.toId === b.entryId || edge.fromId === b.entryId)))
})

test('compiler: host LLM proposals are shadow-audited and on-committed', async () => {
  const { store, config } = freshStore()
  const session = createFakeSession()
  const seq = session.addUser('LLM 抽取目标：决定采用异步编译。')
  const prompts = []
  const modelCaller = async (prompt) => {
    prompts.push(prompt)
    const match = /\[seq (\d+)\]/.exec(prompt)
    const cite = match === null ? seq : Number(match[1])
    return JSON.stringify({
      entries: [
        { kind: 'decision', headword: 'LLM异步编译', gloss: 'LLM proposal', citations: [cite] },
        { kind: 'topic', headword: '无效引用', gloss: 'bad', citations: [99999] },
      ],
    })
  }
  const shadow = new Compiler({ store, config: { ...config, llmCompiler: 'shadow' }, log: createNoopLogger(), modelCaller })
  shadow.ingest(session, session.addCompaction({ compactionId: 'llm-shadow', seqs: [seq], summary: 'LLM 测试。' }))
  await shadow.drain()
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /\[seq \d+\]/)
  assert.equal(store.findEntryByWord(session.id, 'llm异步编译'), null, 'shadow must not commit')
  const shadowMetric = store.db.prepare("SELECT data FROM metrics WHERE kind='llm-proposals' ORDER BY id DESC LIMIT 1").get()
  assert.match(shadowMetric.data, /shadow/)

  const seq2 = session.addUser('第二段 delta：决定采用同步校验。')
  const onCompiler = new Compiler({ store, config: { ...config, llmCompiler: 'on' }, log: createNoopLogger(), modelCaller })
  onCompiler.ingest(session, session.addCompaction({ compactionId: 'llm-on', seqs: [seq2], summary: 'LLM 提交测试。' }))
  await onCompiler.drain()
  const entry = store.findEntryByWord(session.id, 'llm异步编译')
  assert.ok(entry !== null, 'on mode should commit validated proposals')
  assert.ok(store.citationsFor(entry.entryId).length >= 1)

  const offCompiler = new Compiler({ store, config: { ...config, llmCompiler: 'off' }, log: createNoopLogger(), modelCaller })
  const seq3 = session.addUser('off 模式不应调用模型。')
  offCompiler.ingest(session, session.addCompaction({ compactionId: 'llm-off', seqs: [seq3], summary: 'off。' }))
  await offCompiler.drain()
  assert.equal(prompts.length, 2, 'off mode must not call the model')
  store.close()
})

test('llm bridge: resolves the default host model and collects streamed text', async () => {
  const streamed = []
  const ctx = {
    get: (key) => {
      if (key === 'llm') {
        return {
          async *stream(options) {
            streamed.push(options)
            yield { type: 'text-delta', text: '{"entries":[]}' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      }
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'host-provider', model: 'host-model' }) }
      return undefined
    },
  }
  const caller = createHostModelCaller(ctx, { maxTokens: 32 })
  assert.equal(typeof caller, 'function')
  const text = await caller('prompt')
  assert.equal(text, '{"entries":[]}')
  assert.equal(streamed[0].provider, 'host-provider')
  assert.equal(streamed[0].model, 'host-model')
  assert.equal(createHostModelCaller({ get: () => undefined }), null)
})

test('llm prompt: repairs unescaped quotes and Windows paths in model JSON', () => {
  const repaired = parseProposalJson('{"entries":[{"kind":"topic","headword":"a","gloss":"uses "shadow" mode and E:\\Programming\\x","citations":[1]}]}')
  assert.ok(repaired !== null)
  assert.equal(repaired.entries[0].gloss, 'uses "shadow" mode and E:\\Programming\\x')
  const salvaged = parseProposalJson('{"entries":[{"kind":"topic","headword":"good","gloss":"ok","citations":[1]},{"kind":"file","headword":"broken","gloss":"bad \\P escape","citations":[2]}]')
  assert.ok(salvaged !== null)
  assert.ok(salvaged.entries.some((entry) => entry.headword === 'good'))
})

test('llm filter: process-noise proposals are rejected, durable ones kept', async () => {
  const { isMetaProposal } = await import('../lib/llm-filter.js')
  assert.equal(isMetaProposal({ kind: 'file', headword: 'a.js', gloss: 'The file a.js was updated successfully.' }), true)
  assert.equal(isMetaProposal({ kind: 'topic', headword: 'test result', gloss: 'tests passed' }), true)
  assert.equal(isMetaProposal({ kind: 'decision', headword: '采用项目本地存储', gloss: '决定默认把词典放在项目内，便于共享与迁移。' }), false)
  assert.equal(isMetaProposal({ kind: 'task', headword: 'TODO: 校验关系图一致性', gloss: '需要补悬空端点检查。' }), false)
})

test('settings: local file overrides editable keys and resource cap works', async () => {
  const { mergeSettings, writeSettingsFile, readSettingsFile, resolvePolicy, readPolicyLayers, projectSettingsPath } = await import('../lib/settings.js')
  const { applyResourceProfile } = await import('../lib/resources.js')
  const dir = mkdtempSync(join(tmpdir(), 'flow-tower-settings-'))
  const file = join(dir, 'settings.json')
  try {
    writeSettingsFile({ maxEntries: 1234, relationsMode: 'off', bogus: 1 }, file)
    const saved = readSettingsFile(file)
    assert.equal(saved.maxEntries, 1234)
    assert.equal(saved.bogus, undefined)
    const merged = mergeSettings({ maxEntries: 4000, relationsMode: 'shadow', resourceProfile: 'auto' }, file)
    assert.equal(merged.maxEntries, 1234)
    assert.equal(merged.relationsMode, 'off')
    const project = normalizeProjectPath(join(dir, 'proj'))
    const projectFile = projectSettingsPath(project)
    writeSettingsFile({ digestBudgetTokens: 360 }, projectFile)
    const layered = resolvePolicy({ maxEntries: 4000, digestBudgetTokens: 400, relationsMode: 'shadow' }, project, { globalPath: file, projectPath: projectFile })
    assert.equal(layered.digestBudgetTokens, 360)
    assert.equal(layered.maxEntries, 1234, 'global layer still applies under project override')
    const layers = readPolicyLayers(project, { globalPath: file, projectPath: projectFile })
    assert.equal(layers.project.digestBudgetTokens, 360)
    assert.equal(layers.global.maxEntries, 1234)
    const capped = applyResourceProfile({ maxEntries: 4000, resourceProfile: 'auto' }, { totalMemGB: 4, freeMemGB: 1, cpuCount: 4, profile: 'low', maxEntriesCap: 1500, cacheKiB: 8192, mmapBytes: 1 })
    assert.equal(capped.maxEntries, 1500)
  } finally {
    rmWithRetry(dir)
  }
})

test('manager: LRU bounds simultaneously open project stores', () => {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'flow-tower-lru-'))
  process.env.DSH_HOME = home
  const manager = new StoreManager({ config: resolveConfig(), log: createNoopLogger() })
  try {
    for (let index = 0; index < 6; index += 1) {
      const project = normalizeProjectPath(join(home, `proj-${index}`))
      manager.getStore(project)
    }
    assert.ok(manager.stores.size <= manager.maxOpenStores, `open=${manager.stores.size} max=${manager.maxOpenStores}`)
    // Re-opening an evicted project must still work.
    const reopened = manager.getStore(normalizeProjectPath(join(home, 'proj-0')))
    assert.ok(reopened !== null)
  } finally {
    manager.closeAll()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmWithRetry(home)
  }
})

test('embeddings: optional provider search ranks stored vectors', async () => {
  const { embeddingSearch, cosineSimilarity } = await import('../lib/embeddings.js')
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'emb-vol', project: 'e:/emb', now })
  ingestCandidates(store, {
    volumeId: 'emb-vol',
    sessionId: 'emb-vol',
    now,
    config,
    candidates: [
      { kind: 'decision', headword: '缓存阈值', gloss: 'cache threshold', seq: 1, time: now },
      { kind: 'decision', headword: '缓存淘汰', gloss: 'eviction', seq: 2, time: now },
    ],
  })
  const entries = store.listEntries('emb-vol', { kind: 'decision' })
  store.setEntryVector(entries[0].entryId, 'emb-vol', 'test-model', [1, 0, 0])
  store.setEntryVector(entries[1].entryId, 'emb-vol', 'test-model', [0.2, 0.9, 0])
  const provider = { model: 'test-model', embed: async () => [[1, 0, 0]] }
  const hits = await embeddingSearch(store, 'cache', { provider, volumeId: 'emb-vol', limit: 5 })
  assert.equal(hits.length, 2)
  assert.equal(hits[0].entry.entryId, entries[0].entryId)
  assert.ok(hits[0].score > hits[1].score)
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9)
  store.close()
})

test('aliases: LLM synonyms are indexed for retrieval', () => {
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'alias-vol', project: 'e:/alias', now })
  ingestCandidates(store, {
    volumeId: 'alias-vol',
    sessionId: 'alias-vol',
    now,
    config,
    candidates: [{ kind: 'decision', headword: '缓存淘汰策略', gloss: 'eviction policy', seq: 1, time: now }],
  })
  const [entry] = store.listEntries('alias-vol', { kind: 'decision' })
  store.updateEntry(entry.entryId, { aliases: ['LRU', '缓存回收'] }, now)
  const byAlias = store.searchRanked('LRU', { volumeId: 'alias-vol', limit: 5 })
  assert.ok(byAlias.some((hit) => hit.entry.entryId === entry.entryId), JSON.stringify(byAlias.map((hit) => hit.entry.headword)))
  store.close()
})

test('synonyms: bilingual query expansion matches cross-language terms', () => {
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'syn-vol', project: 'e:/syn', now })
  ingestCandidates(store, {
    volumeId: 'syn-vol',
    sessionId: 'syn-vol',
    now,
    config,
    candidates: [{ kind: 'decision', headword: 'Cache eviction policy', gloss: 'cache eviction strategy for the store', seq: 1, time: now }],
  })
  const hits = store.searchRanked('缓存淘汰', { volumeId: 'syn-vol', limit: 5 })
  assert.ok(hits.some((hit) => hit.entry.headword === 'Cache eviction policy'), JSON.stringify(hits.map((hit) => hit.entry.headword)))
  store.close()
})

test('search: strong typed neighbours get a small relation boost', () => {
  const { store, config } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'boost-vol', project: 'e:/boost', now })
  ingestCandidates(store, {
    volumeId: 'boost-vol',
    sessionId: 'boost-vol',
    now,
    config,
    candidates: [
      { kind: 'decision', headword: '缓存阈值方案', gloss: 'cache threshold', seq: 1, time: now },
      { kind: 'decision', headword: '缓存淘汰策略', gloss: 'eviction policy', seq: 2, time: now },
    ],
  })
  const [seed, neighbour] = store.listEntries('boost-vol', { kind: 'decision' })
  addRelation(store, { fromId: seed.entryId, fromKind: 'decision', toId: neighbour.entryId, toKind: 'decision', type: 'relatedTo', confidence: 1 })
  const boosted = store.searchRanked('缓存阈值方案', { volumeId: 'boost-vol', limit: 10 })
  const neighbourHit = boosted.find((item) => item.entry.entryId === neighbour.entryId)
  assert.ok(neighbourHit !== undefined, JSON.stringify(boosted.map((item) => item.entry.headword)))
  assert.ok(neighbourHit.score > 0)
  store.close()
})

test('compaction bridge: memory digest is appended only to compaction requests', async () => {
  const { augmentCompactionRequest } = await import('../lib/compaction-context.js')
  const request = {
    purpose: 'compaction',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize' }] }],
  }
  assert.equal(augmentCompactionRequest(request, { digest: 'project memory digest' }), true)
  assert.match(request.messages.at(-1).content.at(-1).text, /project memory digest/)
  const nonCompaction = { purpose: 'flow-tower-compile', messages: [] }
  assert.equal(augmentCompactionRequest(nonCompaction, { digest: 'x' }), false)
  assert.equal(augmentCompactionRequest(Object.freeze({ purpose: 'compaction' }), { digest: 'x' }), false)
})

test('compaction wrapper: delegates and restores the host backend', async () => {
  const { wrapCompactionService } = await import('../lib/compaction-wrapper.js')
  const events = []
  const service = {
    calls: 0,
    async compactNow() { this.calls += 1; return { compacted: true } },
  }
  const handle = wrapCompactionService(service, { onEvent: (event) => events.push(event) })
  assert.ok(handle !== null)
  assert.deepEqual(handle.methods, ['compactNow'])
  assert.deepEqual(await service.compactNow(), { compacted: true })
  assert.equal(service.calls, 1)
  assert.equal(events.length, 1)
  assert.equal(events[0].ok, true)
  handle.restore()
  assert.equal(service.compactNow, Object.getPrototypeOf(service).compactNow ?? service.compactNow)
})

test('store: deferred compile seqs persist, dedupe and clear', () => {
  const { store } = freshStore()
  store.addDeferredSeqs('v1', [5, 3, 3, 9], 1000)
  assert.deepEqual(store.listDeferredSeqs('v1'), [3, 5, 9])
  assert.equal(store.countDeferredSeqs('v1'), 3)
  assert.equal(store.countAllDeferredSeqs(), 3)
  store.clearDeferredSeqs('v1')
  assert.deepEqual(store.listDeferredSeqs('v1'), [])
})

test('project policy: allowlist/denylist prefix matching', async () => {
  const { projectEnabled } = await import('../lib/project-policy.js')
  assert.equal(projectEnabled({ projectMode: 'all' }, 'E:/work/a'), true)
  assert.equal(projectEnabled({ projectMode: 'allowlist', projectAllowlist: ['E:/work/a'] }, 'E:/work/a/sub'), true)
  assert.equal(projectEnabled({ projectMode: 'allowlist', projectAllowlist: ['E:/work/a'] }, 'E:/work/b'), false)
  assert.equal(projectEnabled({ projectMode: 'denylist', projectDenylist: ['E:/work/a'] }, 'E:/work/a'), false)
  assert.equal(projectEnabled({ projectMode: 'denylist', projectDenylist: ['E:/work/a'] }, 'E:/work/b'), true)
  assert.equal(projectEnabled({ projectMode: 'current' }, 'E:/work/a', 'E:/work/a'), true)
  assert.equal(projectEnabled({ projectMode: 'current' }, 'E:/work/b', 'E:/work/a'), false)
})

test('dimensions: extract carries feature, task status, module and event time', () => {
  const candidates = extractCandidates([
    { seq: 1, role: 'assistant', text: '实现登录功能，并更新 src/module/a.ts。', time: 1000 },
    { seq: 2, role: 'user', text: 'TODO: 补齐时间轴视图。', time: 2000 },
    { seq: 3, role: 'assistant', text: '任务已完成：时间轴排序已修复。', time: 3000 },
  ])
  const feature = candidates.find((candidate) => candidate.kind === 'feature')
  assert.ok(feature, 'expected a feature candidate')
  assert.match(feature.headword, /实现登录功能/)
  assert.equal(feature.time, 1000)
  // Module attribution: a work item in a sample that names a project file
  // inherits that file's module instead of staying module-less.
  assert.equal(feature.module, 'src/module')

  const file = candidates.find((candidate) => candidate.kind === 'file')
  assert.ok(file)
  assert.equal(file.module, 'src/module')
  assert.equal(deriveModule('packages/core/agent-loop/src/index.ts'), 'packages/core')
  assert.equal(deriveModule('src/a.ts'), 'src')
  assert.equal(deriveModule('a.ts'), '')
  // Project-relative derivation: absolute paths under the project become repo-relative.
  assert.equal(deriveModule('E:/proj/alpha/src/module/a.ts', 'E:/proj/alpha'), 'src/module')
  // Absolute paths outside the project (home/system prefixes) are not modules.
  assert.equal(deriveModule('C:/Users/me/notes/a.md', 'E:/proj/alpha'), '')

  const tasks = candidates.filter((candidate) => candidate.kind === 'task')
  assert.ok(tasks.some((task) => task.status === 'open'), 'TODO should be an open task')
  assert.ok(tasks.some((task) => task.status === 'done'), 'completion sentence should be a done task')
  assert.ok(tasks.every((task) => task.time > 0))
})

test('dimensions: store indexes project, module, task status and time', () => {
  const { store } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'v1', project: 'E:/proj/alpha', now })
  store.ensureVolume({ volumeId: 'v2', project: 'E:/proj/beta', now })
  store.insertEntry({
    entryId: 'e_a',
    volumeId: 'v1',
    kind: 'file',
    headword: 'src/module/a.ts',
    headwordNorm: 'src/module/a.ts',
    gloss: 'a module file',
    module: 'src/module',
    firstSeenAt: now - 5000,
    lastSeenAt: now - 1000,
    createdAt: now,
    updatedAt: now,
  })
  store.insertEntry({
    entryId: 'e_task',
    volumeId: 'v1',
    kind: 'task',
    headword: 'TODO: wire the timeline',
    headwordNorm: 'todo: wire the timeline',
    gloss: 'pending work',
    status: 'open',
    statusSeq: 10,
    firstSeenAt: now - 2000,
    lastSeenAt: now - 500,
    createdAt: now,
    updatedAt: now,
  })
  store.addEntryCount('v1', 2, now)

  assert.equal(store.listVolumes({ project: 'E:/proj/alpha' }).length, 1)
  const projects = store.listProjects()
  assert.equal(projects.find((project) => project.project === 'E:/proj/alpha').volumes, 1)
  assert.ok(projects.every((project) => project.entries >= 1), 'catalog only lists volumes with entries')
  assert.equal(store.listEntries('v1', { module: 'src/module' }).length, 1)
  assert.equal(store.listEntries('v1', { since: now - 1500 }).length, 2)
  assert.equal(store.listEntries('v1', { since: now - 800 }).length, 1)
  assert.equal(store.listEntries('v1', { until: now - 800 }).length, 1)
  assert.deepEqual(store.openTasks('v1').map((entry) => entry.entryId), ['e_task'])
  assert.deepEqual(store.recentModules('v1').map((item) => item.module), ['src/module'])
  assert.equal(store.timelineEntries({ project: 'E:/proj/alpha' }).length, 2)
  assert.equal(store.searchEntries('a.ts', { project: 'E:/proj/alpha' }).length, 1)
  store.close()
})

test('dimensions: digest and timeline render project, modules, open tasks and chronology', async () => {
  const { store, config } = freshStore()
  const now = Date.now()
  compilerSeed(store, config, now)
  const digest = buildDigest(store, 'dim-volume', config)
  assert.match(digest, /Project brief · dim/)
  assert.match(digest, /Progress:/)
  assert.match(digest, /进行中：TODO: wire the timeline/)
  assert.match(digest, /Change log:/)
  assert.match(digest, /实现登录功能/)
  assert.match(digest, /dict_lookup\(term\)/)
  const timeline = timelineText(store, { volumeId: 'dim-volume', now })
  assert.match(timeline, /# Timeline/)
  assert.match(timeline, /src\/module\/a\.ts/)
  const browse = browseText(store, { volumeId: 'dim-volume', module: 'src/module', limit: 10 })
  assert.match(browse, /Recent modules: src\/module/)
  store.close()
})

/**
 * Seed one synthetic volume with all five dimensions for digest/timeline tests.
 * @param {FlowStore} store
 * @param {any} config
 * @param {number} now
 */
function compilerSeed(store, config, now) {
  store.ensureVolume({ volumeId: 'dim-volume', project: 'E:/proj/dim', now })
  ingestCandidates(store, {
    volumeId: 'dim-volume',
    sessionId: 'dim-volume',
    now,
    config,
    candidates: [
      { kind: 'file', headword: 'src/module/a.ts', gloss: 'module file', seq: 1, time: now - 3000, module: 'src/module' },
      { kind: 'feature', headword: '实现登录功能', gloss: 'login feature', seq: 1, time: now - 3000 },
      { kind: 'task', headword: 'TODO: wire the timeline', gloss: 'pending', seq: 2, time: now - 2000, status: 'open' },
      { kind: 'task', headword: '任务已完成：时间轴排序', gloss: 'done item', seq: 3, time: now - 1000, status: 'done' },
    ],
  })
}

test('maintenance: archives cited digest noise and attributes modules', () => {  const { store } = freshStore()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'm1', project: 'E:/proj', now })
  const insert = (entryId, kind, headword, gloss) => {
    store.insertEntry({
      entryId,
      volumeId: 'm1',
      kind,
      headword,
      headwordNorm: normHeadword(kind, headword),
      gloss,
      module: '',
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    })
    store.addEntryCount('m1', 1, now)
  }
  insert('e_noise', 'task', 'stats --- chars 2698 estTokens 675…', '--- stats --- ...')
  insert('e_advice', 'task', '如果你选择 DeepSeek-only 路线', 'advice')
  insert('e_real', 'task', '加一个 router 视图', 'real work')
  insert('e_feature', 'feature', '实现注入链路', 'real feature')
  store.insertCitation({
    citeId: 'c_real', entryId: 'e_real', sessionId: 'm1', seqStart: 1, seqEnd: 1,
    excerpt: '请修改 plugin/flow-tower/index.js 并加一个 router 视图', createdAt: now,
  })
  store.insertCitation({
    citeId: 'c_feature', entryId: 'e_feature', sessionId: 'm1', seqStart: 2, seqEnd: 2,
    excerpt: '在 plugin/flow-tower/lib/web.js 实现注入链路', createdAt: now,
  })

  const report = runMaintenance(store, 'm1')
  const archived = report.archived.map((item) => item.entryId).sort()
  assert.deepEqual(archived, ['e_advice', 'e_noise'])
  assert.equal(store.getEntry('e_noise'), null, 'archived entries are removed from the active dictionary')
  assert.ok(report.attributed >= 2, JSON.stringify(report))
  assert.equal(store.getEntry('e_real').module, 'plugin/flow-tower')
  assert.equal(store.getEntry('e_feature').module, 'plugin/flow-tower')
  // Idempotent for the same dictionary version.
  assert.equal(runMaintenance(store, 'm1').skipped, true)
})

test('code health: bounded scan reports oversize source files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-tower-health-'))
  try {
    const moduleDir = join(dir, 'src', 'module')
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(moduleDir, 'big.ts'), `${'// line\n'.repeat(WARN_LINES + 5)}`, 'utf8')
    writeFileSync(join(moduleDir, 'small.ts'), 'export const x = 1\n', 'utf8')
    writeFileSync(join(moduleDir, 'notes.txt'), 'ignored\n', 'utf8')
    const debt = moduleDebt(dir, 'src/module')
    assert.ok(debt !== null)
    assert.equal(debt.files, 2)
    assert.equal(debt.oversize, 1)
    assert.match(debt.largest.path, /big\.ts$/)
    assert.equal(moduleDebt(dir, '(root)'), null)
    assert.equal(moduleDebt(dir, ''), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('adaptive budget: unknown pressure keeps base, high pressure shrinks and floors', () => {
  assert.equal(adaptDigestBudget(2000, undefined, undefined), 2000)
  assert.equal(adaptDigestBudget(2000, 100, 100000), 2000)
  assert.equal(adaptDigestBudget(2000, 60000, 100000), 1400)
  assert.equal(adaptDigestBudget(2000, 75000, 100000), 1000)
  assert.equal(adaptDigestBudget(2000, 90000, 100000), 600)
  assert.equal(adaptDigestBudget(400, 90000, 100000), 400, 'never shrinks below the floor')
  assert.equal(adaptDigestBudget(0, 90000, 100000), 0, 'invalid base passes through')
})

test('injection policy: checkpoint age and task classification', () => {
  const checkpointText = 'This is an automatically generated checkpoint condensing an earlier span of the conversation. <compacted-summary># summary</compacted-summary>'
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '修改 src/compiler.js 并跑测试' }] },
    { role: 'assistant', content: [{ type: 'tool-call', name: 'edit', arguments: '{}' }] },
    { role: 'tool', source: { toolName: 'edit' }, content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: checkpointText }] },
    { role: 'assistant', content: [{ type: 'text', text: '继续' }] },
    { role: 'user', content: [{ type: 'text', text: '再补一个测试' }] },
  ]
  const checkpoint = detectCheckpoint(messages)
  assert.equal(checkpoint.present, true)
  assert.equal(checkpoint.index, 3)
  assert.equal(checkpoint.ageMessages, 2)
  assert.equal(checkpoint.ageTurns, 1)
  assert.equal(detectCheckpoint(messages.slice(0, 3)).present, false)
  assert.equal(classifyTask(messages), 'coding')
  assert.equal(classifyTask([
    { role: 'user', content: [{ type: 'text', text: '咱们吸纳一下 dsh 的机制，做好规划，争取尽快结案' }] },
  ]), 'planning')
  assert.equal(classifyTask([
    { role: 'user', content: [{ type: 'text', text: '之前提到的 prompt 层做了吗？' }] },
  ]), 'history')
  assert.equal(classifyTask([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]), 'general')
})

test('status: lastSummarize merges engine memory line with the event line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-tower-runlog-'))
  try {
    mkdirSync(join(dir, '.flow-tower'), { recursive: true })
    const file = join(dir, '.flow-tower', 'compaction-runs.jsonl')
    const time = 1_794_713_542_237
    const config = resolveConfig({ storageMode: 'project' })
    writeFileSync(file, [
      JSON.stringify({ time: time - 25_000, backend: 'FlowTowerCompactionEngine', ok: true, memoryChars: 1234, injectedMessages: 1 }),
      JSON.stringify({ time, backend: 'FlowTowerCompactionEngine', source: 'event', ok: true, compactionId: 'cmp-merge', summaryChars: 100, compactedSeqs: 5 }),
    ].join('\n') + '\n')
    const merged = lastSummarizeRun(config, dir)
    assert.equal(merged.compactionId, 'cmp-merge')
    assert.equal(merged.memoryChars, 1234, 'engine line memoryChars must surface in status')
    assert.equal(merged.injectedMessages, 1)
    assert.equal(merged.engine, 'engine')
    // An engine line from an older compaction must never be merged into a new event line.
    writeFileSync(file, [
      JSON.stringify({ time: time - 3_600_000, backend: 'FlowTowerCompactionEngine', ok: true, memoryChars: 999 }),
      JSON.stringify({ time, backend: 'FlowTowerCompactionEngine', source: 'event', ok: true, compactionId: 'cmp-merge-2' }),
    ].join('\n') + '\n')
    const stale = lastSummarizeRun(config, dir)
    assert.equal(stale.memoryChars, undefined, 'stale engine evidence must not be attached')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('injection policy: head checkpoint survives a long post-compaction tool tail', () => {
  const checkpoint = {
    role: 'user',
    content: [{ type: 'text', text: '<compacted-summary>\n# summary\n</compacted-summary>' }],
  }
  const messages = [checkpoint]
  for (let index = 0; index < 200; index += 1) {
    messages.push({
      role: index % 2 === 0 ? 'assistant' : 'tool',
      content: [{ type: 'text', text: `tool payload ${index}` }],
    })
  }
  const detected = detectCheckpoint(messages)
  assert.equal(detected.present, true, 'checkpoint lives at the head, not the tail')
  assert.equal(detected.index, 0)
  assert.ok(detected.ageTurns > 2, 'a long tail makes the checkpoint stale')
  const plan = resolveInjectionPlan({ config: resolveConfig(), checkpoint: detected, taskKind: 'coding' })
  assert.equal(plan.mode, 'dual', 'stale checkpoint gets the full dual digest, not long-only')
})

test('injection policy: auto matrix chooses dual, dual-lite, long-only, short-only', () => {
  const base = resolveConfig()
  const fresh = { present: true, ageTurns: 0 }
  assert.equal(resolveInjectionPlan({ config: base, checkpoint: fresh, taskKind: 'coding' }).mode, 'dual-lite')
  assert.equal(resolveInjectionPlan({ config: base, checkpoint: fresh, taskKind: 'research' }).mode, 'dual-lite')
  assert.equal(resolveInjectionPlan({ config: base, checkpoint: fresh, taskKind: 'planning' }).mode, 'dual')
  assert.equal(resolveInjectionPlan({ config: base, checkpoint: { present: true, ageTurns: 5 }, taskKind: 'coding' }).mode, 'dual')
  assert.equal(resolveInjectionPlan({ config: base, checkpoint: fresh, taskKind: 'general' }).mode, 'short-only')
  assert.equal(resolveInjectionPlan({ config: base, checkpoint: fresh, taskKind: 'coding', pressureRatio: 0.9 }).mode, 'short-only')
  assert.equal(resolveInjectionPlan({ config: base, checkpoint: { present: false, ageTurns: 0 }, taskKind: 'coding' }).mode, 'long-only')
  assert.equal(resolveInjectionPlan({ config: { ...base, injectionMode: 'dual' }, checkpoint: fresh, taskKind: 'general' }).mode, 'dual')
  assert.equal(resolveInjectionPlan({ config: { ...base, injectionMode: 'off' }, checkpoint: fresh, taskKind: 'coding' }).mode, 'off')
})

test('multi-agent: a session without a volume reads the shared project digest', async () => {
  const { store, config } = freshStore()
  const compiler = new Compiler({ store, config, log: createNoopLogger() })
  const session = createFakeSession({ id: 'agent-main', cwd: 'E:/project/agent-team' })
  const seqs = seedConversation(session)
  compiler.ingest(session, session.addCompaction({ compactionId: 'cmp-agent-shared', seqs, summary: '项目级记忆。' }))
  await compiler.drain()
  const text = buildSharedDigest(store, 'E:/project/agent-team', config)
  assert.match(text, /Shared project (?:brief|map)/)
  assert.match(text, /Shared: this session has no dictionary yet/)
  assert.match(text, /add router view/)
  assert.equal(buildSharedDigest(store, 'E:/project/other', config), '', 'other projects are not shared')
})

test('multi-agent: shared digest aggregates open tasks across project sessions', async () => {
  const { store, config } = freshStore()
  const compiler = new Compiler({ store, config, log: createNoopLogger() })
  const main = createFakeSession({ id: 'agent-main-2', cwd: 'E:/project/agent-team-2' })
  compiler.ingest(main, main.addCompaction({ compactionId: 'cmp-team-a', seqs: seedConversation(main), summary: '主代理摘要。' }))
  await compiler.drain()
  const child = createFakeSession({ id: 'agent-child-2', cwd: 'E:/project/agent-team-2' })
  const childSeq = child.addUser('TODO: implement team handoff protocol.')
  compiler.ingest(child, child.addCompaction({ compactionId: 'cmp-team-b', seqs: [childSeq], summary: '子代理任务。' }))
  await compiler.drain()
  const text = buildSharedDigest(store, 'E:/project/agent-team-2', config)
  assert.match(text, /team handoff/i, 'shared digest must show tasks opened by other agents')
  assert.match(text, /Shared: this session has no dictionary yet/)
})

test('injection policy: dual-lite digest omits recency, long-only keeps progress', async () => {
  const { store, config } = freshStore()
  const compiler = new Compiler({ store, config, log: createNoopLogger() })
  const session = createFakeSession()
  const seqs = seedConversation(session)
  compiler.ingest(session, session.addCompaction({ compactionId: 'cmp-plan-unit', seqs, summary: '采用观察式接入。' }))
  await compiler.drain()

  const dualLite = resolveInjectionPlan({ config, checkpoint: { present: true, ageTurns: 0 }, taskKind: 'coding', pressureRatio: 0.2 })
  const liteText = buildDigest(store, session.id, { ...config, injectionPlan: dualLite })
  assert.match(liteText, /inject: dual-lite/)
  assert.match(liteText, /task: coding/)
  assert.doesNotMatch(liteText, /Progress:/)
  assert.doesNotMatch(liteText, /Change log:/)

  const longOnly = resolveInjectionPlan({ config, checkpoint: { present: false, ageTurns: 0 }, taskKind: 'coding', pressureRatio: 0.2 })
  const longText = buildDigest(store, session.id, { ...config, injectionPlan: longOnly })
  assert.match(longText, /inject: long-only/)
  assert.match(longText, /Progress:/)
})

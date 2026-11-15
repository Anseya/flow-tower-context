#!/usr/bin/env node
/**
 * Real-session integration eval: replays a persisted DSH session log through the
 * real compiler + tools (no harness process, no LLM), using the actual message
 * history as the compile input.
 *
 * What it proves:
 * - extraction/compilation works on real conversations, not only fixtures;
 * - project/module/feature/task/time dimensions populate from real content;
 * - dict_browse / dict_lookup / dict_cite / dict_timeline work end-to-end;
 * - dict_cite replays the exact original message text.
 *
 * Run: node eval/real-session-eval.mjs [--file=<path>] [--json]
 * Default: the most recently modified `session.v4.jsonl.zstd` under $DSH_HOME/sessions.
 */

import { zstdDecompressSync } from 'node:zlib'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { FlowStore } from '../lib/store.js'
import { Compiler } from '../lib/compiler.js'
import { buildDigest } from '../lib/catalog.js'
import { buildToolDefinitions } from '../lib/tools.js'
import { projectEventMessage } from '../lib/session-read.js'
import { contentToText, estimateTokens, normalizeProjectPath } from '../lib/util.js'
import { createNoopLogger } from '../test/fixtures.js'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decompress a session log: one plaintext header line followed by concatenated
 * independent zstd frames (one per append batch).
 * @param {string} file
 * @returns {{ header: any, events: any[] }}
 */
function loadSessionLog(file) {
  const raw = readFileSync(file)
  const offsets = []
  let index = raw.indexOf(ZSTD_MAGIC, 0)
  while (index >= 0) {
    offsets.push(index)
    index = raw.indexOf(ZSTD_MAGIC, index + 4)
  }
  if (offsets.length === 0) throw new Error('not a zstd session log')
  let text = offsets[0] > 0 ? raw.subarray(0, offsets[0]).toString('utf8') : ''
  for (let frame = 0; frame < offsets.length; frame += 1) {
    const end = frame + 1 < offsets.length ? offsets[frame + 1] : raw.length
    text += zstdDecompressSync(raw.subarray(offsets[frame], end)).toString('utf8')
  }
  const lines = text.split('\n').filter((line) => line.length > 0)
  const header = JSON.parse(lines[0])
  const events = []
  for (const line of lines.slice(1)) {
    try {
      const event = JSON.parse(line)
      if (Number.isSafeInteger(event?.seq)) events.push(event)
    } catch {
      // Skip a malformed trailing append.
    }
  }
  return { header, events }
}

/** @returns {string} */
function findDefaultSessionFile() {
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
  /** @type {{ file: string, mtime: number, size: number }[]} */
  const found = []
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'session.v4.jsonl.zstd') {
        const stat = statSync(full)
        if (stat.size < 12 * 1024 * 1024) found.push({ file: full, mtime: stat.mtimeMs, size: stat.size })
      }
    }
  }
  walk(root)
  found.sort((left, right) => right.mtime - left.mtime)
  if (found.length === 0) throw new Error(`no session log found under ${root}`)
  return found[0].file
}

/** Build a Session-like adapter over recorded events. */
function createReplaySession(header, events) {
  const bySeq = new Map()
  for (const event of events) bySeq.set(event.seq, event)
  return {
    id: header.id,
    header: { cwd: header.cwd },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => projectEventMessage(event),
  }
}

/** @param {any[]} events @returns {number[]} */
function messageSeqs(events) {
  const types = new Set(['user/message', 'assistant/message', 'tool/result'])
  return events.filter((event) => types.has(event.type)).map((event) => event.seq)
}

/** Build one synthetic compaction event over the given seqs. */
function compactionEvent(header, seqs, index, summaryText) {
  const sorted = [...seqs].sort((a, b) => a - b)
  return {
    type: 'compaction/summary',
    seq: 900000 + index,
    time: (header.createdAt ?? Date.now()) + index * 1000,
    data: {
      compactionId: `real-eval-${index}`,
      summary: [{ type: 'text', text: summaryText }],
      shadowedRange: { start: sorted[0], end: sorted[sorted.length - 1] },
      shadowedSeqs: sorted,
      shadowedTokenCount: 10000,
      provider: 'replay',
      model: 'replay',
    },
  }
}

/** @param {any} ctx @param {any} store @param {any} config @param {any} session @param {any[]} events */
async function runEval({ file, jsonMode }) {
  const startedAt = Date.now()
  const { header, events } = loadSessionLog(file)
  const session = createReplaySession(header, events)
  const seqs = messageSeqs(events)
  if (seqs.length < 10) throw new Error(`session has too few message events (${seqs.length})`)

  const config = resolveConfig()
  const store = FlowStore.open({ dbPath: ':memory:' })
  const compiler = new Compiler({
    store,
    config,
    log: createNoopLogger(),
    readEvents: async () => events,
  })

  // Two compaction rounds over the real history: the second only compiles its delta.
  const firstRound = seqs.slice(0, Math.floor(seqs.length * 0.6))
  compiler.ingest(session, compactionEvent(header, firstRound, 1, '真实会话回放：第一段上下文压缩摘要。'))
  await compiler.drain()
  const afterFirst = store.getVolume(session.id)?.entryCount ?? 0
  compiler.ingest(session, compactionEvent(header, seqs, 2, '真实会话回放：第二段上下文压缩摘要。'))
  await compiler.drain()

  const volume = store.getVolume(session.id)
  const counts = store.countByKind(session.id)
  const openTasks = store.openTasks(session.id, 50)
  const doneTasks = store.listEntries(session.id, { kind: 'task', status: 'done', limit: 50 })
  const modules = store.recentModules(session.id, 10)
  const digest = buildDigest(store, session.id, config)

  const tools = buildToolDefinitions({ ctx: { get: () => undefined }, store, config, log: createNoopLogger() })
  const exec = { agent: { session }, signal: new AbortController().signal }
  const browse = await tools[0].execute({ volume: session.id }, exec)
  const timeline = await tools[3].execute({ volume: session.id }, exec)

  // Pick the first entry with a citation for lookup/cite fidelity.
  const entries = store.listEntries(session.id, { limit: 500 })
  let citeCheck = { attempted: false, fidelity: false, lookupHit: false, citeCount: 0 }
  for (const entry of entries) {
    const citations = store.citationsFor(entry.entryId)
    if (citations.length === 0) continue
    const citation = citations[0]
    const lookup = await tools[1].execute({ term: entry.headword, volume: session.id }, exec)
    const cite = await tools[2].execute({ cite_id: citation.citeId }, exec)
    const sourceEvent = session.eventAt(citation.seqStart)
    const sourceMessage = sourceEvent === undefined ? null : projectEventMessage(sourceEvent)
    const sourceText = sourceMessage === null ? '' : contentToText(sourceMessage.content)
    const needle = sourceText.replace(/\s+/g, ' ').slice(0, 60)
    citeCheck = {
      attempted: true,
      lookupHit: /Definition:/.test(lookup.text),
      citeHit: /# citation/.test(cite.text),
      citeCount: cite.text.split('\n').filter((line) => line.startsWith('[#')).length,
      fidelity: needle.length > 0 && cite.text.replace(/\s+/g, ' ').includes(needle),
      term: entry.headword,
    }
    break
  }

  // Time filter proof: a window in the future must empty the citation list.
  const future = (events[events.length - 1]?.time ?? Date.now()) + 86_400_000
  const filtered = await tools[1].execute({ term: citeCheck.term ?? entries[0]?.headword ?? 'x', volume: session.id, since: new Date(future).toISOString() }, exec)

  const report = {
    file,
    session: { id: header.id, cwd: header.cwd, preset: header.agentPreset },
    events: events.length,
    messageEvents: seqs.length,
    compile: {
      entriesAfterFirstRound: afterFirst,
      entries: volume?.entryCount ?? 0,
      kinds: counts,
      project: volume?.project ?? '',
      openTasks: openTasks.length,
      doneTasks: doneTasks.length,
      modules: modules.map((item) => item.module),
      digestTokens: estimateTokens(digest),
    },
    tools: {
      browseLines: browse.text.split('\n').length,
      timelineEntries: timeline.text.split('\n').filter((line) => line.startsWith('- ')).length,
      lookupHit: citeCheck.lookupHit === true,
      citeFidelity: citeCheck.fidelity === true,
      citeMessages: citeCheck.citeCount ?? 0,
      timeFilterEmpty: /none in range|No citation/i.test(filtered.text),
    },
    elapsedMs: Date.now() - startedAt,
  }

  const failed = report.compile.entries < 10
    || report.tools.timelineEntries < 10
    || report.tools.lookupHit !== true
    || report.tools.citeFidelity !== true
    || report.compile.digestTokens > 500
    || report.compile.openTasks + report.compile.doneTasks < 1
    || report.compile.project !== normalizeProjectPath(header.cwd)

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`flow-tower real-session eval: ${failed ? 'FAIL' : 'PASS'}\n`)
    process.stdout.write(`  session=${report.session.id} events=${report.events} messages=${report.messageEvents}\n`)
    process.stdout.write(`  entries=${report.compile.entries} (after round1 ${report.compile.entriesAfterFirstRound}) kinds=${JSON.stringify(report.compile.kinds)}\n`)
    process.stdout.write(`  project=${report.compile.project} modules=${JSON.stringify(report.compile.modules)}\n`)
    process.stdout.write(`  openTasks=${report.compile.openTasks} doneTasks=${report.compile.doneTasks} digestTokens=${report.compile.digestTokens}\n`)
    process.stdout.write(`  browseLines=${report.tools.browseLines} timelineEntries=${report.tools.timelineEntries} lookupHit=${report.tools.lookupHit} citeFidelity=${report.tools.citeFidelity} citeMessages=${report.tools.citeMessages} timeFilterEmpty=${report.tools.timeFilterEmpty}\n`)
  }
  store.close()
  process.exitCode = failed ? 1 : 0
}

const args = process.argv.slice(2)
const fileArg = args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length)
const file = fileArg ?? findDefaultSessionFile()
await runEval({ file, jsonMode: args.includes('--json') }).catch((error) => {
  console.error('flow-tower real-session eval crashed:', error)
  process.exitCode = 2
})

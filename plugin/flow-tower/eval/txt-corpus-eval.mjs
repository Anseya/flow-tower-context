#!/usr/bin/env node
/**
 * Large-text corpus eval: feeds one or more UTF-8 text files through the real
 * compiler as a simulated session, then measures dictionary yield, ceilings,
 * lookup/cite fidelity and database size. This is the scale/boundary probe for
 * asking "how much can one tower hold?" — no Harness process and no LLM calls.
 *
 * Run:
 *   node eval/txt-corpus-eval.mjs --file=<a.txt>[,<b.txt>] [--json]
 *        [--chunk-chars=1200] [--rounds=2] [--max-chars=2000000]
 *
 * Notes:
 * - Text is chunked into user-role messages (~1.2K chars each), mimicking a
 *   long loaded document inside a conversation that later gets compacted.
 * - Prose-heavy corpora (novels) produce fewer technical headwords than code
 *   logs; the report prints entries-per-10KB so that gap is visible.
 */

import { readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { FlowStore } from '../lib/store.js'
import { Compiler } from '../lib/compiler.js'
import { buildDigest } from '../lib/catalog.js'
import { buildToolDefinitions } from '../lib/tools.js'
import { projectEventMessage } from '../lib/session-read.js'
import { contentToText, estimateTokens } from '../lib/util.js'
import { createNoopLogger } from '../test/fixtures.js'

/** @param {string[]} args */
function parseArgs(args) {
  const files = []
  const options = { chunkChars: 1200, rounds: 2, maxChars: 2_000_000, json: args.includes('--json') }
  for (const arg of args) {
    if (arg.startsWith('--file=')) {
      files.push(...arg.slice('--file='.length).split(',').map((item) => item.trim()).filter(Boolean))
    } else if (arg.startsWith('--chunk-chars=')) options.chunkChars = Number(arg.split('=')[1]) || 1200
    else if (arg.startsWith('--rounds=')) options.rounds = Math.max(1, Number(arg.split('=')[1]) || 2)
    else if (arg.startsWith('--max-chars=')) options.maxChars = Number(arg.split('=')[1]) || 2_000_000
  }
  return { files, options }
}

/**
 * Decode a text file, preferring UTF-8 and falling back to GB18030 (common for
 * Chinese novels) when the buffer is not valid UTF-8.
 * @param {string} file
 * @returns {{ text: string, encoding: string }}
 */
function decodeTextFile(file) {
  const raw = readFileSync(file)
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(raw), encoding: 'utf-8' }
  } catch {
    return { text: new TextDecoder('gb18030').decode(raw), encoding: 'gb18030' }
  }
}

/**
 * Build synthetic session events from chunked text.
 * @param {string} text
 * @param {number} chunkChars
 * @returns {{ events: any[], messageSeqs: number[] }}
 */
function buildSessionFromText(text, chunkChars) {
  const events = []
  const messageSeqs = []
  const createdAt = Date.now() - 60 * 60 * 1000
  events.push({
    type: 'session',
    version: 4,
    id: 'txt-corpus-session',
    createdAt,
    cwd: 'E:/corpus/project',
    isSeeded: false,
    agentPreset: 'standard',
  })
  let seq = 0
  for (let offset = 0; offset < text.length; offset += chunkChars) {
    const chunk = text.slice(offset, offset + chunkChars)
    const time = createdAt + seq * 1000
    events.push({
      type: 'user/message',
      seq,
      time,
      data: {
        id: `txt-${seq}`,
        role: 'user',
        content: [{ type: 'text', text: chunk }],
        source: { kind: 'user' },
      },
    })
    messageSeqs.push(seq)
    seq += 1
  }
  return { events, messageSeqs }
}

/** @param {{ id: string, cwd: string }} header @param {any[]} events */
function replaySession(header, events) {
  const bySeq = new Map()
  for (const event of events) if (Number.isSafeInteger(event.seq)) bySeq.set(event.seq, event)
  return {
    id: header.id,
    header: { cwd: header.cwd },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => projectEventMessage(event),
  }
}

/** Build one synthetic compaction event over a seq window. */
function compactionEvent(index, seqs, summaryText) {
  const sorted = [...seqs].sort((a, b) => a - b)
  return {
    type: 'compaction/summary',
    seq: 900000 + index,
    time: Date.now() + index,
    data: {
      compactionId: `txt-corpus-${index}`,
      summary: [{ type: 'text', text: summaryText }],
      shadowedRange: { start: sorted[0], end: sorted[sorted.length - 1] },
      shadowedSeqs: sorted,
      shadowedTokenCount: 10000,
      provider: 'corpus',
      model: 'corpus',
    },
  }
}

async function main() {
  const { files, options } = parseArgs(process.argv.slice(2))
  if (files.length === 0) {
    process.stderr.write('usage: node eval/txt-corpus-eval.mjs --file=<a.txt>[,<b.txt>] [--json]\n')
    process.exitCode = 2
    return
  }
  const startedAt = Date.now()
  let text = ''
  /** @type {{ path: string, chars: number, encoding: string }[]} */
  const sources = []
  for (const file of files) {
    const decoded = decodeTextFile(file)
    sources.push({ path: file, chars: decoded.text.length, encoding: decoded.encoding })
    text += `${decoded.text}\n`
    if (text.length >= options.maxChars) {
      text = text.slice(0, options.maxChars)
      break
    }
  }

  const { events, messageSeqs } = buildSessionFromText(text, options.chunkChars)
  const session = replaySession({ id: 'txt-corpus-session', cwd: 'E:/corpus/project' }, events)
  const config = resolveConfig()
  const dbPath = join(tmpdir(), `flow-tower-corpus-${process.pid}.db`)
  const store = FlowStore.open({ dbPath })
  const compiler = new Compiler({ store, config, log: createNoopLogger(), readEvents: async () => events })

  const compileStart = Date.now()
  const roundSize = Math.max(1, Math.floor(messageSeqs.length * 0.5))
  compiler.ingest(session, compactionEvent(1, messageSeqs.slice(0, roundSize), '大型文本语料：前半段。'))
  await compiler.drain()
  const afterFirst = store.getVolume(session.id)?.entryCount ?? 0
  for (let round = 2; round <= options.rounds; round += 1) {
    compiler.ingest(session, compactionEvent(round, messageSeqs, `大型文本语料：第 ${round} 轮全量。`))
    await compiler.drain()
  }
  const compileMs = Date.now() - compileStart

  const volume = store.getVolume(session.id)
  const counts = store.countByKind(session.id)
  const entries = store.listEntries(session.id, { limit: 500 })
  const lastCompile = store.recentMetrics({ kind: 'compile', limit: 1 })[0]?.data ?? {}
  const digest = buildDigest(store, session.id, config)
  const tools = buildToolDefinitions({ ctx: { get: () => undefined }, store, config, log: createNoopLogger() })
  const exec = { agent: { session }, signal: new AbortController().signal }

  // Lookup fidelity over a sample of entries (bounded work).
  const sample = entries.slice(0, 20)
  let lookupHits = 0
  let citeOk = 0
  let citeTried = 0
  for (const entry of sample) {
    const lookup = await tools[1].execute({ term: entry.headword, volume: session.id }, exec)
    if (lookup.text.startsWith('## ')) lookupHits += 1
    const citations = store.citationsFor(entry.entryId)
    if (citations.length === 0) continue
    citeTried += 1
    const cite = await tools[2].execute({ cite_id: citations[0].citeId }, exec)
    const source = session.eventAt(citations[0].seqStart)
    const message = source === undefined ? null : projectEventMessage(source)
    const sourceText = message === null ? '' : contentToText(message.content)
    const needle = sourceText.replace(/\s+/g, ' ').slice(0, 60)
    if (needle.length > 0 && cite.text.replace(/\s+/g, ' ').includes(needle)) citeOk += 1
  }
  const timeline = await tools[3].execute({ volume: session.id, limit: 20 }, exec)

  // Fold the WAL back into the main file so the reported size is meaningful.
  try {
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    // Size still reported from the main file if the checkpoint is unavailable.
  }
  const dbBytes = statSync(dbPath).size
  const report = {
    sources,
    inputChars: text.length,
    chunkChars: options.chunkChars,
    messages: messageSeqs.length,
    rounds: options.rounds,
    compileMs,
    entries: volume?.entryCount ?? 0,
    entriesAfterFirstRound: afterFirst,
    maxEntries: config.maxEntries,
    capReached: (volume?.entryCount ?? 0) >= config.maxEntries,
    evictedLastRound: lastCompile.evicted ?? 0,
    tasksClosedLastRound: lastCompile.tasksClosed ?? 0,
    entriesPer10KB: Number((((volume?.entryCount ?? 0) / Math.max(1, text.length / 10_000))).toFixed(2)),
    kinds: counts,
    dbBytes,
    digestTokens: estimateTokens(digest),
    lookupHitRate: sample.length === 0 ? null : Number((lookupHits / sample.length).toFixed(3)),
    citeFidelity: citeTried === 0 ? null : Number((citeOk / citeTried).toFixed(3)),
    timelineLines: timeline.text.split('\n').filter((line) => line.startsWith('- ')).length,
    elapsedMs: Date.now() - startedAt,
  }

  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else {
    process.stdout.write('flow-tower large-text corpus eval\n')
    process.stdout.write(`  input=${report.inputChars} chars from ${sources.length} file(s); messages=${report.messages}; chunk=${options.chunkChars}\n`)
    process.stdout.write(`  entries=${report.entries} (after round 1 ${report.entriesAfterFirstRound}; cap ${report.maxEntries} reached=${report.capReached}; entries/10KB=${report.entriesPer10KB})\n`)
    process.stdout.write(`  kinds=${JSON.stringify(report.kinds)}\n`)
    process.stdout.write(`  compileMs=${report.compileMs} dbBytes=${report.dbBytes} digestTokens=${report.digestTokens}\n`)
    process.stdout.write(`  lookupHitRate=${report.lookupHitRate} citeFidelity=${report.citeFidelity} timelineLines=${report.timelineLines}\n`)
  }
  store.close()
  rmSync(dbPath, { force: true })
}

await main().catch((error) => {
  console.error('flow-tower corpus eval crashed:', error)
  process.exitCode = 2
})

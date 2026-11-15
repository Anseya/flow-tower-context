#!/usr/bin/env node
/**
 * Long-session E2E eval: replays a real persisted session through the real
 * compiler across N cumulative compaction rounds (plus one duplicate round),
 * measuring per-round compile time, entries, relation edges, DB growth and
 * digest size. Proves how the pipeline scales over a long session and that
 * empty/idempotent rounds are cheap.
 *
 * Run: node eval/long-session-eval.mjs [--file=<session.v4.jsonl.zstd>]
 *        [--rounds=8] [--json]
 * Default: the most recently modified small session log under $DSH_HOME/sessions.
 */

import { zstdDecompressSync } from 'node:zlib'
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { FlowStore } from '../lib/store.js'
import { Compiler } from '../lib/compiler.js'
import { buildDigest } from '../lib/catalog.js'
import { projectEventMessage } from '../lib/session-read.js'
import { contentToText, estimateTokens, normalizeProjectPath } from '../lib/util.js'
import { createNoopLogger } from '../test/fixtures.js'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** @param {string} file */
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
      // Skip malformed trailing append.
    }
  }
  return { header, events }
}

/** @returns {string} */
function findDefaultSessionFile() {
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'session.v4.jsonl.zstd') {
        const stat = statSync(full)
        if (stat.size > 200_000 && stat.size < 12 * 1024 * 1024) found.push({ file: full, mtime: stat.mtimeMs, size: stat.size })
      }
    }
  }
  walk(root)
  found.sort((left, right) => right.mtime - left.mtime)
  if (found.length === 0) throw new Error(`no session log found under ${root}`)
  return found[0].file
}

/** @param {any} header @param {any[]} events */
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

/** @param {any} header @param {number[]} seqs @param {number} index @param {string} text */
function compactionEvent(header, seqs, index, text) {
  const sorted = [...seqs].sort((a, b) => a - b)
  return {
    type: 'compaction/summary',
    seq: 900000 + index,
    time: (header.createdAt ?? Date.now()) + index * 1000,
    data: {
      compactionId: `long-eval-${index}`,
      summary: [{ type: 'text', text }],
      shadowedRange: { start: sorted[0], end: sorted[sorted.length - 1] },
      shadowedSeqs: sorted,
      shadowedTokenCount: 10000,
      provider: 'replay',
      model: 'replay',
    },
  }
}

const args = process.argv.slice(2)
const file = args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length) ?? findDefaultSessionFile()
const roundsOption = Number(args.find((arg) => arg.startsWith('--rounds='))?.split('=')[1] ?? 8) || 8
const json = args.includes('--json')

const { header, events } = loadSessionLog(file)
const seqs = messageSeqs(events)
const rounds = Math.max(2, Math.min(20, roundsOption))
const dbPath = join(tmpdir(), `flow-tower-long-${process.pid}.db`)
const store = FlowStore.open({ dbPath })
const config = resolveConfig()
const session = createReplaySession(header, events)
const compiler = new Compiler({
  store,
  config,
  log: createNoopLogger(),
  readEvents: async () => events,
})

/** @type {any[]} */
const roundReports = []
let previousEntries = 0
const startedAt = Date.now()
try {
  for (let round = 0; round < rounds; round += 1) {
    const coveredCount = Math.max(1, Math.floor((seqs.length * (round + 1)) / rounds))
    const shadowed = seqs.slice(0, coveredCount)
    const started = Date.now()
    compiler.ingest(session, compactionEvent(header, shadowed, round, `长会话回放第 ${round + 1} 轮。`))
    await compiler.drain()
    const ms = Date.now() - started
    const volume = store.getVolume(session.id)
    const entries = volume?.entryCount ?? 0
    try {
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // WAL checkpoint may be busy.
    }
    const dbBytes = statSync(dbPath).size
    const digest = buildDigest(store, session.id, config)
    const relationCount = store.db.prepare(
      'SELECT COUNT(1) AS n FROM relations WHERE from_volume = ? OR to_volume = ?',
    ).get(session.id, session.id)
    const metrics = store.db.prepare(
      "SELECT data FROM metrics WHERE kind='compile' AND volume_id=? ORDER BY id DESC LIMIT 1",
    ).get(session.id)
    let compileData = null
    try {
      compileData = metrics === undefined ? null : JSON.parse(metrics.data)
    } catch {
      compileData = null
    }
    roundReports.push({
      round: round + 1,
      messagesCovered: shadowed.length,
      deltaNew: compileData?.deltaSeqs ?? null,
      created: compileData?.created ?? null,
      updated: compileData?.updated ?? null,
      citations: compileData?.citations ?? null,
      emptyRound: compileData?.emptyRound ?? null,
      ms,
      entries,
      entriesAdded: entries - previousEntries,
      relations: Number(relationCount?.n ?? 0),
      digestTokens: estimateTokens(digest),
      dbBytes,
      version: volume?.version ?? null,
    })
    previousEntries = entries
  }

  // Duplicate/idempotent round: same shadowed range must be a cheap no-op.
  const duplicateStarted = Date.now()
  compiler.ingest(session, compactionEvent(header, seqs, 900, '重复压缩（幂等性检查）。'))
  await compiler.drain()
  const duplicateMs = Date.now() - duplicateStarted
  const duplicateEntries = store.getVolume(session.id)?.entryCount ?? 0

  // Citation fidelity sample.
  const entries = store.listEntries(session.id, { limit: 200 })
  let citeOk = 0
  let citeTried = 0
  for (const entry of entries.slice(0, 20)) {
    const citations = store.citationsFor(entry.entryId)
    if (citations.length === 0) continue
    citeTried += 1
    const event = session.eventAt(citations[0].seqStart)
    const message = event === undefined ? null : projectEventMessage(event)
    const source = message === null ? '' : contentToText(message.content).replace(/\s+/g, ' ')
    if (source.includes(citations[0].excerpt.replace(/\s+/g, ' ').slice(0, 30))) citeOk += 1
  }

  const report = {
    file,
    session: header.id,
    project: normalizeProjectPath(header.cwd ?? ''),
    events: events.length,
    messages: seqs.length,
    rounds,
    roundsDetail: roundReports,
    duplicateRoundMs: duplicateMs,
    duplicateAdded: duplicateEntries - previousEntries,
    finalEntries: duplicateEntries,
    finalRelations: roundReports[roundReports.length - 1]?.relations ?? 0,
    finalDbBytes: statSync(dbPath).size,
    totalMs: Date.now() - startedAt,
    citeFidelity: citeTried === 0 ? null : Number((citeOk / citeTried).toFixed(3)),
    pass: roundReports.every((item) => item.ms < 15000)
      && duplicateEntries === previousEntries
      && roundReports[roundReports.length - 1].entries > 0,
  }
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else {
    process.stdout.write('flow-tower long-session E2E\n')
    process.stdout.write(`  session=${report.session} events=${report.events} messages=${report.messages} rounds=${rounds}\n`)
    for (const item of roundReports) {
      process.stdout.write(`  round ${item.round}: covered=${item.messagesCovered} delta=${item.deltaNew} created=${item.created} updated=${item.updated} ms=${item.ms} entries=${item.entries} (+${item.entriesAdded}) relations=${item.relations} digest=${item.digestTokens} db=${item.dbBytes}\n`)
    }
    process.stdout.write(`  duplicate round: ms=${duplicateMs} added=${report.duplicateAdded}\n`)
    process.stdout.write(`  final entries=${report.finalEntries} relations=${report.finalRelations} dbBytes=${report.finalDbBytes} totalMs=${report.totalMs} citeFidelity=${report.citeFidelity} pass=${report.pass}\n`)
  }
  process.exitCode = report.pass ? 0 : 1
} finally {
  store.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
}

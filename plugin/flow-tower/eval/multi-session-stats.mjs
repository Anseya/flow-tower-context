#!/usr/bin/env node
/**
 * Multi-session longitudinal stats: scans persisted DSH session logs, counts
 * compactions/messages per session, and joins each session with its project
 * dictionary (entries / injections / compile runs / relation edges).
 *
 * Run: node eval/multi-session-stats.mjs [--max=12] [--json]
 * Read-only: never writes dictionaries or session logs.
 */

import { zstdDecompressSync } from 'node:zlib'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FlowStore } from '../lib/store.js'
import { dbPathForProject } from '../lib/manager.js'
import { normalizeProjectPath } from '../lib/util.js'

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

/** @returns {{ file: string, mtime: number }[]} */
function findSessions(limit) {
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'session.v4.jsonl.zstd') {
        const stat = statSync(full)
        if (stat.size > 200_000 && stat.size < 12 * 1024 * 1024) found.push({ file: full, mtime: stat.mtimeMs })
      }
    }
  }
  walk(root)
  found.sort((left, right) => right.mtime - left.mtime)
  return found.slice(0, limit)
}

const args = process.argv.slice(2)
const max = Number(args.find((arg) => arg.startsWith('--max='))?.split('=')[1] ?? 12) || 12
const json = args.includes('--json')
const sessions = findSessions(max)
const storeCache = new Map()
const rows = []
for (const session of sessions) {
  let loaded
  try {
    loaded = loadSessionLog(session.file)
  } catch {
    continue
  }
  const { header, events } = loaded
  const messages = events.filter((event) => ['user/message', 'assistant/message', 'tool/result'].includes(event.type)).length
  const compactions = events.filter((event) => event.type === 'compaction/summary').length
  const project = normalizeProjectPath(header.cwd ?? '')
  let dictionary = null
  try {
    if (project.length > 0) {
      const path = dbPathForProject(project)
      let store = storeCache.get(path)
      if (store === undefined) {
        store = FlowStore.open({ dbPath: path })
        storeCache.set(path, store)
      }
      const volume = store.getVolume(header.id)
      if (volume !== null) {
        const injected = store.getInjectedState(header.id)
        const compileRuns = store.db.prepare(
          "SELECT COUNT(1) AS n FROM metrics WHERE kind='compile' AND volume_id = ?",
        ).get(header.id)
        const relations = store.db.prepare(
          'SELECT COUNT(1) AS n FROM relations WHERE from_volume = ? OR to_volume = ?',
        ).get(header.id, header.id)
        dictionary = {
          entries: volume.entryCount,
          injections: injected.injections,
          version: volume.version,
          compileRuns: Number(compileRuns?.n ?? 0),
          relations: Number(relations?.n ?? 0),
        }
      }
    }
  } catch {
    dictionary = null
  }
  rows.push({ session: header.id, project, messages, compactions, dictionary })
}
for (const store of storeCache.values()) store.close()

const totals = {
  sessions: rows.length,
  withCompactions: rows.filter((row) => row.compactions > 0).length,
  compactions: rows.reduce((sum, row) => sum + row.compactions, 0),
  messages: rows.reduce((sum, row) => sum + row.messages, 0),
  dictionarySessions: rows.filter((row) => row.dictionary !== null).length,
  entries: rows.reduce((sum, row) => sum + (row.dictionary?.entries ?? 0), 0),
  relations: rows.reduce((sum, row) => sum + (row.dictionary?.relations ?? 0), 0),
  injections: rows.reduce((sum, row) => sum + (row.dictionary?.injections ?? 0), 0),
  compileRuns: rows.reduce((sum, row) => sum + (row.dictionary?.compileRuns ?? 0), 0),
}
const report = { totals, sessions: rows, pass: rows.length > 0 }
if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
else {
  process.stdout.write('flow-tower multi-session stats\n')
  for (const row of rows) {
    const dict = row.dictionary === null
      ? 'no dictionary'
      : `entries=${row.dictionary.entries} runs=${row.dictionary.compileRuns} rel=${row.dictionary.relations} inject=${row.dictionary.injections}`
    process.stdout.write(`  ${row.session.slice(0, 22)} messages=${row.messages} compactions=${row.compactions} ${dict} project=${row.project}\n`)
  }
  process.stdout.write(`  totals: ${JSON.stringify(totals)}\n`)
  process.stdout.write(`  pass=${report.pass}\n`)
}
process.exitCode = report.pass ? 0 : 1

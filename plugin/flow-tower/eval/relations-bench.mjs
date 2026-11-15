#!/usr/bin/env node
/**
 * Relation graph benchmark: builds a synthetic volume with N entries and E edges,
 * then measures write throughput, adjacency queries, validation, export and
 * import. No timers beyond Date.now(); no external deps.
 *
 * Run: node eval/relations-bench.mjs [--entries=2000] [--edges=10000] [--queries=100]
 */

import { rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FlowStore } from '../lib/store.js'
import {
  addRelation, exportGraph, importGraph, incoming, nodeIdForVolume, outgoing, syncRelations, toMermaid, validateRelations,
} from '../lib/relations.js'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`))
  return found === undefined ? fallback : Number(found.split('=')[1]) || fallback
}
const ENTRIES = Math.max(10, option('entries', 2000))
const EDGES = Math.max(10, option('edges', 10000))
const QUERIES = Math.max(1, option('queries', 100))

const dbPath = join(tmpdir(), `flow-tower-rel-bench-${process.pid}.db`)
const dbPath2 = join(tmpdir(), `flow-tower-rel-bench-import-${process.pid}.db`)
const store = FlowStore.open({ dbPath })
const store2 = FlowStore.open({ dbPath: dbPath2 })
const now = Date.now()
let seed = 42
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

try {
  store.ensureVolume({ volumeId: 'bench', project: 'e:/bench', now })
  store2.ensureVolume({ volumeId: 'bench', project: 'e:/bench', now })

  const entriesStart = Date.now()
  const kinds = ['file', 'decision', 'task', 'feature', 'error']
  for (let index = 0; index < ENTRIES; index += 1) {
    const kind = kinds[index % kinds.length]
    store.insertEntry({
      entryId: `e_bench${index}`,
      volumeId: 'bench',
      kind,
      headword: `bench-entry-${index}`,
      headwordNorm: `bench-entry-${index}`,
      gloss: `benchmark entry ${index}`,
      module: 'bench',
      status: kind === 'task' ? 'open' : '',
      statusSeq: -1,
      firstSeenAt: now,
      lastSeenAt: now,
      tier: 'hot',
      revisionOf: null,
      createdAt: now,
      updatedAt: now,
    })
  }
  store.addEntryCount('bench', ENTRIES, now)
  const entriesMs = Date.now() - entriesStart

  const edgesStart = Date.now()
  store.transaction(() => {
    for (let index = 0; index < EDGES; index += 1) {
      addRelation(store, {
        fromId: `e_bench${index % ENTRIES}`,
        fromKind: 'entry',
        fromVolume: 'bench',
        toId: `h:bench:${index}`,
        toKind: 'host',
        type: 'derivedFrom',
        source: 'bench',
        confidence: 1,
        batchId: 'bench',
        now,
      })
    }
  })
  const edgesMs = Date.now() - edgesStart

  const queryStart = Date.now()
  let queried = 0
  for (let index = 0; index < QUERIES; index += 1) {
    const id = `e_bench${Math.floor(random() * ENTRIES)}`
    queried += outgoing(store, id).length
    queried += incoming(store, id).length
  }
  const queryMs = Date.now() - queryStart

  const validateStart = Date.now()
  const validation = validateRelations(store)
  const validateMs = Date.now() - validateStart

  const exportStart = Date.now()
  const graph = exportGraph(store)
  const exportBytes = JSON.stringify(graph).length
  const mermaidStart = Date.now()
  const mermaid = toMermaid(graph)
  const mermaidMs = Date.now() - mermaidStart
  const exportMs = Date.now() - exportStart

  const importStart = Date.now()
  const imported = importGraph(store2, graph)
  const importMs = Date.now() - importStart

  const dbBytes = statSync(dbPath).size
  const report = {
    entries: ENTRIES,
    edges: EDGES,
    entriesMs,
    edgesMs,
    edgesPerSecond: Math.round((EDGES / Math.max(1, edgesMs)) * 1000),
    queryMs,
    queries: QUERIES,
    queriedNeighbors: queried,
    validateMs,
    dangling: validation.dangling,
    unknownTypes: validation.unknownTypes,
    exportMs,
    exportBytes,
    mermaidMs,
    mermaidChars: mermaid.length,
    importMs,
    imported: imported.imported,
    dbBytes,
    limits: {
      validateMs: Math.round(2000 + EDGES * 0.05),
      exportMs: Math.round(1000 + EDGES * 0.01),
      importMs: Math.round(2000 + EDGES * 0.02),
      queryMs: 1000,
    },
    pass: validation.dangling === 0
      && validateMs < 2000 + EDGES * 0.05
      && exportMs < 1000 + EDGES * 0.01
      && importMs < 2000 + EDGES * 0.02
      && queryMs < 1000,
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.pass ? 0 : 1
} finally {
  store.close()
  store2.close()
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
  rmSync(dbPath2, { force: true })
  rmSync(`${dbPath2}-wal`, { force: true })
  rmSync(`${dbPath2}-shm`, { force: true })
}

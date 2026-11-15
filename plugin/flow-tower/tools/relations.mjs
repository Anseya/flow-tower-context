#!/usr/bin/env node
/**
 * Relation graph maintenance CLI.
 *
 *   node tools/relations.mjs --project=<root> --sync
 *   node tools/relations.mjs --project=<root> --validate
 *   node tools/relations.mjs --project=<root> --export=graph.json [--format=json|dot|mermaid]
 *   node tools/relations.mjs --project=<root> --import=graph.json
 *   node tools/relations.mjs --project=<root> --rollback=<batchId>
 *
 * Read-only by default; --sync/--import write edges (safe: idempotent + batched).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { FlowStore } from '../lib/store.js'
import { dbPathForProject } from '../lib/manager.js'
import { normalizeProjectPath } from '../lib/util.js'
import {
  exportGraph, importGraph, rollbackBatch, syncRelations, toDot, toMermaid, validateRelations,
} from '../lib/relations.js'

const args = process.argv.slice(2)
const project = args.find((arg) => arg.startsWith('--project='))?.slice('--project='.length) ?? process.cwd()
const volume = args.find((arg) => arg.startsWith('--volume='))?.slice('--volume='.length)
const exportFile = args.find((arg) => arg.startsWith('--export='))?.slice('--export='.length)
const importFile = args.find((arg) => arg.startsWith('--import='))?.slice('--import='.length)
const rollback = args.find((arg) => arg.startsWith('--rollback='))?.slice('--rollback='.length)
const format = args.find((arg) => arg.startsWith('--format='))?.slice('--format='.length) ?? 'json'
const doSync = args.includes('--sync')
const fullSync = args.includes('--full')
const doValidate = args.includes('--validate')

const store = FlowStore.open({ dbPath: dbPathForProject(normalizeProjectPath(project)) })
try {
  const volumes = volume !== undefined
    ? [{ volumeId: volume }]
    : store.listVolumes({ limit: 1000 })
  if (doSync) {
    for (const item of volumes) {
      const stats = syncRelations(store, item.volumeId, { full: fullSync })
      process.stdout.write(`sync ${item.volumeId}: ${JSON.stringify(stats)}\n`)
    }
  }
  if (doValidate) {
    const result = validateRelations(store, volume !== undefined ? { volumeId: volume } : {})
    process.stdout.write(`validate: edges=${result.edges} dangling=${result.dangling} unknownTypes=${result.unknownTypes} issues=${result.issues.length}\n`)
    for (const issue of result.issues.slice(0, 20)) {
      process.stdout.write(`  - ${issue.code}${issue.side === undefined ? '' : ` (${issue.side})`} ${issue.edge.fromId} -> ${issue.edge.toId} [${issue.edge.type}]\n`)
    }
    if (result.issues.length > 0) process.exitCode = 1
  }
  if (exportFile !== undefined) {
    const graph = exportGraph(store, volume !== undefined ? { volumeId: volume } : {})
    const text = format === 'dot' ? toDot(graph) : format === 'mermaid' ? toMermaid(graph) : JSON.stringify(graph, null, 2)
    writeFileSync(exportFile, text, 'utf8')
    process.stdout.write(`exported ${graph.edges.length} edge(s) / ${graph.nodes.length} node(s) to ${exportFile} (${format})\n`)
  }
  if (importFile !== undefined) {
    const graph = JSON.parse(readFileSync(importFile, 'utf8'))
    const stats = importGraph(store, graph, volume !== undefined ? { volumeId: volume } : {})
    process.stdout.write(`import: ${JSON.stringify(stats)}\n`)
  }
  if (rollback !== undefined) {
    const stats = rollbackBatch(store, rollback)
    process.stdout.write(`rollback ${rollback}: ${JSON.stringify(stats)}\n`)
  }
} finally {
  store.close()
}

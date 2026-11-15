#!/usr/bin/env node
/**
 * Import a portable flow-tower export (produced by tools/export-data.mjs) into
 * a project dictionary. Idempotent: volumes already present are skipped.
 *
 * Run: node tools/import-data.mjs --project=<abs root> --in=<export.json>
 */

import { readFileSync } from 'node:fs'
import { FlowStore } from '../lib/store.js'
import { dbPathForProject } from '../lib/manager.js'
import { normalizeProjectPath } from '../lib/util.js'
import { importGraph } from '../lib/relations.js'

const args = process.argv.slice(2)
const project = normalizeProjectPath(args.find((arg) => arg.startsWith('--project='))?.slice('--project='.length) ?? process.cwd())
const inputPath = args.find((arg) => arg.startsWith('--in='))?.slice('--in='.length)
if (inputPath === undefined || inputPath.length === 0) {
  process.stderr.write('missing --in=<export.json>\n')
  process.exit(2)
}
const payload = JSON.parse(readFileSync(inputPath, 'utf8'))
if (payload?.format !== 'flow-tower.export.v1' || !Array.isArray(payload.volumes)) {
  process.stderr.write('unsupported export format (expected flow-tower.export.v1)\n')
  process.exit(2)
}
const store = FlowStore.open({ dbPath: dbPathForProject(project) })
try {
  let volumes = 0
  let skipped = 0
  for (const volume of payload.volumes) {
    if (volume?.volume?.volumeId === undefined) { skipped += 1; continue }
    if (store.getVolume(volume.volume.volumeId) !== null) { skipped += 1; continue }
    if (store.importVolume(volume)) volumes += 1
    else skipped += 1
  }
  let relations = 0
  if (payload.relations?.edges?.length > 0) {
    const result = importGraph(store, payload.relations)
    relations = Number(result.imported ?? 0)
  }
  process.stdout.write(`imported volumes=${volumes} skipped=${skipped} relations=${relations} into ${project}\n`)
} finally {
  store.close()
}

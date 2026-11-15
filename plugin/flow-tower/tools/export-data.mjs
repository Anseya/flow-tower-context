#!/usr/bin/env node
/**
 * Export one project's dictionary for backup/migration (JSON, portable).
 * Run: node tools/export-data.mjs --project=<abs project root> [--out=export.json]
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FlowStore } from '../lib/store.js'
import { dbPathForProject } from '../lib/manager.js'
import { normalizeProjectPath } from '../lib/util.js'
import { exportGraph } from '../lib/relations.js'

const args = process.argv.slice(2)
const project = normalizeProjectPath(args.find((arg) => arg.startsWith('--project='))?.slice('--project='.length) ?? process.cwd())
const out = args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length)
  ?? join(project, '.flow-tower', `export-${Date.now()}.json`)
const store = FlowStore.open({ dbPath: dbPathForProject(project) })
try {
  const volumes = store.listVolumes({ limit: 1000 })
  const payload = {
    format: 'flow-tower.export.v1',
    exportedAt: Date.now(),
    project,
    volumes: volumes.map((volume) => store.exportVolume(volume.volumeId)).filter(Boolean),
    relations: exportGraph(store),
  }
  writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8')
  const entries = payload.volumes.reduce((sum, volume) => sum + volume.entries.length, 0)
  process.stdout.write(`exported ${volumes.length} volume(s) / ${entries} entries / ${payload.relations.edges.length} relations to ${out}\n`)
} finally {
  store.close()
}

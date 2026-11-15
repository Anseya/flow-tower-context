#!/usr/bin/env node
/**
 * Remove dictionary entries whose headword is really a tool payload, JSON or
 * markup fragment (they were mined before the extractor learned to reject
 * them). Rebuilds volume counts and hierarchy afterwards.
 *
 * Run: node tools/clean-noise.mjs [--project=<abs project root>] [--dry-run]
 */

import { FlowStore } from '../lib/store.js'
import { dbPathForProject } from '../lib/manager.js'
import { normalizeProjectPath } from '../lib/util.js'

const NOISE_PATTERNS = [
  '%{%',
  '%"content":%',
  '%tool-call%',
  '%</%',
  '%\\n%',
  '%|%',
  '%```%',
]

/**
 * @param {string} project
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{ scanned: number, removed: number, volumes: number }}
 */
export function cleanNoise(project, options = {}) {
  const store = FlowStore.open({ dbPath: dbPathForProject(normalizeProjectPath(project)) })
  const stats = { scanned: 0, removed: 0, volumes: 0 }
  try {
    const where = NOISE_PATTERNS.map(() => 'headword_norm LIKE ?').join(' OR ')
    const rows = store.db.prepare(`SELECT entry_id FROM entries WHERE ${where}`).all(...NOISE_PATTERNS)
    stats.scanned = rows.length
    if (!options.dryRun) {
      const delCitations = store.db.prepare('DELETE FROM citations WHERE entry_id = ?')
      const delEntry = store.db.prepare('DELETE FROM entries WHERE entry_id = ?')
      for (const row of rows) {
        delCitations.run(row.entry_id)
        delEntry.run(row.entry_id)
        stats.removed += 1
      }
      store.db.prepare(
        'UPDATE volumes SET entry_count = (SELECT COUNT(*) FROM entries WHERE volume_id = volumes.volume_id)',
      ).run()
      for (const volume of store.listVolumes({ limit: 1000 })) {
        store.rebuildGroups(volume.volumeId)
        stats.volumes += 1
      }
    }
  } finally {
    store.close()
  }
  return stats
}

const isDirect = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())
if (isDirect) {
  const args = process.argv.slice(2)
  const project = args.find((arg) => arg.startsWith('--project='))?.slice('--project='.length) ?? process.cwd()
  const dryRun = args.includes('--dry-run')
  const stats = cleanNoise(project, { dryRun })
  process.stdout.write(`${dryRun ? 'dry-run ' : ''}noise cleanup: ${JSON.stringify(stats)}\n`)
}

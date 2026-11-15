#!/usr/bin/env node
/**
 * Cross-project merge tool: import every volume of one project dictionary into
 * another (the "跨塔迁移" gap). Same-headword entries are merged by keeping the
 * target entry and appending the source citations; projects are otherwise
 * independent databases.
 *
 * Run: node tools/merge-projects.mjs --from=<abs project root> --to=<abs project root> [--dry-run]
 * Also exported as `mergeProjects()` for tests.
 */

import { FlowStore } from '../lib/store.js'
import { dbPathForProject } from '../lib/manager.js'
import { normalizeProjectPath } from '../lib/util.js'
import { entryIdFor } from '../lib/vocabulary.js'
import { addRelation, nodeIdForVolume } from '../lib/relations.js'
import { withLock } from '../lib/lock.js'
import { pathToFileURL } from 'node:url'

/**
 * @param {string} sourceProject
 * @param {string} targetProject
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{ volumes: number, entries: number, citations: number, skipped: number }}
 */
export function mergeProjects(sourceProject, targetProject, options = {}) {
  const targetPath = dbPathForProject(normalizeProjectPath(targetProject))
  return withLock(`${targetPath}.merge.lock`, () => mergeProjectsInner(sourceProject, targetProject, options), {
    timeoutMs: options.lockTimeoutMs ?? 10000,
  })
}

/**
 * @param {string} sourceProject
 * @param {string} targetProject
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{ volumes: number, entries: number, citations: number, skipped: number }}
 */
function mergeProjectsInner(sourceProject, targetProject, options = {}) {
  const source = FlowStore.open({ dbPath: dbPathForProject(normalizeProjectPath(sourceProject)) })
  const target = FlowStore.open({ dbPath: dbPathForProject(normalizeProjectPath(targetProject)) })
  const stats = { volumes: 0, entries: 0, citations: 0, skipped: 0 }
  try {
    for (const volume of source.listVolumes({ limit: 1000 })) {
      const data = source.exportVolume(volume.volumeId)
      if (data === null) continue
      const existing = target.getVolume(volume.volumeId)
      if (existing === null) {
        if (!options.dryRun) target.importVolume(data)
        stats.volumes += 1
        stats.entries += data.entries.length
        stats.citations += data.citations.length
        continue
      }
      // Volume already present: merge entries by normalized headword.
      for (const entry of data.entries) {
        const hit = target.findEntryByWord(entry.volumeId, entry.headwordNorm)
        if (hit !== null) {
          const existingCitations = new Set(target.citationsFor(hit.entryId).map((item) => item.citeId))
          for (const citation of data.citations.filter((item) => item.entryId === entry.entryId)) {
            if (existingCitations.has(citation.citeId)) {
              stats.skipped += 1
              continue
            }
            if (!options.dryRun) target.insertCitation(citation)
            stats.citations += 1
          }
          stats.entries += 1
        } else {
          if (!options.dryRun) {
            target.insertEntry({ ...entry, volumeId: entry.volumeId, entryId: entryIdFor(entry.volumeId, entry.headwordNorm) })
            for (const citation of data.citations.filter((item) => item.entryId === entry.entryId)) {
              if (!options.dryRun) target.insertCitation(citation)
              stats.citations += 1
            }
            if (!options.dryRun) target.addEntryCount(entry.volumeId, 1)
          }
          stats.entries += 1
        }
      }
    }
    if (!options.dryRun) {
      for (const volume of target.listVolumes({ limit: 1000 })) target.rebuildGroups(volume.volumeId)
      // Record mergedFrom edges (target volume <- source volume/project). Include
      // empty volumes too (listVolumes only returns volumes with entries).
      const targetVolumeIds = target.db.prepare('SELECT volume_id FROM volumes ORDER BY volume_id').all().map((row) => row.volume_id)
      const sourceVolumeIds = source.db.prepare('SELECT volume_id FROM volumes ORDER BY volume_id').all().map((row) => row.volume_id)
      for (const targetVolumeId of targetVolumeIds) {
        for (const sourceVolumeId of sourceVolumeIds) {
          if (target.getVolume(sourceVolumeId) === null) continue
          addRelation(target, {
            fromId: nodeIdForVolume(targetVolumeId),
            fromKind: 'volume',
            fromVolume: targetVolumeId,
            toId: nodeIdForVolume(sourceVolumeId),
            toKind: 'volume',
            toVolume: normalizeProjectPath(sourceProject),
            type: 'mergedFrom',
            source: 'merge',
            confidence: 1,
            note: `merged from ${normalizeProjectPath(sourceProject)}`,
            now: Date.now(),
          })
        }
      }
    }
  } finally {
    source.close()
    target.close()
  }
  return stats
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = process.argv.slice(2)
  const from = args.find((arg) => arg.startsWith('--from='))?.slice('--from='.length)
  const to = args.find((arg) => arg.startsWith('--to='))?.slice('--to='.length)
  const dryRun = args.includes('--dry-run')
  if (from === undefined || to === undefined) {
    process.stderr.write('usage: node tools/merge-projects.mjs --from=<project root> --to=<project root> [--dry-run]\n')
    process.exitCode = 2
  } else {
    const stats = mergeProjects(from, to, { dryRun })
    process.stdout.write(`${dryRun ? 'dry-run ' : ''}merged: ${JSON.stringify(stats)}\n`)
  }
}

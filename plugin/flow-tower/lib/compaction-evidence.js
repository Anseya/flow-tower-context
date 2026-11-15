/**
 * --- module contract ---
 * purpose: Write engine-independent compaction evidence beside the dictionary when a compaction summary event is observed.
 * dependsOn: [generated] lib/storage.js
 * externalDeps: [generated] node:fs, node:path
 * usedBy: [generated] index.js
 * publicApi: [generated] recordCompactionRun
 * risk: Low: append-only evidence next to the database; failures are swallowed so compaction is never blocked.
 * --- end module contract ---
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { readStorageConfig, resolveRunLogPath } from './storage.js'

const MAX_RUN_LOG_BYTES = 512 * 1024

/**
 * Append one evidence line for an observed compaction. This does not depend on
 * the compaction backend's subclass hook, so `/api/status` can prove that a
 * checkpoint was produced even when the backend's own run record is missing.
 *
 * @param {{ project: string, entry: Record<string, any>, config?: Record<string, any>, file?: string }} options
 * @returns {string | null} the file written, or null when evidence was skipped
 */
export function recordCompactionRun(options) {
  try {
    const project = String(options?.project ?? '')
    const entry = options?.entry
    if (entry === null || typeof entry !== 'object') return null
    const file = typeof options?.file === 'string'
      ? options.file
      : resolveRunLogPath(options?.config ?? readStorageConfig(), project)
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (existsSync(file) && statSync(file).size > MAX_RUN_LOG_BYTES) renameSync(file, `${file}.1`)
    } catch {
      // Rotation is best-effort.
    }
    appendFileSync(
      file,
      `${JSON.stringify({ time: Date.now(), backend: 'FlowTowerCompactionEngine', ...entry })}\n`,
      'utf8',
    )
    return file
  } catch {
    // Evidence never blocks the conversation.
    return null
  }
}

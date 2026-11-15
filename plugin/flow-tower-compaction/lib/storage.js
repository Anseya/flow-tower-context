/**
 * --- module contract ---
 * purpose: Resolve project/global/custom dictionary storage paths from settings.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] node:fs, node:os, node:path
 * usedBy: [generated] index.js, lib/memory.js
 * publicApi: [generated] DB_FILE, PROJECT_DIR, RUN_LOG, dshHome, expandUserPath, globalDbPath, globalStorageDir, projectRootDir, readStorageConfig, resolveDbPath, resolveRunLogPath, resolveStorageDir, resolveSummaryMemoryChars, settingsFile
 * risk: Medium: wrong path resolution can split or hide user data; keep path helpers pure and mirrored in the compaction backend.
 * --- end module contract ---
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

/** Directory created inside a project root in `project` mode. */
export const PROJECT_DIR = '.flow-tower'
/** Name of the database file. */
export const DB_FILE = 'flow_tower.db'
/** Append-only compaction run evidence, next to the database. */
export const RUN_LOG = 'compaction-runs.jsonl'
/** `$DSH_HOME` used by the Host process. */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Path of the editable settings document. */
export function settingsFile() {
  return join(dshHome(), 'flow-tower', 'settings.json')
}

/** Default global storage directory. */
export function globalStorageDir() {
  return join(dshHome(), 'flow-tower')
}

/** Default global database path. */
export function globalDbPath() {
  return join(globalStorageDir(), DB_FILE)
}

/**
 * Expand `~` and strip surrounding quotes from a user-entered path.
 * @param {unknown} input
 * @returns {string}
 */
export function expandUserPath(input) {
  const raw = String(input ?? '').trim().replace(/^["']|["']$/g, '')
  if (raw === '~') return homedir()
  if (/^~[\\/]/.test(raw)) return join(homedir(), raw.slice(2))
  return raw
}

/**
 * Convert a normalized project path (`/` separators) back to the platform form.
 * @param {string} project
 * @returns {string}
 */
export function projectRootDir(project) {
  const value = String(project ?? '')
  if (value.length === 0) return ''
  return value.replaceAll('/', sep)
}

/**
 * Resolve the directory that contains `flow_tower.db`.
 * @param {Record<string, any>} config
 * @param {string} [project] normalized project path ('' when global)
 * @returns {string}
 */
export function resolveStorageDir(config, project = '') {
  const dbPath = typeof config?.dbPath === 'string' ? config.dbPath.trim() : ''
  if (dbPath.length > 0) return dirname(dbPath)
  const mode = config?.storageMode
  if (mode === 'global') return globalStorageDir()
  if (mode === 'custom') {
    const raw = expandUserPath(config?.storagePath)
    if (raw.length > 0) {
      const base = isAbsolute(raw)
        ? normalize(raw)
        : resolve(projectRootDir(project) || process.cwd(), raw)
      return base
    }
    // A custom mode without a path is an incomplete setting: fall back to the
    // default project layout instead of writing somewhere surprising.
  }
  const root = projectRootDir(project)
  return root.length > 0 ? join(root, PROJECT_DIR) : globalStorageDir()
}

/**
 * Resolve the SQLite database file according to configuration.
 * @param {Record<string, any>} config
 * @param {string} [project]
 * @returns {string}
 */
export function resolveDbPath(config, project = '') {
  const dbPath = typeof config?.dbPath === 'string' ? config.dbPath.trim() : ''
  if (dbPath.length > 0) return dbPath
  return join(resolveStorageDir(config, project), DB_FILE)
}

/**
 * Path of the compaction run evidence file for one project.
 * @param {Record<string, any>} config
 * @param {string} [project]
 * @returns {string}
 */
export function resolveRunLogPath(config, project = '') {
  return join(resolveStorageDir(config, project), RUN_LOG)
}

/**
 * Read only the storage-related keys from the global settings document.
 * @returns {{ storageMode?: string, storagePath?: string | null, dbPath?: string | null, summaryMemoryChars?: number }}
 */
export function readStorageConfig() {
  try {
    const file = settingsFile()
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    /** @type {Record<string, any>} */
    const out = {}
    for (const key of ['storageMode', 'storagePath', 'dbPath', 'summaryMemoryChars']) {
      if (parsed[key] !== undefined) out[key] = parsed[key]
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Summary-memory character budget from settings (bounded), with the optional
 * `FLOW_TOWER_SUMMARY_MEMORY_CHARS` environment override used by dev/eval.
 * @param {Record<string, any>} [config]
 * @returns {number}
 */
export function resolveSummaryMemoryChars(config = readStorageConfig()) {
  const env = Number.parseInt(process.env.FLOW_TOWER_SUMMARY_MEMORY_CHARS ?? '', 10)
  const source = Number.isFinite(env) && env > 0 ? env : Number(config?.summaryMemoryChars)
  if (!Number.isFinite(source) || source <= 0) return 1800
  return Math.max(600, Math.min(8000, Math.trunc(source)))
}

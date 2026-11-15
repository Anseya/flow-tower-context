/**
 * --- module contract ---
 * purpose: Store lifecycle: per-location SQLite handles, LRU, legacy/project storage migration.
 * dependsOn: [generated] lib/resources.js, lib/storage.js, lib/store.js, lib/util.js
 * externalDeps: [generated] node:fs, node:path
 * usedBy: [generated] eval/multi-session-stats.mjs, eval/runtime-smoke.mjs, index.js, lib/web-common.js, lib/web-read.js, lib/web-write.js, lib/web.js, test/compaction-storage.test.js, test/flow-tower.test.js, test/manager.test.js, tools/clean-noise.mjs, tools/embed.mjs, tools/export-data.mjs, tools/import-data.mjs, tools/mcp-server.mjs, tools/merge-projects.mjs, tools/relations.mjs
 * publicApi: [generated] DB_FILE, PROJECT_DIR, StoreManager, dbPathForProject, globalDbPath
 * risk: Medium-high: owns connections and migration; never delete the old database, and keep migration failure non-destructive.
 * --- end module contract ---
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FlowStore } from './store.js'
import { normalizeProjectPath } from './util.js'
import { hardwareProfile } from './resources.js'
import {
  DB_FILE,
  PROJECT_DIR,
  RUN_LOG,
  globalDbPath,
  resolveDbPath,
  resolveStorageDir,
} from './storage.js'

export { DB_FILE, PROJECT_DIR, globalDbPath }

/** Marker file proving the legacy global-db migration ran. */
const MIGRATION_MARKER = '.project-migration-v1'

/**
 * Compute the default project-local database path (mode `project`).
 * Kept for callers/tests that target the default layout explicitly.
 * @param {string} project normalized absolute project path ('' = global)
 * @returns {string}
 */
export function dbPathForProject(project) {
  if (project.length === 0) return globalDbPath()
  return join(project.replaceAll('/', process.platform === 'win32' ? '\\' : '/'), PROJECT_DIR, DB_FILE)
}

/**
 * Storage-relevant configuration identity; a change closes open handles.
 * @param {Record<string, any>} config
 * @returns {string}
 */
function storageKeyOf(config) {
  return [config?.dbPath ?? '', config?.storageMode ?? 'project', config?.storagePath ?? ''].join('|')
}

export class StoreManager {
  /**
   * @param {{
   *   config: Readonly<Record<string, any>>,
   *   log: { info: (message: string) => void, warn: (message: string) => void },
   * }} options
   */
  constructor(options) {
    this.config = options.config
    this.log = options.log
    /** @type {Map<string, any>} */
    this.stores = new Map()
    /** SQLite path -> project that most recently opened it. */
    this.projectFor = new Map()
    /** LRU access order: path -> timestamp */
    this.access = new Map()
    const hardware = hardwareProfile()
    this.maxOpenStores = hardware.profile === 'low' ? 2 : hardware.profile === 'medium' ? 3 : 4
    this.globalPath = this.config.dbPath ?? globalDbPath()
    this.storageKey = storageKeyOf(this.config)
    this.migrated = false
  }

  /**
   * Replace the active configuration. Storage-affecting changes close the
   * cached SQLite handles so the next access uses the new location.
   * @param {Readonly<Record<string, any>>} nextConfig
   */
  setConfig(nextConfig) {
    const nextKey = storageKeyOf(nextConfig)
    const changed = nextKey !== this.storageKey
    this.config = nextConfig
    this.globalPath = nextConfig.dbPath ?? globalDbPath()
    this.storageKey = nextKey
    if (changed) this.closeAll()
  }

  /**
   * Resolve a database path under an arbitrary config without mutating state.
   * @param {Record<string, any>} configLike
   * @param {string} [project]
   * @returns {string}
   */
  pathForConfig(configLike, project = '') {
    return resolveDbPath(configLike, normalizeProjectPath(project))
  }

  /**
   * Resolve the database path for one project according to configuration.
   * @param {string} project normalized project path
   * @returns {string}
   */
  pathFor(project) {
    const normalized = normalizeProjectPath(project)
    try {
      if (typeof this.config.dbPath === 'string' && this.config.dbPath.length > 0) {
        mkdirSync(dirname(this.config.dbPath), { recursive: true })
        return this.config.dbPath
      }
      const dir = resolveStorageDir(this.config, normalized)
      mkdirSync(dir, { recursive: true })
      if ((this.config.storageMode ?? 'project') === 'project' && normalized.length > 0) {
        this.#ensureGitignore(dir)
      }
      return join(dir, DB_FILE)
    } catch (error) {
      this.log.warn(`cannot create configured storage for ${normalized || '(global)'}; falling back to global db (${error instanceof Error ? error.message : String(error)})`)
      return this.globalPath
    }
  }

  /**
   * Open (and cache) the store for one project.
   * @param {string} [project]
   * @returns {any | null}
   */
  getStore(project = '') {
    const normalized = normalizeProjectPath(project)
    const path = this.pathFor(normalized)
    const cached = this.stores.get(path)
    if (cached !== undefined) {
      this.access.set(path, Date.now())
      this.projectFor.set(path, normalized)
      return cached
    }
    // LRU: bound the number of open SQLite handles (memory).
    while (this.stores.size >= (this.maxOpenStores ?? 4)) {
      let oldestPath = null
      let oldestAt = Infinity
      for (const [candidate, at] of this.access) {
        if (!this.stores.has(candidate)) continue
        if (at < oldestAt) { oldestAt = at; oldestPath = candidate }
      }
      if (oldestPath === null) break
      const oldest = this.stores.get(oldestPath)
      try { oldest?.close() } catch { /* ignore close failures */ }
      this.stores.delete(oldestPath)
      this.access.delete(oldestPath)
      this.projectFor.delete(oldestPath)
    }
    try {
      const store = FlowStore.open({ dbPath: path })
      this.stores.set(path, store)
      this.access.set(path, Date.now())
      this.projectFor.set(path, normalized)
      return store
    } catch (error) {
      this.log.warn(`cannot open dictionary database at ${path}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /**
   * Resolve the store for one session (from its cwd).
   * @param {{ header?: { cwd?: string }, cwd?: string }} session
   * @returns {{ project: string, store: any | null }}
   */
  projectStore(session) {
    const project = normalizeProjectPath(session?.header?.cwd ?? session?.cwd)
    return { project, store: this.getStore(project) }
  }

  /**
   * All currently open stores.
   * @returns {{ project: string, path: string, store: any }[]}
   */
  openStores() {
    const out = []
    for (const [path, store] of this.stores) {
      out.push({ project: this.projectFor.get(path) ?? this.#projectForPath(path), path, store })
    }
    return out
  }

  /**
   * Describe the effective storage location for the UI/status API.
   * @param {string} [project]
   * @returns {{ mode: string, storagePath: string | null, dbPath: string, exists: boolean }}
   */
  storageSnapshot(project = '') {
    const normalized = normalizeProjectPath(project)
    const dbPath = resolveDbPath(this.config, normalized)
    return {
      mode: this.config.storageMode ?? 'project',
      storagePath: typeof this.config.storagePath === 'string' && this.config.storagePath.length > 0 ? this.config.storagePath : null,
      dbPath,
      exists: existsSync(dbPath),
    }
  }

  /**
   * Switch storage for one project and migrate its volumes into the new
   * database (the old database is kept on disk). The run log travels too.
   * @param {Readonly<Record<string, any>>} nextConfig
   * @param {string} [project]
   * @returns {{ from: string, to: string, migrated: number, error?: string }}
   */
  migrateStorageForProject(nextConfig, project = '') {
    const normalized = normalizeProjectPath(project)
    const from = resolveDbPath(this.config, normalized)
    const to = resolveDbPath(nextConfig, normalized)
    if (from === to) {
      this.setConfig(nextConfig)
      return { from, to, migrated: 0 }
    }
    this.closeAll()
    let migrated = 0
    try {
      mkdirSync(dirname(to), { recursive: true })
      if (existsSync(from)) {
        const source = FlowStore.open({ dbPath: from })
        let target = null
        try {
          target = FlowStore.open({ dbPath: to })
          for (const volume of source.listVolumes({ limit: 1000 })) {
            if (target.getVolume(volume.volumeId) !== null) continue
            const data = source.exportVolume(volume.volumeId)
            if (data !== null && target.importVolume(data)) migrated += 1
          }
        } finally {
          try { target?.close() } catch { /* best effort */ }
          try { source.close() } catch { /* best effort */ }
        }
      }
      this.#migrateRunLog(from, to)
      this.setConfig(nextConfig)
      return { from, to, migrated }
    } catch (error) {
      // Keep the old configuration: the settings write must not land on a
      // half-migrated target.
      this.closeAll()
      return { from, to, migrated, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Copy the compaction run log next to the new database when it is absent.
   * @param {string} fromDbPath
   * @param {string} toDbPath
   */
  #migrateRunLog(fromDbPath, toDbPath) {
    try {
      const from = join(dirname(fromDbPath), RUN_LOG)
      const to = join(dirname(toDbPath), RUN_LOG)
      if (from === to || !existsSync(from) || existsSync(to)) return
      copyFileSync(from, to)
    } catch {
      // Evidence log is best-effort; never block a storage switch.
    }
  }

  /**
   * Find an entry by normalized headword across open project stores.
   * @param {string} term
   * @returns {{ store: any, entry: any } | null}
   */
  findEntryByWord(term) {
    const norm = String(term).toLowerCase()
    for (const item of this.openStores()) {
      for (const volume of item.store.listVolumes({ limit: 200 })) {
        const entry = item.store.findEntryByWord(volume.volumeId, norm)
        if (entry !== null) return { store: item.store, entry }
      }
    }
    return null
  }

  /**
   * Find one citation across open project stores.
   * @param {string} citeId
   * @returns {{ store: any, citation: any } | null}
   */
  findCitation(citeId) {
    for (const item of this.openStores()) {
      const citation = item.store.getCitation(citeId)
      if (citation !== null) return { store: item.store, citation }
    }
    return null
  }

  /**
   * Migrate volumes stored in the legacy global database to their project
   * databases. Runs once (marker file) and is best-effort.
   * @returns {{ migrated: number, failed: number }}
   */
  migrateLegacy() {
    const marker = join(dirname(this.globalPath), MIGRATION_MARKER)
    if (this.migrated || existsSync(marker)) return { migrated: 0, failed: 0 }
    this.migrated = true
    const stats = { migrated: 0, failed: 0 }
    if (!existsSync(this.globalPath)) {
      this.#writeMarker(marker)
      return stats
    }
    let legacy = null
    try {
      legacy = FlowStore.open({ dbPath: this.globalPath })
      const volumes = legacy.listVolumes({ limit: 200 })
      for (const volume of volumes) {
        if (volume.project.length === 0) continue
        try {
          const target = this.getStore(volume.project)
          if (target === null) throw new Error('target store unavailable')
          const data = legacy.exportVolume(volume.volumeId)
          if (data !== null && target.importVolume(data)) {
            legacy.deleteVolume(volume.volumeId)
            stats.migrated += 1
          }
        } catch (error) {
          stats.failed += 1
          this.log.warn(`legacy volume ${volume.volumeId} migration failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (stats.failed === 0) this.#writeMarker(marker)
    } catch (error) {
      this.log.warn(`legacy storage migration skipped: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      try {
        legacy?.close()
      } catch {
        // best effort
      }
    }
    return stats
  }

  /** Close every open store. */
  closeAll() {
    for (const store of this.stores.values()) {
      try {
        store.close()
      } catch {
        // best effort
      }
    }
    this.stores.clear()
    this.access.clear()
    this.projectFor.clear()
  }

  /**
   * Write a per-directory `.gitignore` so a project-local dictionary is not
   * committed to the user's repository while still living in the project.
   * @param {string} directory
   */
  #ensureGitignore(directory) {
    const file = join(directory, '.gitignore')
    if (existsSync(file)) return
    try {
      writeFileSync(file, '# flow-tower dictionary (local memory, do not commit)\n*\n', 'utf8')
    } catch {
      // A read-only or unusual directory just means no helper file.
    }
  }

  /**
   * @param {string} path
   * @returns {string}
   */
  #projectForPath(path) {
    if (path === this.globalPath) return ''
    const normalized = path.replaceAll('\\', '/').replace(/\/\.flow-tower\/flow_tower\.db$/, '')
    return normalizeProjectPath(normalized)
  }

  /** @param {string} marker */
  #writeMarker(marker) {
    try {
      mkdirSync(dirname(marker), { recursive: true })
      writeFileSync(marker, JSON.stringify({ at: Date.now() }), 'utf8')
    } catch {
      // Marker is an optimization; failure means a retry next boot.
    }
  }
}

/**
 * --- module contract ---
 * purpose: Transactional store for volumes, entries, citations, relations, vectors, groups, summaries, metrics and KV state.
 * dependsOn: [generated] lib/store-schema.js, lib/synonyms.js, lib/text-index.js, lib/util.js
 * externalDeps: [generated] node:fs, node:path, node:sqlite
 * usedBy: [generated] eval/context-cost.mjs, eval/long-session-eval.mjs, eval/multi-session-stats.mjs, eval/offline-eval.mjs, eval/real-session-eval.mjs, eval/relations-bench.mjs, eval/runtime-smoke.mjs, eval/search-recall.mjs, eval/stress-long-session.mjs, eval/txt-corpus-eval.mjs, lib/catalog.js, lib/embeddings.js, lib/llm-search.js, lib/manager.js, lib/proposals.js, lib/relations-core.js, lib/relations-view.js, lib/relations.js, lib/semantic.js, lib/summary.js, lib/vocabulary.js, lib/web-common.js, test/compaction-storage.test.js, test/flow-tower.test.js, test/manager.test.js, tools/clean-noise.mjs, tools/embed.mjs, tools/export-data.mjs, tools/import-data.mjs, tools/mcp-server.mjs, tools/merge-projects.mjs, tools/relations.mjs
 * publicApi: [generated] FlowStore, SCHEMA_VERSION, defaultDbPath
 * risk: High: intentionally one class because methods share this.db, prepared statements and index/eviction invariants; only pure schema concerns were extracted.
 * --- end module contract ---
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeJsonParse, stableId, retryBusy } from './util.js'
import { entryTermWeights, tokenize } from './text-index.js'
import { expandQueryTerms } from './synonyms.js'
import {
  SCHEMA_VERSION, citationFromRow, defaultDbPath, entryFromRow,
  escapeLike, migrateStore, volumeFromRow,
} from './store-schema.js'

export { SCHEMA_VERSION, defaultDbPath }

export class FlowStore {
  /** @param {string} dbPath */
  constructor(dbPath) {
    this.path = dbPath
    this.db = new DatabaseSync(dbPath)
    this.closed = false
    migrateStore(this.db)
  }

  /**
   * Open one store, creating the parent directory for a file-backed database.
   * @param {{ dbPath?: string | null }} [options]
   * @returns {FlowStore}
   */
  static open(options = {}) {
    const dbPath = options.dbPath ?? defaultDbPath()
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    return new FlowStore(dbPath)
  }


  /** Close the database; idempotent. */
  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      // A closing database is already unusable; ignore teardown races.
    }
  }

  /**
   * Run one synchronous callback inside `BEGIN IMMEDIATE`.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    return retryBusy(() => {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const value = fn()
        this.db.exec('COMMIT')
        return value
      } catch (error) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          // Preserve the original failure.
        }
        throw error
      }
    })
  }

  // ---------------------------------------------------------------- volumes

  /**
   * Create the volume row when absent; never resets an existing version.
   * @param {{ volumeId: string, scope?: string, project?: string, now?: number }} input
   * @returns {any}
   */
  ensureVolume(input) {
    const now = input.now ?? Date.now()
    const existing = this.getVolume(input.volumeId)
    if (existing !== null) {
      const project = input.project ?? ''
      if (project.length > 0 && existing.project !== project) {
        this.db.prepare('UPDATE volumes SET project = ? WHERE volume_id = ?').run(project, input.volumeId)
        return this.getVolume(input.volumeId)
      }
      return existing
    }
    const scope = input.scope ?? (input.project !== undefined && input.project.length > 0 ? `project:${input.project}` : 'global')
    const project = input.project ?? (scope.startsWith('project:') ? scope.slice('project:'.length) : '')
    this.db.prepare(
      `INSERT INTO volumes (volume_id, scope, project, title, abstract, profile, entry_count, version, created_at, updated_at)
       VALUES (?, ?, ?, '', '', '', 0, 0, ?, ?)`,
    ).run(input.volumeId, scope, project, now, now)
    return this.getVolume(input.volumeId)
  }

  /** @param {string} volumeId @returns {any} */
  getVolume(volumeId) {
    const row = this.db.prepare('SELECT * FROM volumes WHERE volume_id = ?').get(volumeId)
    return volumeFromRow(row)
  }

  /**
   * @param {{ scope?: string, project?: string, limit?: number }} [options]
   * @returns {any[]}
   */
  listVolumes(options = {}) {
    const limit = Math.max(1, Math.min(200, options.limit ?? 50))
    const clauses = ['entry_count > 0']
    const params = []
    if (options.scope !== undefined && options.scope !== null) {
      clauses.push('scope = ?')
      params.push(options.scope)
    }
    if (options.project !== undefined && options.project !== null) {
      clauses.push('project = ?')
      params.push(options.project)
    }
    params.push(limit)
    return this.db.prepare(
      `SELECT * FROM volumes WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, volume_id ASC LIMIT ?`,
    ).all(...params).map(volumeFromRow)
  }

  /**
   * Project-level aggregation for the union catalog.
   * @returns {{ project: string, volumes: number, entries: number, updatedAt: number }[]}
   */
  listProjects() {
    return this.db.prepare(
      `SELECT project, COUNT(1) AS volumes, COALESCE(SUM(entry_count), 0) AS entries, MAX(updated_at) AS updated_at
       FROM volumes WHERE entry_count > 0 GROUP BY project ORDER BY updated_at DESC, project ASC`,
    ).all().map((row) => ({
      project: row.project,
      volumes: Number(row.volumes),
      entries: Number(row.entries),
      updatedAt: Number(row.updated_at),
    }))
  }

  /** @returns {boolean} */
  hasVolumes() {
    const row = this.db.prepare('SELECT 1 AS present FROM volumes LIMIT 1').get()
    return row !== undefined
  }

  /**
   * Update volume metadata fields that exist in the input.
   * Does not bump the structural version; callers do that explicitly.
   * @param {string} volumeId
   * @param {{ title?: string, abstract?: string, profile?: string, scope?: string, project?: string }} fields
   * @param {number} [now]
   */
  updateVolume(volumeId, fields, now = Date.now()) {
    const current = this.getVolume(volumeId)
    if (current === null) return
    this.db.prepare(
      'UPDATE volumes SET title = ?, abstract = ?, profile = ?, scope = ?, project = ?, updated_at = ? WHERE volume_id = ?',
    ).run(
      fields.title ?? current.title,
      fields.abstract ?? current.abstract,
      fields.profile ?? current.profile,
      fields.scope ?? current.scope,
      fields.project ?? current.project,
      now,
      volumeId,
    )
  }

  /**
   * Bump the structural version so the next step re-injects the digest.
   * @param {string} volumeId
   * @param {number} [now]
   * @returns {number} the new version
   */
  bumpVersion(volumeId, now = Date.now()) {
    this.db.prepare('UPDATE volumes SET version = version + 1, updated_at = ? WHERE volume_id = ?').run(now, volumeId)
    return this.getVolume(volumeId)?.version ?? 0
  }

  /**
   * Add a delta to the stored entry count.
   * @param {string} volumeId
   * @param {number} delta
   * @param {number} [now]
   */
  addEntryCount(volumeId, delta, now = Date.now()) {
    this.db.prepare(
      'UPDATE volumes SET entry_count = MAX(0, entry_count + ?), updated_at = ? WHERE volume_id = ?',
    ).run(delta, now, volumeId)
  }

  // ---------------------------------------------------------------- entries

  /** @param {string} volumeId @param {string} norm @returns {any} */
  findEntryByWord(volumeId, norm) {
    const row = this.db.prepare(
      'SELECT * FROM entries WHERE volume_id = ? AND headword_norm = ? LIMIT 1',
    ).get(volumeId, norm)
    return entryFromRow(row)
  }

  /** @param {string} entryId @returns {any} */
  getEntry(entryId) {
    const row = this.db.prepare('SELECT * FROM entries WHERE entry_id = ? LIMIT 1').get(entryId)
    return entryFromRow(row)
  }

  /**
   * @param {{ entryId: string, volumeId: string, kind: string, headword: string,
   *   headwordNorm: string, aliases?: string[], gloss: string, senses?: any[],
   *   related?: string[], module?: string, status?: string, statusSeq?: number,
   *   firstSeenAt?: number, lastSeenAt?: number, tier?: string,
   *   revisionOf?: string | null, createdAt: number, updatedAt: number }} entry
   */
  insertEntry(entry) {
    this.db.prepare(
      `INSERT INTO entries (entry_id, volume_id, kind, headword, headword_norm, aliases, gloss, senses,
         related, module, status, status_seq, first_seen_at, last_seen_at, tier,
         revision_of, superseded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      entry.entryId,
      entry.volumeId,
      entry.kind,
      entry.headword,
      entry.headwordNorm,
      JSON.stringify(entry.aliases ?? []),
      entry.gloss,
      JSON.stringify(entry.senses ?? []),
      JSON.stringify(entry.related ?? []),
      entry.module ?? '',
      entry.status ?? '',
      entry.statusSeq ?? -1,
      entry.firstSeenAt ?? entry.createdAt,
      entry.lastSeenAt ?? entry.updatedAt,
      entry.tier ?? 'hot',
      entry.revisionOf ?? null,
      entry.createdAt,
      entry.updatedAt,
    )
    this.#indexEntryRecord(entry)
  }

  /** @param {string} sql @returns {any} */
  #stmt(sql) {
    this.statements ??= new Map()
    let statement = this.statements.get(sql)
    if (statement === undefined) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  /**
   * Public cached prepared statement (hot-path helper for relation sync/import).
   * @param {string} sql
   * @returns {any}
   */
  prepare(sql) {
    return this.#stmt(sql)
  }

  /**
   * Rebuild one entry's lexical search terms (called on every write).
   * @param {string} entryId
   */
  #indexEntry(entryId) {
    this.#indexEntryRecord(this.getEntry(entryId))
  }

  /**
   * @param {any} entry
   */
  #indexEntryRecord(entry) {
    if (entry === null || entry === undefined) return
    const entryId = entry.entryId
    this.#stmt('DELETE FROM search_terms WHERE entry_id = ?').run(entryId)
    const weights = entryTermWeights(entry)
    const insert = this.#stmt(
      'INSERT OR REPLACE INTO search_terms (volume_id, entry_id, term, weight) VALUES (?, ?, ?, ?)',
    )
    let count = 0
    for (const [term, weight] of weights) {
      if (term.length < 2 || term.length > 40) continue
      insert.run(entry.volumeId, entryId, term, Math.min(5, weight))
      count += 1
      if (count >= 150) break
    }
  }

  /**
   * @param {string} entryId
   * @param {{ gloss?: string, senses?: any[], aliases?: string[], related?: string[],
   *   module?: string, status?: string, statusSeq?: number,
   *   firstSeenAt?: number, lastSeenAt?: number, tier?: string }} fields
   * @param {number} [now]
   */
  updateEntry(entryId, fields, now = Date.now()) {
    const current = this.getEntry(entryId)
    if (current === null) return
    this.db.prepare(
      `UPDATE entries SET gloss = ?, senses = ?, aliases = ?, related = ?, module = ?, status = ?,
         status_seq = ?, first_seen_at = ?, last_seen_at = ?, tier = ?, updated_at = ?
       WHERE entry_id = ?`,
    ).run(
      fields.gloss ?? current.gloss,
      JSON.stringify(fields.senses ?? current.senses),
      JSON.stringify(fields.aliases ?? current.aliases),
      JSON.stringify(fields.related ?? current.related),
      fields.module ?? current.module,
      fields.status ?? current.status,
      fields.statusSeq ?? current.statusSeq,
      fields.firstSeenAt ?? current.firstSeenAt,
      fields.lastSeenAt ?? current.lastSeenAt,
      fields.tier ?? current.tier,
      now,
      entryId,
    )
    this.#indexEntryRecord({ ...current, ...fields })
  }

  /**
   * @param {string} volumeId
   * @param {{ kind?: string, prefix?: string, status?: string, module?: string,
   *   since?: number, until?: number, limit?: number }} [options]
   * @returns {any[]}
   */
  listEntries(volumeId, options = {}) {
    const limit = Math.max(1, Math.min(5000, options.limit ?? 100))
    const clauses = ['volume_id = ?']
    const params = [volumeId]
    if (options.kind !== undefined) {
      clauses.push('kind = ?')
      params.push(options.kind)
    }
    if (options.prefix !== undefined) {
      clauses.push("headword_norm LIKE ? ESCAPE '\\'")
      params.push(`${escapeLike(options.prefix.toLowerCase())}%`)
    }
    if (options.status !== undefined) {
      clauses.push('status = ?')
      params.push(options.status)
    }
    if (options.module !== undefined) {
      clauses.push("module LIKE ? ESCAPE '\\'")
      params.push(`${escapeLike(options.module)}%`)
    }
    if (options.since !== undefined) {
      clauses.push('last_seen_at >= ?')
      params.push(options.since)
    }
    if (options.until !== undefined) {
      clauses.push('last_seen_at <= ?')
      params.push(options.until)
    }
    params.push(limit)
    return this.db.prepare(
      `SELECT * FROM entries WHERE ${clauses.join(' AND ')} ORDER BY kind ASC, headword_norm ASC LIMIT ?`,
    ).all(...params).map(entryFromRow)
  }

  /**
   * Recently touched entries for a session digest (newest first).
   * @param {string} volumeId
   * @param {{ limit?: number, kinds?: string[] }} [options]
   * @returns {any[]}
   */
  recentEntries(volumeId, options = {}) {
    const limit = Math.max(1, Math.min(200, options.limit ?? 24))
    const clauses = ['volume_id = ?', 'superseded_by IS NULL']
    const params = [volumeId]
    if (Array.isArray(options.kinds) && options.kinds.length > 0) {
      clauses.push(`kind IN (${options.kinds.map(() => '?').join(', ')})`)
      params.push(...options.kinds)
    }
    params.push(limit)
    return this.db.prepare(
      `SELECT * FROM entries WHERE ${clauses.join(' AND ')} ORDER BY last_seen_at DESC, headword_norm ASC LIMIT ?`,
    ).all(...params).map(entryFromRow)
  }

  /**
   * Entries touched by the most recent compile (the current delta), ordered by
   * last-seen time. Used for the compact project brief / change log.
   * @param {string} volumeId
   * @param {{ limit?: number }} [options]
   * @returns {any[]}
   */
  recentCompiledEntries(volumeId, options = {}) {
    const volume = this.getVolume(volumeId)
    if (volume === null) return []
    const limit = Math.max(1, Math.min(1000, options.limit ?? 200))
    return this.db.prepare(
      `SELECT * FROM entries
       WHERE volume_id = ? AND updated_at = ? AND superseded_by IS NULL
       ORDER BY last_seen_at DESC, headword_norm ASC LIMIT ?`,
    ).all(volumeId, volume.updatedAt, limit).map(entryFromRow)
  }

  /**
   * Compact per-module "tower" data for the large-project brief: entry counts,
   * latest activity, task completion and the top few entries per module.
   * @param {string} volumeId
   * @param {{ limit?: number }} [options]
   * @returns {{ modules: { module: string, entries: number, lastSeenAt: number,
   *   tasks: { open: number, done: number, total: number }, top: any[] }[],
   *   totalTasks: { open: number, done: number } }}
   */
  moduleTowers(volumeId, options = {}) {
    const limit = Math.max(1, Math.min(30, options.limit ?? 10))
    const nameOf = "(CASE WHEN module = '' THEN '(root)' ELSE module END)"
    const modules = this.db.prepare(
      `SELECT ${nameOf} AS module_name, COUNT(1) AS entries, MAX(last_seen_at) AS last_seen_at
       FROM entries WHERE volume_id = ? AND superseded_by IS NULL
       GROUP BY ${nameOf} ORDER BY entries DESC, last_seen_at DESC LIMIT ?`,
    ).all(volumeId, limit)
    if (modules.length === 0) return { modules: [], totalTasks: { open: 0, done: 0 } }
    const topRows = this.db.prepare(
      `SELECT * FROM (
         SELECT *, ${nameOf} AS module_name,
           ROW_NUMBER() OVER (
             PARTITION BY ${nameOf}
             ORDER BY CASE kind
               WHEN 'feature' THEN 0 WHEN 'decision' THEN 1 WHEN 'task' THEN 2
               WHEN 'file' THEN 3 WHEN 'error' THEN 4 WHEN 'api-symbol' THEN 5 ELSE 6 END,
               last_seen_at DESC, headword_norm ASC
           ) AS rn
         FROM entries WHERE volume_id = ? AND superseded_by IS NULL
       ) WHERE rn <= 6`,
    ).all(volumeId)
    const taskRows = this.db.prepare(
      `SELECT ${nameOf} AS module_name,
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS opened,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
       FROM entries WHERE volume_id = ? AND kind = 'task' AND superseded_by IS NULL
       GROUP BY ${nameOf}`,
    ).all(volumeId)
    const tasksByModule = new Map(taskRows.map((row) => [row.module_name, {
      open: Number(row.opened ?? 0),
      done: Number(row.done ?? 0),
      total: Number(row.opened ?? 0) + Number(row.done ?? 0),
    }]))
    const topByModule = new Map()
    for (const row of topRows) {
      const list = topByModule.get(row.module_name) ?? []
      list.push(entryFromRow(row))
      topByModule.set(row.module_name, list)
    }
    const totalTasks = taskRows.reduce((sum, row) => ({
      open: sum.open + Number(row.opened ?? 0),
      done: sum.done + Number(row.done ?? 0),
    }), { open: 0, done: 0 })
    return {
      modules: modules.map((row) => ({
        module: row.module_name,
        entries: Number(row.entries),
        lastSeenAt: Number(row.last_seen_at),
        tasks: tasksByModule.get(row.module_name) ?? { open: 0, done: 0, total: 0 },
        top: topByModule.get(row.module_name) ?? [],
      })),
      totalTasks,
    }
  }

  /**
   * Cross-volume headword lookup, optionally restricted to one project.
   * @param {string} query
   * @param {{ limit?: number, volumeId?: string, project?: string }} [options]
   * @returns {any[]}
   */
  searchEntries(query, options = {}) {
    const limit = Math.max(1, Math.min(100, options.limit ?? 20))
    const pattern = `%${escapeLike(String(query).toLowerCase())}%`
    if (options.volumeId !== undefined) {
      return this.db.prepare(
        "SELECT * FROM entries WHERE volume_id = ? AND headword_norm LIKE ? ESCAPE '\\' ORDER BY length(headword_norm) ASC LIMIT ?",
      ).all(options.volumeId, pattern, limit).map(entryFromRow)
    }
    if (options.project !== undefined) {
      return this.db.prepare(
        `SELECT e.* FROM entries e JOIN volumes v ON v.volume_id = e.volume_id
         WHERE v.project = ? AND e.headword_norm LIKE ? ESCAPE '\\'
         ORDER BY length(e.headword_norm) ASC LIMIT ?`,
      ).all(options.project, pattern, limit).map(entryFromRow)
    }
    return this.db.prepare(
      "SELECT * FROM entries WHERE headword_norm LIKE ? ESCAPE '\\' ORDER BY length(headword_norm) ASC LIMIT ?",
    ).all(pattern, limit).map(entryFromRow)
  }

  /** @param {string} volumeId @returns {number} */
  countEntries(volumeId) {
    const row = this.db.prepare('SELECT COUNT(1) AS n FROM entries WHERE volume_id = ?').get(volumeId)
    return Number(row?.n ?? 0)
  }

  /**
   * Entry counts grouped by kind for one volume.
   * @param {string} volumeId
   * @returns {Record<string, number>}
   */
  countByKind(volumeId) {
    const rows = this.db.prepare(
      'SELECT kind, COUNT(1) AS n FROM entries WHERE volume_id = ? GROUP BY kind',
    ).all(volumeId)
    const out = {}
    for (const row of rows) out[row.kind] = Number(row.n)
    return out
  }

  /**
   * Open task entries for a session digest.
   * @param {string} volumeId
   * @param {number} [limit]
   * @returns {any[]}
   */
  openTasks(volumeId, limit = 5) {
    return this.db.prepare(
      "SELECT * FROM entries WHERE volume_id = ? AND kind = 'task' AND status = 'open' ORDER BY last_seen_at DESC LIMIT ?",
    ).all(volumeId, limit).map(entryFromRow)
  }

  /**
   * Open tasks across every volume of one project (multi-agent coordination).
   * A subagent or a fresh session has no volume of its own; the shared project
   * digest uses this to show work opened by other agents.
   * @param {string} project normalized project root
   * @param {number} [limit]
   * @returns {any[]}
   */
  openTasksForProject(project, limit = 8) {
    if (typeof project !== 'string' || project.length === 0) return []
    return this.db.prepare(
      `SELECT e.* FROM entries e JOIN volumes v ON e.volume_id = v.volume_id
       WHERE v.project = ? AND e.kind = 'task' AND e.status = 'open'
       ORDER BY e.last_seen_at DESC LIMIT ?`,
    ).all(project, limit).map(entryFromRow)
  }

  /**
   * Recently touched code modules for one volume.
   * @param {string} volumeId
   * @param {number} [limit]
   * @returns {{ module: string, entries: number, lastSeenAt: number }[]}
   */
  recentModules(volumeId, limit = 4) {
    return this.db.prepare(
      `SELECT module, COUNT(1) AS entries, MAX(last_seen_at) AS last_seen_at
       FROM entries WHERE volume_id = ? AND module <> ''
       GROUP BY module ORDER BY last_seen_at DESC, module ASC LIMIT ?`,
    ).all(volumeId, limit).map((row) => ({
      module: row.module,
      entries: Number(row.entries),
      lastSeenAt: Number(row.last_seen_at),
    }))
  }

  /**
   * Chronological view over entries (time dimension).
   * @param {{ volumeId?: string, project?: string, module?: string, kind?: string,
   *   since?: number, until?: number, limit?: number }} [options]
   * @returns {any[]}
   */
  timelineEntries(options = {}) {
    const limit = Math.max(1, Math.min(200, options.limit ?? 30))
    const clauses = ['1 = 1']
    const params = []
    if (options.volumeId !== undefined) {
      clauses.push('e.volume_id = ?')
      params.push(options.volumeId)
    }
    if (options.project !== undefined) {
      clauses.push('v.project = ?')
      params.push(options.project)
    }
    if (options.module !== undefined) {
      clauses.push("e.module LIKE ? ESCAPE '\\'")
      params.push(`${escapeLike(options.module)}%`)
    }
    if (options.kind !== undefined) {
      clauses.push('e.kind = ?')
      params.push(options.kind)
    }
    if (options.since !== undefined) {
      clauses.push('e.last_seen_at >= ?')
      params.push(options.since)
    }
    if (options.until !== undefined) {
      clauses.push('e.last_seen_at <= ?')
      params.push(options.until)
    }
    params.push(limit)
    return this.db.prepare(
      `SELECT e.* FROM entries e JOIN volumes v ON v.volume_id = e.volume_id
       WHERE ${clauses.join(' AND ')} ORDER BY e.last_seen_at DESC, e.entry_id ASC LIMIT ?`,
    ).all(...params).map(entryFromRow)
  }

  // -------------------------------------------------------------- citations

  /**
   * @param {{ citeId: string, entryId: string, sessionId: string, seqStart: number,
   *   seqEnd: number, eventTime?: number, excerpt?: string, createdAt: number }} citation
   * @returns {boolean} whether a new row was inserted
   */
  insertCitation(citation) {
    const existing = this.db.prepare(
      `SELECT 1 AS present FROM citations
       WHERE entry_id = ? AND session_id = ? AND seq_start = ? AND seq_end = ? LIMIT 1`,
    ).get(citation.entryId, citation.sessionId, citation.seqStart, citation.seqEnd)
    if (existing !== undefined) return false
    this.db.prepare(
      `INSERT INTO citations (cite_id, entry_id, session_id, seq_start, seq_end, event_time, excerpt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      citation.citeId,
      citation.entryId,
      citation.sessionId,
      citation.seqStart,
      citation.seqEnd,
      citation.eventTime ?? 0,
      citation.excerpt ?? '',
      citation.createdAt,
    )
    return true
  }

  /** @param {string} entryId @returns {any[]} */
  citationsFor(entryId) {
    return this.db.prepare(
      'SELECT * FROM citations WHERE entry_id = ? ORDER BY created_at ASC, seq_start ASC',
    ).all(entryId).map(citationFromRow)
  }

  /** @param {string} citeId @returns {any} */
  getCitation(citeId) {
    const row = this.db.prepare('SELECT * FROM citations WHERE cite_id = ? LIMIT 1').get(citeId)
    return citationFromRow(row)
  }

  /**
   * All seqs already cited for one session (used to compute the compile delta).
   * @param {string} sessionId
   * @param {number} [cap]
   * @returns {Set<number>}
   */
  /** @param {string} sessionId @param {number} [cap] */
  /**
   * Persist compile seqs that were skipped because the Host was under memory
   * pressure. Bounded per volume; oldest seqs are dropped first.
   * @param {string} volumeId
   * @param {readonly number[]} seqs
   * @param {number} [now]
   * @returns {number} queued count
   */
  addDeferredSeqs(volumeId, seqs, now = Date.now()) {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO deferred_compiles (volume_id, seq, created_at) VALUES (?, ?, ?)',
    )
    for (const seq of seqs) {
      if (Number.isSafeInteger(seq) && seq >= 0) insert.run(volumeId, seq, now)
    }
    this.db.prepare(`
      DELETE FROM deferred_compiles
      WHERE volume_id = ? AND seq NOT IN (
        SELECT seq FROM deferred_compiles WHERE volume_id = ? ORDER BY created_at DESC, seq DESC LIMIT 2000
      )
    `).run(volumeId, volumeId)
    return this.countDeferredSeqs(volumeId)
  }

  /** @param {string} volumeId @returns {number[]} */
  listDeferredSeqs(volumeId) {
    return this.db.prepare(
      'SELECT seq FROM deferred_compiles WHERE volume_id = ? ORDER BY seq ASC',
    ).all(volumeId).map((row) => Number(row.seq))
  }

  /** @param {string} volumeId @returns {number} */
  countDeferredSeqs(volumeId) {
    const row = this.db.prepare(
      'SELECT COUNT(1) AS n FROM deferred_compiles WHERE volume_id = ?',
    ).get(volumeId)
    return Number(row?.n ?? 0)
  }

  /** @returns {number} deferred seqs across every volume in this store */
  countAllDeferredSeqs() {
    const row = this.db.prepare('SELECT COUNT(1) AS n FROM deferred_compiles').get()
    return Number(row?.n ?? 0)
  }

  /** @param {string} volumeId */
  clearDeferredSeqs(volumeId) {
    this.db.prepare('DELETE FROM deferred_compiles WHERE volume_id = ?').run(volumeId)
  }

  coveredSeqs(sessionId, cap = 200000) {
    const rows = this.db.prepare(
      'SELECT seq_start, seq_end FROM citations WHERE session_id = ? ORDER BY seq_start ASC',
    ).all(sessionId)
    const out = new Set()
    for (const row of rows) {
      const start = Number(row.seq_start)
      const end = Number(row.seq_end)
      for (let seq = start; seq <= end && out.size < cap; seq += 1) out.add(seq)
      if (out.size >= cap) break
    }
    return out
  }

  /**
   * Number of distinct citation seqs attached to one entry.
   * @param {string} entryId
   * @returns {number}
   */
  citationCount(entryId) {
    const row = this.db.prepare('SELECT COUNT(1) AS n FROM citations WHERE entry_id = ?').get(entryId)
    return Number(row?.n ?? 0)
  }

  // --------------------------------------------------------------- meta/runs

  /** @param {string} volumeId @returns {number} */
  getInjectedVersion(volumeId) {
    return this.getInjectedState(volumeId).version
  }

  /** @param {string} volumeId @param {number} version */
  setInjectedVersion(volumeId, version) {
    const state = this.getInjectedState(volumeId)
    this.setInjectedState(volumeId, { ...state, version })
  }

  /**
   * Read the digest-injection cursor for one volume.
   * @param {string} volumeId
   * @returns {{ version: number, digestHash: string, injections: number }}
   */
  getInjectedState(volumeId) {
    const row = this.db.prepare(
      'SELECT injected_version, digest_hash, injections FROM index_meta WHERE volume_id = ?',
    ).get(volumeId)
    if (row === undefined) return { version: -1, digestHash: '', injections: 0 }
    return {
      version: Number(row.injected_version),
      digestHash: String(row.digest_hash ?? ''),
      injections: Number(row.injections ?? 0),
    }
  }

  /**
   * Write the digest-injection cursor for one volume.
   * @param {string} volumeId
   * @param {{ version: number, digestHash?: string, injections?: number }} state
   */
  setInjectedState(volumeId, state) {
    this.db.prepare(
      `INSERT INTO index_meta (volume_id, injected_version, digest_hash, injections) VALUES (?, ?, ?, ?)
       ON CONFLICT(volume_id) DO UPDATE SET
         injected_version = excluded.injected_version,
         digest_hash = excluded.digest_hash,
         injections = excluded.injections`,
    ).run(volumeId, state.version, state.digestHash ?? '', state.injections ?? 0)
  }

  /**
   * @param {{ runId: string, volumeId: string, compactionId: string, deltaHash: string, now?: number }} run
   * @returns {boolean} false when this (compactionId, deltaHash) was already compiled
   */
  beginRun(run) {
    const existing = this.db.prepare(
      'SELECT committed FROM compile_runs WHERE compaction_id = ? AND delta_hash = ? LIMIT 1',
    ).get(run.compactionId, run.deltaHash)
    if (existing !== undefined) return false
    this.db.prepare(
      `INSERT INTO compile_runs (run_id, volume_id, compaction_id, delta_hash, committed, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ).run(run.runId, run.volumeId, run.compactionId, run.deltaHash, run.now ?? Date.now())
    return true
  }

  /** @param {string} runId */
  commitRun(runId) {
    this.db.prepare('UPDATE compile_runs SET committed = 1 WHERE run_id = ?').run(runId)
  }

  /** @param {string} runId */
  discardRun(runId) {
    this.db.prepare('DELETE FROM compile_runs WHERE run_id = ?').run(runId)
  }

  // ------------------------------------------------------------ portability

  /**
   * Export one volume with its entries, citations and digest cursor so another
   * project-scoped database can import it (legacy global-db migration).
   * @param {string} volumeId
   * @returns {{ volume: any, entries: any[], citations: any[], injected: any } | null}
   */
  exportVolume(volumeId) {
    const volume = this.getVolume(volumeId)
    if (volume === null) return null
    const entries = this.db.prepare('SELECT * FROM entries WHERE volume_id = ?').all(volumeId)
    const entryIds = entries.map((row) => row.entry_id)
    const citations = entryIds.length === 0
      ? []
      : this.db.prepare(
        `SELECT * FROM citations WHERE entry_id IN (${entryIds.map(() => '?').join(',')})`,
      ).all(...entryIds)
    return {
      volume,
      entries: entries.map(entryFromRow),
      citations: citations.map(citationFromRow),
      injected: this.getInjectedState(volumeId),
    }
  }

  /**
   * Import an exported volume when the target does not already have it.
   * @param {{ volume: any, entries: any[], citations: any[], injected: any }} data
   * @returns {boolean} whether anything was imported
   */
  importVolume(data) {
    if (data === null || data.volume === undefined) return false
    if (this.getVolume(data.volume.volumeId) !== null) return false
    this.transaction(() => {
      this.ensureVolume({
        volumeId: data.volume.volumeId,
        scope: data.volume.scope,
        project: data.volume.project,
        now: data.volume.createdAt,
      })
      this.updateVolume(data.volume.volumeId, {
        title: data.volume.title,
        abstract: data.volume.abstract,
        profile: data.volume.profile,
      }, data.volume.updatedAt)
      this.db.prepare('UPDATE volumes SET version = ?, created_at = ?, updated_at = ? WHERE volume_id = ?')
        .run(data.volume.version, data.volume.createdAt, data.volume.updatedAt, data.volume.volumeId)
      for (const entry of data.entries) this.insertEntry(entry)
      for (const citation of data.citations) this.insertCitation(citation)
      this.setInjectedState(data.volume.volumeId, data.injected ?? { version: -1, digestHash: '', injections: 0 })
      this.db.prepare('UPDATE volumes SET entry_count = ? WHERE volume_id = ?')
        .run(data.entries.length, data.volume.volumeId)
    })
    return true
  }

  /**
   * Delete one volume and its dependent rows (used after a successful migration
   * copy, or by explicit maintenance).
   * @param {string} volumeId
   */
  deleteVolume(volumeId) {
    this.transaction(() => {
      this.db.prepare(
        'DELETE FROM citations WHERE entry_id IN (SELECT entry_id FROM entries WHERE volume_id = ?)',
      ).run(volumeId)
      this.db.prepare('DELETE FROM entries WHERE volume_id = ?').run(volumeId)
      this.db.prepare('DELETE FROM index_meta WHERE volume_id = ?').run(volumeId)
      this.db.prepare('DELETE FROM volumes WHERE volume_id = ?').run(volumeId)
    })
  }

  /**
   * Rolling retention: delete one low-priority entry to make room for a new one.
   * Tasks, decisions and chapter markers are never evicted.
   * @param {string} volumeId
   * @returns {string | null} the evicted entry id, or null when nothing can go
   */
  /**
   * Archive one entry (and its citations) so eviction stays recoverable.
   * @param {string} entryId
   * @param {number} [now]
   * @returns {boolean}
   */
  archiveEntry(entryId, now = Date.now()) {
    const entry = this.getEntry(entryId)
    if (entry === null) return false
    const citations = this.citationsFor(entryId)
    this.db.prepare(
      'INSERT OR REPLACE INTO archived_entries (entry_id, volume_id, data, archived_at) VALUES (?, ?, ?, ?)',
    ).run(entryId, entry.volumeId, JSON.stringify({ entry, citations }), now)
    return true
  }

  /**
   * @param {string} volumeId
   * @returns {{ entry: any, citations: any[], archivedAt: number }[]}
   */
  listArchived(volumeId) {
    return this.db.prepare(
      'SELECT data, archived_at FROM archived_entries WHERE volume_id = ? ORDER BY archived_at DESC',
    ).all(volumeId).map((row) => {
      try {
        const parsed = JSON.parse(row.data)
        return { entry: parsed.entry, citations: parsed.citations ?? [], archivedAt: Number(row.archived_at) }
      } catch {
        return null
      }
    }).filter((item) => item !== null)
  }

  /**
   * Restore one archived entry (citations included).
   * @param {string} entryId
   * @returns {boolean}
   */
  restoreArchived(entryId) {
    const row = this.db.prepare('SELECT data FROM archived_entries WHERE entry_id = ?').get(entryId)
    if (row === undefined) return false
    try {
      const parsed = JSON.parse(row.data)
      if (this.getEntry(entryId) !== null) return false
      this.insertEntry(parsed.entry)
      for (const citation of parsed.citations ?? []) this.insertCitation(citation)
      this.addEntryCount(parsed.entry.volumeId, 1, Date.now())
      this.db.prepare('DELETE FROM archived_entries WHERE entry_id = ?').run(entryId)
      return true
    } catch {
      return false
    }
  }

  /**
   * Upsert one embedding vector for an entry.
   * @param {string} entryId
   * @param {string} volumeId
   * @param {string} model
   * @param {number[]} vector
   * @param {number} [now]
   */
  setEntryVector(entryId, volumeId, model, vector, now = Date.now()) {
    this.db.prepare(
      `INSERT INTO entry_vectors (entry_id, volume_id, model, vector, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(entry_id) DO UPDATE SET volume_id = excluded.volume_id, model = excluded.model,
         vector = excluded.vector, updated_at = excluded.updated_at`,
    ).run(entryId, volumeId, model, JSON.stringify(vector), now)
  }

  /**
   * @param {string} entryId
   * @returns {{ entry: any, vector: number[] } | null}
   */
  getEntryVector(entryId) {
    const row = this.db.prepare('SELECT entry_id, vector FROM entry_vectors WHERE entry_id = ?').get(entryId)
    if (row === undefined) return null
    const entry = this.getEntry(entryId)
    if (entry === null) return null
    try {
      const vector = JSON.parse(row.vector)
      return Array.isArray(vector) ? { entry, vector } : null
    } catch {
      return null
    }
  }

  /**
   * @param {{ volumeId?: string, kind?: string, limit?: number }} [options]
   * @returns {{ entry: any, vector: number[] }[]}
   */
  listEntryVectors(options = {}) {
    const clauses = []
    const params = []
    if (options.volumeId !== undefined) { clauses.push('e.volume_id = ?'); params.push(options.volumeId) }
    if (options.kind !== undefined) { clauses.push('e.kind = ?'); params.push(options.kind) }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(20000, options.limit ?? 5000))
    const rows = this.db.prepare(
      `SELECT v.entry_id, v.vector FROM entry_vectors v JOIN entries e ON e.entry_id = v.entry_id
       ${where} LIMIT ?`,
    ).all(...params, limit)
    const out = []
    for (const row of rows) {
      const entry = this.getEntry(row.entry_id)
      if (entry === null) continue
      try {
        const vector = JSON.parse(row.vector)
        if (Array.isArray(vector) && vector.length > 0) out.push({ entry, vector })
      } catch {
        // Ignore malformed vectors.
      }
    }
    return out
  }

  /**
   * Remove one entry's vector.
   * @param {string} entryId
   */
  deleteEntryVector(entryId) {
    this.db.prepare('DELETE FROM entry_vectors WHERE entry_id = ?').run(entryId)
  }

  /**
   * Evict one low-priority entry while keeping it recoverable in the archive.
   * @param {string} volumeId
   * @returns {string | null}
   */
  evictOne(volumeId) {
    const row = this.db.prepare(
      `SELECT e.entry_id FROM entries e
       WHERE e.volume_id = ? AND e.kind NOT IN ('task','decision','chapter')
       ORDER BY CASE e.kind
           WHEN 'topic' THEN 9 WHEN 'error' THEN 8 WHEN 'command' THEN 8
           WHEN 'api-symbol' THEN 7 WHEN 'person' THEN 6 WHEN 'feature' THEN 5
           WHEN 'file' THEN 4 ELSE 5 END DESC,
         (SELECT COUNT(*) FROM citations c WHERE c.entry_id = e.entry_id) ASC,
         e.last_seen_at ASC, e.entry_id ASC
       LIMIT 1`,
    ).get(volumeId)
    if (row === undefined) return null
    this.archiveEntry(row.entry_id)
    this.db.prepare(
      'DELETE FROM citations WHERE entry_id IN (SELECT entry_id FROM entries WHERE entry_id = ?)',
    ).run(row.entry_id)
    this.db.prepare('DELETE FROM entries WHERE entry_id = ?').run(row.entry_id)
    this.deleteEntryVector(row.entry_id)
    this.db.prepare(
      "UPDATE relations SET status = 'archived' WHERE from_id = ? OR to_id = ?",
    ).run(row.entry_id, row.entry_id)
    this.db.prepare('UPDATE volumes SET entry_count = MAX(0, entry_count - 1) WHERE volume_id = ?').run(volumeId)
    return row.entry_id
  }

  /**
   * Delete one entry and its citations (maintenance / eviction support).
   * @param {string} entryId
   */
  deleteEntry(entryId) {
    const row = this.db.prepare('SELECT volume_id FROM entries WHERE entry_id = ?').get(entryId)
    if (row === undefined) return
    this.db.prepare('DELETE FROM citations WHERE entry_id = ?').run(entryId)
    this.db.prepare('DELETE FROM entries WHERE entry_id = ?').run(entryId)
    this.deleteEntryVector(entryId)
    this.db.prepare(
      "UPDATE relations SET status = 'archived' WHERE from_id = ? OR to_id = ?",
    ).run(entryId, entryId)
    this.db.prepare('UPDATE volumes SET entry_count = MAX(0, entry_count - 1) WHERE volume_id = ?').run(row.volume_id)
  }

  /**
   * Ensure lexical index rows exist for the given volumes (lazy rebuild for
   * databases written before the search index existed).
   * @param {string[]} volumeIds
   */
  ensureSearchIndex(volumeIds) {
    if (volumeIds.length === 0) return
    const placeholders = volumeIds.map(() => '?').join(',')
    const indexed = this.db.prepare(
      `SELECT COUNT(1) AS n FROM search_terms WHERE volume_id IN (${placeholders})`,
    ).get(...volumeIds)
    if (Number(indexed?.n ?? 0) > 0) return
    const entries = this.db.prepare(
      `SELECT * FROM entries WHERE volume_id IN (${placeholders}) LIMIT 20000`,
    ).all(...volumeIds)
    for (const row of entries) this.#indexEntryRecord(entryFromRow(row))
  }

  /**
   * Ranked lexical search (BM25-lite): CJK bigrams + ASCII words, IDF-weighted.
   * @param {string} query
   * @param {{ volumeId?: string, project?: string, kind?: string, limit?: number }} [options]
   * @returns {{ entry: any, score: number, matched: string[] }[]}
   */
  searchRanked(query, options = {}) {
    const limit = Math.max(1, Math.min(100, options.limit ?? 20))
    const terms = [...new Set(expandQueryTerms(query))].slice(0, 16)
    if (terms.length === 0) return []

    // Resolve the volume scope.
    let volumeIds
    if (options.volumeId !== undefined) {
      volumeIds = [options.volumeId]
    } else if (options.project !== undefined) {
      volumeIds = this.listVolumes({ project: options.project, limit: 200 }).map((volume) => volume.volumeId)
    } else {
      volumeIds = this.db.prepare('SELECT volume_id FROM volumes').all().map((row) => row.volume_id)
    }
    if (volumeIds.length === 0) return []
    this.ensureSearchIndex(volumeIds)
    const totalRow = this.db.prepare(
      `SELECT COUNT(1) AS n FROM entries WHERE volume_id IN (${volumeIds.map(() => '?').join(',')})`,
    ).get(...volumeIds)
    const total = Number(totalRow?.n ?? 0)
    if (total === 0) return []

    /** @type {Map<string, { score: number, matched: string[] }>} */
    const scores = new Map()
    for (const term of terms) {
      const dfRow = this.db.prepare(
        `SELECT COUNT(DISTINCT entry_id) AS n FROM search_terms
         WHERE term = ? AND volume_id IN (${volumeIds.map(() => '?').join(',')})`,
      ).get(term, ...volumeIds)
      const df = Number(dfRow?.n ?? 0)
      if (df === 0) continue
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
      const rows = this.db.prepare(
        `SELECT entry_id, weight FROM search_terms
         WHERE term = ? AND volume_id IN (${volumeIds.map(() => '?').join(',')})`,
      ).all(term, ...volumeIds)
      for (const row of rows) {
        const bucket = scores.get(row.entry_id) ?? { score: 0, matched: [] }
        bucket.score += Number(row.weight) * idf
        if (!bucket.matched.includes(term)) bucket.matched.push(term)
        scores.set(row.entry_id, bucket)
      }
    }
    const ranked = [...scores.entries()]
      .sort((left, right) => right[1].score - left[1].score)
      .slice(0, limit * 3)
    // Relation-neighborhood boost: strong typed neighbors of top seeds get a
    // small lift, so "related" entries surface even without exact term overlap.
    const seeds = ranked.slice(0, 5)
    for (const [seedId, seedScore] of seeds) {
      try {
        const rows = this.db.prepare(
          `SELECT from_id, to_id FROM relations
           WHERE status = 'active' AND confidence >= 0.8 AND (from_id = ? OR to_id = ?) LIMIT 20`,
        ).all(seedId, seedId)
        for (const row of rows) {
          const neighbour = row.from_id === seedId ? row.to_id : row.from_id
          const bucket = scores.get(neighbour)
          if (bucket !== undefined) bucket.score += seedScore.score * 0.15
        }
      } catch {
        // Relations table may not exist on very old databases; ignore.
      }
    }
    const out = []
    for (const [entryId, bucket] of ranked) {
      const entry = this.getEntry(entryId)
      if (entry === null) continue
      if (options.kind !== undefined && entry.kind !== options.kind) continue
      out.push({ entry, score: Number(bucket.score.toFixed(3)), matched: bucket.matched })
      if (out.length >= limit) break
    }
    return out
  }

  // --------------------------------------------------------------- hierarchy

  /**
   * Rebuild the deterministic volume -> group (kind/module) -> entries tree.
   * @param {string} volumeId
   * @returns {number} number of groups created
   */
  rebuildGroups(volumeId) {
    this.db.prepare('DELETE FROM groups WHERE volume_id = ?').run(volumeId)
    this.db.prepare("UPDATE entries SET group_id = '' WHERE volume_id = ?").run(volumeId)
    const volume = this.getVolume(volumeId)
    if (volume === null) return 0
    const rootId = `grp_${stableId(`${volumeId}\u0000root`, 12)}`
    this.db.prepare(
      'INSERT INTO groups (group_id, volume_id, parent_id, key, label, kind, size) VALUES (?, ?, NULL, ?, ?, ?, ?)',
    ).run(rootId, volumeId, 'root', `[volume] ${volumeId}`, 'root', volume.entryCount)

    const rows = this.db.prepare(
      'SELECT entry_id, kind, module FROM entries WHERE volume_id = ? ORDER BY kind, module, headword_norm',
    ).all(volumeId)
    /** @type {Map<string, { key: string, label: string, kind: string, ids: string[] }>} */
    const buckets = new Map()
    for (const row of rows) {
      const moduleScoped = row.kind === 'file' || row.kind === 'api-symbol'
      const key = moduleScoped
        ? `module:${row.module.length > 0 ? row.module : '(root)'}`
        : `kind:${row.kind}`
      const label = moduleScoped
        ? `[module] ${row.module.length > 0 ? row.module : '(root)'}`
        : `[kind] ${row.kind}`
      const bucket = buckets.get(key) ?? { key, label, kind: moduleScoped ? 'module' : row.kind, ids: [] }
      bucket.ids.push(row.entry_id)
      buckets.set(key, bucket)
    }
    const insertGroup = this.db.prepare(
      'INSERT INTO groups (group_id, volume_id, parent_id, key, label, kind, summary, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const assign = this.db.prepare('UPDATE entries SET group_id = ? WHERE entry_id = ?')
    let created = 0
    for (const bucket of [...buckets.values()].sort((left, right) => left.key.localeCompare(right.key))) {
      const groupId = `grp_${stableId(`${volumeId}\u0000${bucket.key}`, 12)}`
      // Deterministic parent summary: the group's highest-signal headwords.
      const preview = this.db.prepare(
        `SELECT headword FROM entries WHERE entry_id IN (${bucket.ids.map(() => '?').join(',')})
         ORDER BY kind, headword_norm LIMIT 8`,
      ).all(...bucket.ids).map((row) => row.headword)
      const summary = preview.length > 0 ? preview.join(' · ') : ''
      insertGroup.run(groupId, volumeId, rootId, bucket.key, bucket.label, bucket.kind, summary, bucket.ids.length)
      for (const entryId of bucket.ids) assign.run(groupId, entryId)
      created += 1
    }
    return created
  }

  /**
   * @param {string} volumeId
   * @param {string | null} [parentId]
   * @returns {any[]}
   */
  listGroups(volumeId, parentId = null) {
    const rows = parentId === null
      ? this.db.prepare(
        'SELECT * FROM groups WHERE volume_id = ? AND parent_id IS NULL ORDER BY kind, label',
      ).all(volumeId)
      : this.db.prepare(
        'SELECT * FROM groups WHERE volume_id = ? AND parent_id = ? ORDER BY label',
      ).all(volumeId, parentId)
    return rows.map((row) => ({
      groupId: row.group_id,
      volumeId: row.volume_id,
      parentId: row.parent_id,
      key: row.key,
      label: row.label,
      kind: row.kind,
      summary: row.summary ?? '',
      size: Number(row.size),
    }))
  }

  /**
   * @param {string} groupId
   * @param {number} [limit]
   * @returns {any[]}
   */
  entriesInGroup(groupId, limit = 40) {
    return this.db.prepare(
      'SELECT * FROM entries WHERE group_id = ? ORDER BY kind, headword_norm LIMIT ?',
    ).all(groupId, limit).map(entryFromRow)
  }

  /**
   * @param {string} hash
   * @returns {any | null}
   */
  getProposalRun(hash) {
    const row = this.db.prepare('SELECT * FROM proposal_runs WHERE hash = ? LIMIT 1').get(hash)
    if (row === undefined) return null
    return {
      hash: row.hash,
      fileName: row.file_name,
      mode: row.mode,
      accepted: Number(row.accepted),
      rejected: Number(row.rejected),
      committed: Number(row.committed),
      createdAt: Number(row.created_at),
    }
  }

  /**
   * @param {{ hash: string, fileName: string, mode: string, accepted: number,
   *   rejected: number, committed: number, now?: number }} run
   */
  recordProposalRun(run) {
    this.db.prepare(
      `INSERT INTO proposal_runs (hash, file_name, mode, accepted, rejected, committed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET mode = excluded.mode, accepted = excluded.accepted,
         rejected = excluded.rejected, committed = excluded.committed, created_at = excluded.created_at`,
    ).run(run.hash, run.fileName, run.mode, run.accepted, run.rejected, run.committed, run.now ?? Date.now())
  }

  /**
   * Replace the whole summary tree of one volume.
   * @param {string} volumeId
   * @param {readonly { nodeId: string, parentId: string | null, level: number,
   *   label: string, summary: string, size: number }[]} nodes
   */
  replaceSummaryNodes(volumeId, nodes) {
    this.db.prepare('DELETE FROM summary_nodes WHERE volume_id = ?').run(volumeId)
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO summary_nodes (node_id, volume_id, parent_id, level, label, summary, citations, signature, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const node of nodes) {
      insert.run(node.nodeId, volumeId, node.parentId, node.level, node.label, node.summary,
        JSON.stringify(node.citations ?? []), node.signature ?? '', node.size)
    }
  }

  /**
   * @param {string} volumeId
   * @returns {any[]}
   */
  listSummaryNodes(volumeId) {
    return this.db.prepare(
      'SELECT * FROM summary_nodes WHERE volume_id = ? ORDER BY level, label',
    ).all(volumeId).map((row) => ({
      nodeId: row.node_id,
      volumeId: row.volume_id,
      parentId: row.parent_id,
      level: Number(row.level),
      label: row.label,
      summary: row.summary ?? '',
      citations: (() => {
        try {
          const parsed = JSON.parse(row.citations ?? '[]')
          return Array.isArray(parsed) ? parsed : []
        } catch {
          return []
        }
      })(),
      signature: row.signature ?? '',
      size: Number(row.size),
    }))
  }

  /**
   * Rebuild the summary-level search index for one volume.
   * @param {string} volumeId
   * @param {readonly any[]} nodes
   */
  replaceSummaryTerms(volumeId, nodes) {
    this.db.prepare('DELETE FROM summary_terms WHERE volume_id = ?').run(volumeId)
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO summary_terms (volume_id, node_id, term, weight) VALUES (?, ?, ?, ?)',
    )
    for (const node of nodes) {
      const weights = entryTermWeights({ headword: node.label, gloss: node.summary })
      let count = 0
      for (const [term, weight] of weights) {
        if (term.length < 2 || term.length > 40) continue
        insert.run(volumeId, node.nodeId, term, Math.min(5, weight))
        count += 1
        if (count >= 120) break
      }
    }
  }

  /**
   * Ranked search over summary nodes (labels + summaries).
   * @param {string} query
   * @param {{ volumeId?: string, project?: string, limit?: number }} [options]
   * @returns {{ node: any, score: number, matched: string[] }[]}
   */
  searchSummariesRanked(query, options = {}) {
    const limit = Math.max(1, Math.min(50, options.limit ?? 10))
    const terms = [...new Set(tokenize(query))].slice(0, 10)
    if (terms.length === 0) return []
    const volumeIds = options.volumeId !== undefined
      ? [options.volumeId]
      : options.project !== undefined
        ? this.listVolumes({ project: options.project, limit: 200 }).map((volume) => volume.volumeId)
        : this.db.prepare('SELECT volume_id FROM volumes').all().map((row) => row.volume_id)
    if (volumeIds.length === 0) return []
    const placeholders = volumeIds.map(() => '?').join(',')
    const totalRow = this.db.prepare(
      `SELECT COUNT(1) AS n FROM summary_nodes WHERE volume_id IN (${placeholders})`,
    ).get(...volumeIds)
    const total = Number(totalRow?.n ?? 0)
    if (total === 0) return []
    const scores = new Map()
    for (const term of terms) {
      const dfRow = this.db.prepare(
        `SELECT COUNT(DISTINCT node_id) AS n FROM summary_terms WHERE term = ? AND volume_id IN (${placeholders})`,
      ).get(term, ...volumeIds)
      const df = Number(dfRow?.n ?? 0)
      if (df === 0) continue
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
      const rows = this.db.prepare(
        `SELECT node_id, weight FROM summary_terms WHERE term = ? AND volume_id IN (${placeholders})`,
      ).all(term, ...volumeIds)
      for (const row of rows) {
        const bucket = scores.get(row.node_id) ?? { score: 0, matched: [] }
        bucket.score += Number(row.weight) * idf
        if (!bucket.matched.includes(term)) bucket.matched.push(term)
        scores.set(row.node_id, bucket)
      }
    }
    const out = []
    for (const [nodeId, bucket] of [...scores.entries()].sort((a, b) => b[1].score - a[1].score)) {
      const row = this.db.prepare('SELECT * FROM summary_nodes WHERE node_id = ?').get(nodeId)
      if (row === undefined) continue
      out.push({
        node: {
          nodeId: row.node_id,
          volumeId: row.volume_id,
          parentId: row.parent_id,
          level: Number(row.level),
          label: row.label,
          summary: row.summary ?? '',
          size: Number(row.size),
        },
        score: Number(bucket.score.toFixed(3)),
        matched: bucket.matched,
      })
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * @param {string} key
   * @returns {string | null}
   */
  getKv(key) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
    return row === undefined ? null : String(row.value)
  }

  /**
   * @param {string} key
   * @param {string} value
   */
  setKv(key, value) {
    this.db.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, String(value))
  }

  /**
   * @param {{ batchId: string, kind: string, volumeId?: string, stats?: any, now?: number }} batch
   */
  recordRelationBatch(batch) {
    this.db.prepare(
      `INSERT INTO relation_batches (batch_id, kind, volume_id, stats, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(batch_id) DO UPDATE SET stats = excluded.stats`,
    ).run(batch.batchId, batch.kind, batch.volumeId ?? '', JSON.stringify(batch.stats ?? {}), batch.now ?? Date.now())
  }

  // ---------------------------------------------------------------- metrics
  /**
   * @param {{ volumeId?: string | null, kind: string, data?: unknown, now?: number }} metric
   */
  recordMetric(metric) {
    this.db.prepare(
      'INSERT INTO metrics (volume_id, kind, data, created_at) VALUES (?, ?, ?, ?)',
    ).run(metric.volumeId ?? null, metric.kind, JSON.stringify(metric.data ?? {}), metric.now ?? Date.now())
  }

  /**
   * @param {{ kind?: string, limit?: number }} [options]
   * @returns {any[]}
   */
  recentMetrics(options = {}) {
    const limit = Math.max(1, Math.min(500, options.limit ?? 50))
    const rows = options.kind === undefined
      ? this.db.prepare('SELECT * FROM metrics ORDER BY id DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM metrics WHERE kind = ? ORDER BY id DESC LIMIT ?').all(options.kind, limit)
    return rows.map((row) => ({
      id: row.id,
      volumeId: row.volume_id,
      kind: row.kind,
      data: safeJsonParse(row.data, {}),
      createdAt: row.created_at,
    }))
  }
}

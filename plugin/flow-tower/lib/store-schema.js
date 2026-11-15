/**
 * --- module contract ---
 * purpose: SQLite DDL, pragmas, migrations and row projections for the dictionary store.
 * dependsOn: [generated] lib/resources.js, lib/util.js
 * externalDeps: [generated] node:fs, node:os, node:path
 * usedBy: [generated] lib/store.js
 * publicApi: [generated] DDL, SCHEMA_VERSION, addColumn, citationFromRow, defaultDbPath, entryFromRow, escapeLike, migrateStore, volumeFromRow
 * risk: Medium: durable schema; changes must stay backwards-compatible with existing databases.
 * --- end module contract ---
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hardwareProfile } from './resources.js'
import { safeJsonParse } from './util.js'


/** Bumped whenever the DDL changes; `PRAGMA user_version` carries it. */
export const SCHEMA_VERSION = 9

/**
 * Resolve the default database location from `$DSH_HOME`.
 * @returns {string}
 */
export function defaultDbPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'flow-tower', 'flow_tower.db')
}

export const DDL = `
CREATE TABLE IF NOT EXISTS volumes (
  volume_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'global',
  project TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  abstract TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL DEFAULT '',
  entry_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  entry_id TEXT PRIMARY KEY,
  volume_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  headword TEXT NOT NULL,
  headword_norm TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  gloss TEXT NOT NULL DEFAULT '',
  senses TEXT NOT NULL DEFAULT '[]',
  related TEXT NOT NULL DEFAULT '[]',
  module TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  status_seq INTEGER NOT NULL DEFAULT -1,
  first_seen_at INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'hot',
  revision_of TEXT,
  superseded_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_entries_word ON entries(volume_id, headword_norm);
CREATE INDEX IF NOT EXISTS ix_entries_kind ON entries(volume_id, kind, headword_norm, entry_id);
CREATE INDEX IF NOT EXISTS ix_entries_updated ON entries(volume_id, updated_at);

CREATE TABLE IF NOT EXISTS citations (
  cite_id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq_start INTEGER NOT NULL,
  seq_end INTEGER NOT NULL,
  event_time INTEGER NOT NULL DEFAULT 0,
  excerpt TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_citations_span ON citations(entry_id, session_id, seq_start, seq_end);
CREATE INDEX IF NOT EXISTS ix_citations_entry ON citations(entry_id);
CREATE INDEX IF NOT EXISTS ix_citations_session ON citations(session_id, seq_start);

CREATE TABLE IF NOT EXISTS compile_runs (
  run_id TEXT PRIMARY KEY,
  volume_id TEXT NOT NULL,
  compaction_id TEXT NOT NULL,
  delta_hash TEXT NOT NULL,
  committed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_compaction ON compile_runs(compaction_id, delta_hash);

CREATE TABLE IF NOT EXISTS index_meta (
  volume_id TEXT PRIMARY KEY,
  injected_version INTEGER NOT NULL DEFAULT -1,
  digest_hash TEXT NOT NULL DEFAULT '',
  injections INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  volume_id TEXT,
  kind TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_metrics_kind ON metrics(kind, created_at);

-- Lexical search index (CJK bigrams + ASCII words), maintained on entry writes.
CREATE TABLE IF NOT EXISTS search_terms (
  volume_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  term TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (entry_id, term)
);
CREATE INDEX IF NOT EXISTS ix_search_terms_lookup ON search_terms(volume_id, term);

-- Deterministic hierarchy: volume -> group (kind/module) -> entries.
CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  volume_id TEXT NOT NULL,
  parent_id TEXT,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_groups_volume ON groups(volume_id, parent_id, kind);

-- Agent/human proposal audit: validated folds (shadow vs committed).
CREATE TABLE IF NOT EXISTS proposal_runs (
  hash TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  mode TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  committed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Recursive summary tree: volume (level 0) -> category (1) -> group (2).
CREATE TABLE IF NOT EXISTS summary_nodes (
  node_id TEXT PRIMARY KEY,
  volume_id TEXT NOT NULL,
  parent_id TEXT,
  level INTEGER NOT NULL,
  label TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  citations TEXT NOT NULL DEFAULT '[]',
  signature TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_summary_nodes_volume ON summary_nodes(volume_id, parent_id, level);

-- Summary-level lexical index ("search summaries first, then drill down").
CREATE TABLE IF NOT EXISTS summary_terms (
  volume_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  term TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (node_id, term)
);
CREATE INDEX IF NOT EXISTS ix_summary_terms_lookup ON summary_terms(volume_id, term);

-- Compile deltas deferred while the Host is under memory pressure; replayed
-- after pressure clears, and persisted so a restart does not lose coverage.
CREATE TABLE IF NOT EXISTS deferred_compiles (
  volume_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (volume_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_deferred_volume ON deferred_compiles(volume_id, created_at);

-- Archived (evicted) entries stay recoverable instead of being lost.
CREATE TABLE IF NOT EXISTS archived_entries (
  entry_id TEXT PRIMARY KEY,
  volume_id TEXT NOT NULL,
  data TEXT NOT NULL,
  archived_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_archived_volume ON archived_entries(volume_id, archived_at);

-- Optional embedding vectors (only present when an embedding provider is configured).
CREATE TABLE IF NOT EXISTS entry_vectors (
  entry_id TEXT PRIMARY KEY,
  volume_id TEXT NOT NULL,
  model TEXT NOT NULL,
  vector TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_entry_vectors_volume ON entry_vectors(volume_id);

-- Typed, directional relation edges (single source of truth; incoming/outgoing
-- are queries, not duplicated rows). rel_type stores one canonical direction;
-- inverse types are normalized on write and inverted on read.
CREATE TABLE IF NOT EXISTS relations (
  from_id TEXT NOT NULL,
  from_kind TEXT NOT NULL,
  from_volume TEXT NOT NULL DEFAULT '',
  to_id TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_volume TEXT NOT NULL DEFAULT '',
  rel_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'compiler',
  confidence REAL NOT NULL DEFAULT 1.0,
  evidence TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT NOT NULL DEFAULT '',
  batch_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, rel_type)
);
CREATE INDEX IF NOT EXISTS ix_relations_from ON relations(from_id, rel_type);
CREATE INDEX IF NOT EXISTS ix_relations_to ON relations(to_id, rel_type);
CREATE INDEX IF NOT EXISTS ix_relations_volume ON relations(from_volume, status);

-- Batch audit so a merge/cut/import can be rolled back atomically.
CREATE TABLE IF NOT EXISTS relation_batches (
  batch_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  volume_id TEXT NOT NULL DEFAULT '',
  stats TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

-- Small key/value settings (relation sync watermarks, flags).
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** Add one column only when the table lacks it. */
export function addColumn(db, table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)))
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

/**
 * Escape LIKE metacharacters so headwords containing `_` or `%` match literally.
 * @param {string} text
 * @returns {string}
 */
export function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (match) => `\\${match}`)
}

/** @param {any} row @returns {any} */
export function volumeFromRow(row) {
  if (row === undefined) return null
  return {
    volumeId: row.volume_id,
    scope: row.scope,
    project: row.project,
    title: row.title,
    abstract: row.abstract,
    profile: row.profile,
    entryCount: row.entry_count,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** @param {any} row @returns {any} */
export function entryFromRow(row) {
  if (row === undefined) return null
  return {
    entryId: row.entry_id,
    volumeId: row.volume_id,
    kind: row.kind,
    headword: row.headword,
    headwordNorm: row.headword_norm,
    aliases: safeJsonParse(row.aliases, []),
    gloss: row.gloss,
    senses: safeJsonParse(row.senses, []),
    related: safeJsonParse(row.related, []),
    module: row.module,
    status: row.status,
    statusSeq: row.status_seq,
    groupId: row.group_id ?? '',
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    tier: row.tier,
    revisionOf: row.revision_of,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** @param {any} row @returns {any} */
export function citationFromRow(row) {
  if (row === undefined) return null
  return {
    citeId: row.cite_id,
    entryId: row.entry_id,
    sessionId: row.session_id,
    seqStart: row.seq_start,
    seqEnd: row.seq_end,
    eventTime: row.event_time,
    excerpt: row.excerpt,
    createdAt: row.created_at,
  }
}


/**
 * Apply pragmas, DDL, column backfills and the schema-version stamp.
 * @param {any} db
 */
export function migrateStore(db) {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')
    // Hardware-aware memory bounds: keep SQLite from using unbounded page cache.
    const hardware = hardwareProfile()
    db.exec(`PRAGMA cache_size = -${hardware.cacheKiB}`)
    db.exec(`PRAGMA mmap_size = ${hardware.mmapBytes}`)
    db.exec(DDL)

    // v2 -> v3: time / project / module / task-status dimensions.
    addColumn(db, 'volumes', 'project', "TEXT NOT NULL DEFAULT ''")
    addColumn(db, 'entries', 'module', "TEXT NOT NULL DEFAULT ''")
    addColumn(db, 'entries', 'status', "TEXT NOT NULL DEFAULT ''")
    addColumn(db, 'entries', 'status_seq', 'INTEGER NOT NULL DEFAULT -1')
    addColumn(db, 'entries', 'first_seen_at', 'INTEGER NOT NULL DEFAULT 0')
    addColumn(db, 'entries', 'last_seen_at', 'INTEGER NOT NULL DEFAULT 0')
    addColumn(db, 'citations', 'event_time', 'INTEGER NOT NULL DEFAULT 0')
    addColumn(db, 'entries', 'group_id', "TEXT NOT NULL DEFAULT ''")
    addColumn(db, 'groups', 'summary', "TEXT NOT NULL DEFAULT ''")
    addColumn(db, 'summary_nodes', 'citations', "TEXT NOT NULL DEFAULT '[]'")
    addColumn(db, 'summary_nodes', 'signature', "TEXT NOT NULL DEFAULT ''")
    // Dimension indexes are created after the columns exist (v2 DBs lack them).
    db.exec('CREATE INDEX IF NOT EXISTS ix_entries_module ON entries(volume_id, module, last_seen_at)')

    // Backfill project / timestamps / module for rows written before v3.
    db.exec(`UPDATE volumes SET project = CASE WHEN scope LIKE 'project:%' THEN substr(scope, 9) ELSE '' END
                  WHERE project = ''`)
    db.exec('UPDATE entries SET first_seen_at = created_at WHERE first_seen_at = 0')
    db.exec('UPDATE entries SET last_seen_at = updated_at WHERE last_seen_at = 0')
    db.exec(`UPDATE entries SET module = CASE
                    WHEN instr(headword_norm, '/') > 0 AND instr(headword_norm, '/') > 0
                    THEN substr(headword_norm, 1, instr(headword_norm, '/') + instr(substr(headword_norm, instr(headword_norm, '/') + 1), '/') - 1)
                    ELSE '' END
                  WHERE module = '' AND kind IN ('file', 'api-symbol')`)

    const row = db.prepare('PRAGMA user_version').get()
    const current = Number(row?.user_version ?? 0)
    if (current !== SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

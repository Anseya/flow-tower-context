/**
 * --- module contract ---
 * purpose: Store-backed relation CRUD and single-node reads (add/remove/checked add, neighbors, resolve).
 * dependsOn: [generated] lib/relations-types.js, lib/store.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/relations-view.js, lib/relations.js
 * publicApi: [generated] addRelation, addRelationChecked, incoming, neighbors, outgoing, removeRelation, resolveNode, rowToEdge
 * risk: Medium: writes must stay idempotent; callers rely on fail-soft { ok, reason } results.
 * --- end module contract ---
 */

import { canonicalType, inverseType, nodeFamily, normalizeEdge, RELATIONS } from './relations-types.js'

/**
 * Add (idempotently upsert) one relation. Inverse input types are canonicalized.
 * @param {import('./store.js').FlowStore} store
 * @param {{ fromId: string, fromKind: string, toId: string, toKind: string,
 *   type: string, source?: string, confidence?: number, evidence?: any[],
 *   status?: string, note?: string, batchId?: string, now?: number,
 *   fromVolume?: string, toVolume?: string }} input
 * @returns {{ ok: boolean, reason?: string }}
 */
export function addRelation(store, input) {
  const normalized = normalizeEdge(input)
  if (!normalized.ok) return normalized
  const edge = normalized.edge
  const now = input.now ?? Date.now()
  try {
    store.prepare(
      `INSERT INTO relations (from_id, from_kind, from_volume, to_id, to_kind, to_volume,
         rel_type, source, confidence, evidence, status, note, batch_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_id, to_id, rel_type) DO UPDATE SET
         source = excluded.source, confidence = excluded.confidence,
         evidence = excluded.evidence, status = excluded.status,
         note = excluded.note, batch_id = excluded.batch_id, created_at = excluded.created_at`,
    ).run(
      edge.fromId,
      edge.fromKind,
      input.fromVolume ?? '',
      edge.toId,
      edge.toKind,
      input.toVolume ?? '',
      edge.type,
      input.source ?? 'compiler',
      Math.max(0, Math.min(1, Number(input.confidence ?? 1))),
      JSON.stringify(input.evidence ?? []),
      input.status ?? 'active',
      input.note ?? '',
      input.batchId ?? '',
      now,
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Remove one relation (canonicalizes inverse types/endpoint order first).
 * @param {import('./store.js').FlowStore} store
 * @param {{ fromId: string, toId: string, type: string }} input
 * @returns {{ ok: boolean, removed?: number, reason?: string }}
 */
export function removeRelation(store, input) {
  const normalized = normalizeEdge(input)
  if (!normalized.ok) return normalized
  const edge = normalized.edge
  const result = store.db.prepare(
    'DELETE FROM relations WHERE from_id = ? AND to_id = ? AND rel_type = ?',
  ).run(edge.fromId, edge.toId, edge.type)
  return { ok: true, removed: Number(result.changes ?? 0) }
}

/**
 * Add a relation with cycle protection for non-cyclic families. Intended for
 * human/agent edits (not bulk sync, where DFS per edge would be too slow).
 * @param {import('./store.js').FlowStore} store
 * @param {any} input
 * @returns {{ ok: boolean, reason?: string }}
 */
export function addRelationChecked(store, input) {
  const added = addRelation(store, input)
  if (!added.ok) return added
  const type = canonicalType(input.type)
  const def = RELATIONS[type]
  if (def !== undefined && !def.cyclic) {
    const cycles = findCycles(store, type).cycles
    if (cycles.length > 0) {
      removeRelation(store, input)
      return { ok: false, reason: `rejected: ${type} would create a cycle` }
    }
  }
  return { ok: true }
}

/**
 * @param {import('./store.js').FlowStore} store
 * @param {string} nodeId
 * @returns {any[]} edges where this node is the source
 */
export function outgoing(store, nodeId) {
  return store.db.prepare('SELECT * FROM relations WHERE from_id = ? ORDER BY rel_type, to_id').all(nodeId).map(rowToEdge)
}

/**
 * @param {import('./store.js').FlowStore} store
 * @param {string} nodeId
 * @returns {any[]} edges pointing at this node, with inverse type labels
 */
export function incoming(store, nodeId) {
  return store.db.prepare('SELECT * FROM relations WHERE to_id = ? ORDER BY rel_type, from_id').all(nodeId)
    .map((row) => {
      const edge = rowToEdge(row)
      return {
        ...edge,
        type: inverseType(edge.type),
        inverse: edge.type,
      }
    })
}

/**
 * @param {import('./store.js').FlowStore} store
 * @param {string} nodeId
 * @returns {{ outgoing: any[], incoming: any[] }}
 */
export function neighbors(store, nodeId) {
  return { outgoing: outgoing(store, nodeId), incoming: incoming(store, nodeId) }
}

/**
 * @param {any} row
 * @returns {any}
 */
export function rowToEdge(row) {
  return {
    fromId: row.from_id,
    fromKind: row.from_kind,
    fromVolume: row.from_volume,
    toId: row.to_id,
    toKind: row.to_kind,
    toVolume: row.to_volume,
    type: row.rel_type,
    source: row.source,
    confidence: Number(row.confidence),
    evidence: (() => {
      try {
        const parsed = JSON.parse(row.evidence)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    })(),
    status: row.status,
    note: row.note,
    batchId: row.batch_id,
    createdAt: Number(row.created_at),
  }
}

/**
 * Resolve a node for display and existence checks.
 * @param {import('./store.js').FlowStore} store
 * @param {string} nodeId
 * @returns {{ id: string, family: string, exists: boolean, kind: string, label: string }}
 */
export function resolveNode(store, nodeId) {
  const id = String(nodeId ?? '')
  const family = nodeFamily(id)
  try {
    if (family === 'entry') {
      const entry = store.getEntry(id)
      return entry === null
        ? { id, family, exists: false, kind: 'entry', label: id }
        : { id, family, exists: true, kind: entry.kind, label: entry.headword }
    }
    if (family === 'volume') {
      const volume = store.getVolume(id.slice(2))
      return volume === null
        ? { id, family, exists: false, kind: 'volume', label: id }
        : { id, family, exists: true, kind: 'volume', label: `[volume] ${volume.volumeId}` }
    }
    if (family === 'host') {
      const [, sessionId, seq] = id.split(':')
      return { id, family, exists: true, kind: 'host', label: `message seq ${seq} @${String(sessionId).slice(0, 12)}` }
    }
    if (family === 'group') {
      const row = store.db.prepare('SELECT label FROM groups WHERE group_id = ?').get(id)
      return row === undefined
        ? { id, family, exists: false, kind: 'group', label: id }
        : { id, family, exists: true, kind: 'group', label: row.label }
    }
    if (family === 'summary') {
      const row = store.db.prepare('SELECT label FROM summary_nodes WHERE node_id = ?').get(id)
      return row === undefined
        ? { id, family, exists: false, kind: 'summary', label: id }
        : { id, family, exists: true, kind: 'summary', label: row.label }
    }
  } catch {
    // Fall through to unknown.
  }
  return { id, family: 'unknown', exists: false, kind: 'unknown', label: id }
}

/**
 * --- module contract ---
 * purpose: Relation graph export/import, batch rollback and DOT/Mermaid/neighbor text rendering.
 * dependsOn: [generated] lib/relations-core.js, lib/relations-types.js, lib/store.js, lib/util.js
 * externalDeps: [generated] node:crypto
 * usedBy: [generated] lib/relations.js
 * publicApi: [generated] exportGraph, importGraph, relateText, rollbackBatch, toDot, toMermaid
 * risk: Medium: import must preserve unknown types and stay idempotent; renderers are read-only.
 * --- end module contract ---
 */

import { createHash } from 'node:crypto'
import { stableId } from './util.js'
import { GRAPH_VERSION, RELATIONS } from './relations-types.js'
import { addRelation, incoming, outgoing, resolveNode, rowToEdge } from './relations-core.js'

/**
 * Export the graph as versioned JSON.
 * @param {import('./store.js').FlowStore} store
 * @param {{ volumeId?: string }} [options]
 * @returns {any}
 */
export function exportGraph(store, options = {}) {
  const rows = options.volumeId === undefined
    ? store.db.prepare('SELECT * FROM relations ORDER BY from_id, rel_type, to_id').all()
    : store.db.prepare(
      'SELECT * FROM relations WHERE from_volume = ? OR to_volume = ? ORDER BY from_id, rel_type, to_id',
    ).all(options.volumeId, options.volumeId)
  const edges = rows.map(rowToEdge)
  const nodeIds = new Set()
  for (const edge of edges) {
    nodeIds.add(edge.fromId)
    nodeIds.add(edge.toId)
  }
  const nodes = [...nodeIds].map((id) => resolveNode(store, id))
  return {
    version: GRAPH_VERSION,
    exportedAt: Date.now(),
    relations: Object.entries(RELATIONS).map(([type, def]) => ({
      type,
      inverse: def.inverse,
      cyclic: def.cyclic,
      canonical: def.canonical !== undefined,
    })),
    nodes,
    edges,
  }
}

/**
 * Import a versioned graph; idempotent by (from, to, type). Unknown relation
 * types are preserved with status `unknown` (never dropped).
 * @param {import('./store.js').FlowStore} store
 * @param {any} graph
 * @param {{ volumeId?: string, now?: number, batchId?: string }} [options]
 * @returns {{ imported: number, skipped: number, unknown: number, batchId: string }}
 */
export function importGraph(store, graph, options = {}) {
  const now = options.now ?? Date.now()
  const batchId = options.batchId ?? `imp_${stableId(`import:${now}`, 12)}`
  let imported = 0
  let skipped = 0
  let unknown = 0
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  store.transaction(() => {
    for (const edge of edges) {
      const type = String(edge?.type ?? '')
      if (RELATIONS[type] === undefined) {
        unknown += 1
        // Preserve unknown types verbatim rather than dropping them.
        const fromId = String(edge?.fromId ?? '')
        const toId = String(edge?.toId ?? '')
        if (fromId.length === 0 || toId.length === 0) { skipped += 1; continue }
        store.db.prepare(
          `INSERT OR IGNORE INTO relations (from_id, from_kind, from_volume, to_id, to_kind, to_volume,
             rel_type, source, confidence, evidence, status, note, batch_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?)`,
        ).run(fromId, String(edge?.fromKind ?? 'unknown'), String(edge?.fromVolume ?? options.volumeId ?? ''),
          toId, String(edge?.toKind ?? 'unknown'), String(edge?.toVolume ?? ''),
          type, 'import', 0, JSON.stringify([]), String(edge?.note ?? ''), batchId, now)
        continue
      }
      const result = addRelation(store, {
        fromId: edge.fromId,
        fromKind: edge.fromKind,
        fromVolume: edge.fromVolume ?? options.volumeId ?? '',
        toId: edge.toId,
        toKind: edge.toKind,
        toVolume: edge.toVolume ?? '',
        type,
        source: edge.source ?? 'import',
        confidence: edge.confidence ?? 1,
        evidence: edge.evidence ?? [],
        note: edge.note ?? '',
        batchId,
        now,
      })
      if (result.ok) imported += 1
      else skipped += 1
    }
    store.recordRelationBatch({ batchId, kind: 'import', volumeId: options.volumeId ?? '', stats: { imported, skipped, unknown }, now })
  })
  return { imported, skipped, unknown, batchId }
}

/**
 * Roll back all relations written by one batch.
 * @param {import('./store.js').FlowStore} store
 * @param {string} batchId
 * @returns {{ removed: number }}
 */
export function rollbackBatch(store, batchId) {
  const result = store.db.prepare('DELETE FROM relations WHERE batch_id = ?').run(batchId)
  store.db.prepare('DELETE FROM relation_batches WHERE batch_id = ?').run(batchId)
  return { removed: Number(result.changes ?? 0) }
}

/**
 * Render DOT.
 * @param {any} graph
 * @returns {string}
 */
export function toDot(graph) {
  const escape = (text) => String(text).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  const lines = ['digraph flowtower {', '  rankdir=LR;']
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  for (const node of nodes) {
    const shape = node.family === 'host' ? 'note' : node.family === 'volume' ? 'folder' : 'box'
    lines.push(`  "${escape(node.id)}" [label="${escape(`${node.label} (${node.kind})`)}", shape=${shape}];`)
  }
  for (const edge of graph?.edges ?? []) {
    lines.push(`  "${escape(edge.fromId)}" -> "${escape(edge.toId)}" [label="${escape(edge.type)}"];`)
  }
  lines.push('}')
  return lines.join('\n')
}

/**
 * Render Mermaid.
 * @param {any} graph
 * @returns {string}
 */
export function toMermaid(graph) {
  const escape = (text) => String(text).replaceAll('"', '#quot;').replaceAll('\n', ' ')
  const id = (value) => `n_${createHash('sha1').update(String(value)).digest('hex').slice(0, 10)}`
  const lines = ['graph LR']
  for (const node of graph?.nodes ?? []) {
    lines.push(`  ${id(node.id)}["${escape(`${node.label} (${node.kind})`)}"]`)
  }
  for (const edge of graph?.edges ?? []) {
    lines.push(`  ${id(edge.fromId)} -->|${escape(edge.type)}| ${id(edge.toId)}`)
  }
  return lines.join('\n')
}

/**
 * Format neighbors for text tools.
 * @param {import('./store.js').FlowStore} store
 * @param {string} nodeId
 * @param {{ direction?: 'both'|'outgoing'|'incoming', limit?: number }} [options]
 * @returns {string}
 */
export function relateText(store, nodeId, options = {}) {
  const direction = options.direction ?? 'both'
  const limit = Math.max(1, Math.min(100, options.limit ?? 30))
  const minConfidence = Math.max(0, Math.min(1, Number(options.minConfidence ?? 0)))
  const node = resolveNode(store, nodeId)
  const edges = []
  if (direction !== 'incoming') {
    for (const edge of outgoing(store, nodeId)) {
      if (edge.status !== 'active' || edge.confidence < minConfidence) continue
      edges.push({ direction: '→', edge, other: edge.toId, otherKind: edge.toKind, type: edge.type })
    }
  }
  if (direction !== 'outgoing') {
    for (const edge of incoming(store, nodeId)) {
      if (edge.status !== 'active' || edge.confidence < minConfidence) continue
      edges.push({ direction: '←', edge, other: edge.fromId, otherKind: edge.fromKind, type: edge.type })
    }
  }
  if (edges.length === 0) {
    return `No relations for ${node.label} (${node.kind}; ${node.id}). Build them with relationsMode or tools/relations.mjs --sync.`
  }
  const lines = [`## ${node.label} [${node.kind}] · ${edges.length} relation(s)`]
  for (const item of edges.slice(0, limit)) {
    const other = resolveNode(store, item.other)
    const confidence = item.edge.confidence < 1 ? ` · conf ${item.edge.confidence}` : ''
    const source = item.edge.source !== 'compiler' ? ` · ${item.edge.source}` : ''
    lines.push(`- ${item.direction} ${item.type}: ${other.label} [${other.kind}]${confidence}${source}`)
  }
  if (edges.length > limit) lines.push(`… ${edges.length - limit} more`)
  return lines.join('\n')
}

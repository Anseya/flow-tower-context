/**
 * --- module contract ---
 * purpose: Relation graph lifecycle: sync from store data, validate and cycle-check; re-exports the types/core/view modules.
 * dependsOn: [generated] lib/lock.js, lib/relations-core.js, lib/relations-types.js, lib/relations-view.js, lib/store.js, lib/util.js
 * externalDeps: [generated] node:crypto
 * usedBy: [generated] eval/relations-bench.mjs, lib/compiler.js, lib/tools/lookup.js, lib/tools/relate.js, lib/web-read.js, test/flow-tower.test.js, tools/export-data.mjs, tools/import-data.mjs, tools/mcp-server.mjs, tools/merge-projects.mjs, tools/relations.mjs
 * publicApi: [generated] *, findCycles, syncRelations, validateRelations
 * risk: Medium-high: sync holds the cross-process write lock and must rebuild hierarchy edges only on change; keep fail-soft.
 * --- end module contract ---
 */

import { createHash } from 'node:crypto'
import { stableId } from './util.js'
import { withLock } from './lock.js'
import { canonicalType, nodeIdForEntry, nodeIdForHost, nodeIdForVolume, RELATIONS } from './relations-types.js'
import { addRelation, resolveNode, rowToEdge } from './relations-core.js'

export * from './relations-types.js'
export * from './relations-core.js'
export * from './relations-view.js'

/**
 * Validate the graph: unknown types, dangling endpoints, malformed evidence.
 * Cycle checks are reported separately (by family) because some families allow
 * cycles by design.
 * @param {import('./store.js').FlowStore} store
 * @param {{ volumeId?: string }} [options]
 * @returns {{ issues: any[], edges: number, dangling: number, unknownTypes: number }}
 */
export function validateRelations(store, options = {}) {
  const rows = options.volumeId === undefined
    ? store.db.prepare('SELECT * FROM relations').all()
    : store.db.prepare(
      `SELECT * FROM relations
       WHERE from_volume = ? OR to_volume = ? OR (from_volume = '' AND to_volume = '')`,
    ).all(options.volumeId, options.volumeId)
  const issues = []
  let dangling = 0
  let unknownTypes = 0
  const resolvedCache = new Map()
  const resolveCached = (nodeId) => {
    if (!resolvedCache.has(nodeId)) resolvedCache.set(nodeId, resolveNode(store, nodeId))
    return resolvedCache.get(nodeId)
  }
  for (const row of rows) {
    const edge = rowToEdge(row)
    if (RELATIONS[edge.type] === undefined) {
      unknownTypes += 1
      issues.push({ code: 'unknown-type', edge })
    }
    for (const [side, id, kind, volume] of [
      ['from', edge.fromId, edge.fromKind, edge.fromVolume],
      ['to', edge.toId, edge.toKind, edge.toVolume],
    ]) {
      const resolved = resolveCached(id)
      if (resolved.family === 'host') continue
      if (!resolved.exists) {
        // Volumes explicitly tagged with another project path are external merge
        // endpoints (schema v5): keep them, but do not report them as dangling.
        if (kind === 'volume' && volume.length > 0 && options.volumeId !== undefined && volume !== options.volumeId) {
          continue
        }
        dangling += 1
        issues.push({ code: 'dangling-endpoint', side, edge })
      }
    }
  }
  return { issues, edges: rows.length, dangling, unknownTypes }
}

/**
 * Detect cycles for a canonical relation type (only non-cyclic families are checked).
 * @param {import('./store.js').FlowStore} store
 * @param {string} type
 * @param {{ volumeId?: string }} [options]
 * @returns {{ cycles: string[][] }}
 */
export function findCycles(store, type, options = {}) {
  const canonical = canonicalType(type)
  const def = RELATIONS[canonical]
  if (def === undefined) return { cycles: [] }
  if (def.cyclic) return { cycles: [] }
  const rows = store.db.prepare('SELECT from_id, to_id FROM relations WHERE rel_type = ?').all(canonical)
  const adjacency = new Map()
  for (const row of rows) {
    const list = adjacency.get(row.from_id) ?? []
    list.push(row.to_id)
    adjacency.set(row.from_id, list)
  }
  const cycles = []
  const visiting = new Set()
  const visited = new Set()
  /** @param {string} node @param {string[]} path */
  const dfs = (node, path) => {
    if (visiting.has(node)) {
      const start = path.indexOf(node)
      cycles.push([...path.slice(start >= 0 ? start : 0), node])
      return
    }
    if (visited.has(node)) return
    visiting.add(node)
    path.push(node)
    for (const next of adjacency.get(node) ?? []) dfs(next, path)
    path.pop()
    visiting.delete(node)
    visited.add(node)
  }
  for (const node of adjacency.keys()) dfs(node, [])
  return { cycles }
}

/** Group kinds map onto summary-tree category buckets. */
const CATEGORY_FOR_GROUP_KIND = Object.freeze({
  module: 'code',
  file: 'code',
  'api-symbol': 'code',
  feature: 'memory',
  decision: 'memory',
  task: 'memory',
  chapter: 'narrative',
  person: 'narrative',
  error: 'diagnostics',
  command: 'diagnostics',
  topic: 'diagnostics',
})

/**
 * Sync graph edges from authoritative store data, guarded by a cross-process
 * advisory lock so two Harness instances do not double-write concurrently.
 * @param {import('./store.js').FlowStore} store
 * @param {string} volumeId
 * @param {{ now?: number, batchId?: string, log?: any }} [options]
 * @returns {{ entries: number, edges: number, batchId: string, incremental: boolean }}
 */
export function syncRelations(store, volumeId, options = {}) {
  // In-memory stores cannot own a lock file (no stable path); tests and
  // short-lived readers do not need cross-process serialization.
  if (store.path === ':memory:') return syncRelationsInner(store, volumeId, options)
  const lockPath = `${store.path}.relations.lock`
  try {
    return withLock(lockPath, () => syncRelationsInner(store, volumeId, options), {
      timeoutMs: options.lockTimeoutMs ?? 5000,
    })
  } catch (error) {
    options.log?.warn?.(`relation sync skipped (${error instanceof Error ? error.message : String(error)})`)
    return { entries: 0, edges: 0, batchId: '', incremental: true }
  }
}

/**
 * Materialize task→nearby-entry context edges. A task's citation seq anchors
 * its working context; entries with evidence inside ±8 seq in the same session
 * become explicit `taskContext` edges (capped), so the relation is queryable
 * instead of being recomputed ad hoc by the web panel.
 * @param {import('./store.js').FlowStore} store
 * @param {string} volumeId
 * @param {string} batchId
 * @param {number} now
 * @returns {number} edges added
 */
function syncTaskContextEdges(store, volumeId, batchId, now) {
  const tasks = store.db.prepare(
    "SELECT entry_id FROM entries WHERE volume_id = ? AND kind = 'task' ORDER BY last_seen_at DESC LIMIT 500",
  ).all(volumeId)
  let added = 0
  for (const task of tasks) {
    const seen = new Set()
    for (const citation of store.citationsFor(task.entry_id).slice(0, 5)) {
      const rows = store.db.prepare(
        `SELECT DISTINCT entry_id FROM citations
         WHERE session_id = ? AND entry_id != ? AND seq_start BETWEEN ? AND ?
         LIMIT 20`,
      ).all(citation.sessionId, task.entry_id, citation.seqStart - 8, citation.seqStart + 8)
      for (const row of rows) {
        if (seen.has(row.entry_id) || seen.size >= 8) continue
        const target = store.getEntry(row.entry_id)
        if (target === null) continue
        const result = addRelation(store, {
          fromId: task.entry_id,
          fromKind: 'task',
          fromVolume: volumeId,
          toId: target.entryId,
          toKind: 'entry',
          toVolume: volumeId,
          type: 'taskContext',
          source: 'compiler',
          confidence: 0.8,
          evidence: [citation.citeId],
          batchId,
          now,
        })
        if (result.ok) { seen.add(row.entry_id); added += 1 }
      }
    }
  }
  return added
}

/**
 * @param {import('./store.js').FlowStore} store
 * @param {string} volumeId
 * @param {{ now?: number, batchId?: string, log?: any }} [options]
 * @returns {{ entries: number, edges: number, batchId: string, incremental: boolean }}
 */
function syncRelationsInner(store, volumeId, options = {}) {
  const now = options.now ?? Date.now()
  const batchId = options.batchId ?? `rel_${stableId(`${volumeId}:${now}`, 12)}`
  const watermarkKey = `relations:synced:${volumeId}`
  const watermark = options.full === true ? 0 : (Number(store.getKv(watermarkKey) ?? 0) || 0)
  const entryIds = Array.isArray(options.entryIds)
    ? [...new Set(options.entryIds)].slice(0, 5000)
    : null
  const rows = entryIds === null
    ? store.db.prepare(
      `SELECT entry_id, revision_of, related, group_id FROM entries WHERE volume_id = ? AND last_seen_at > ? ORDER BY last_seen_at LIMIT 5000`,
    ).all(volumeId, watermark)
    : entryIds.length === 0
      ? []
      : store.db.prepare(
        `SELECT entry_id, revision_of, related, group_id FROM entries
         WHERE volume_id = ? AND entry_id IN (${entryIds.map(() => '?').join(',')})
         LIMIT 5000`,
      ).all(volumeId, ...entryIds)
  let edges = 0
  try {
    store.transaction(() => {
      for (const row of rows) {
        const citations = store.citationsFor(row.entry_id)
        for (const citation of citations) {
          const result = addRelation(store, {
            fromId: nodeIdForEntry(row.entry_id),
            fromKind: 'entry',
            fromVolume: volumeId,
            toId: nodeIdForHost(citation.sessionId, citation.seqStart),
            toKind: 'host',
            type: 'derivedFrom',
            source: 'compiler',
            confidence: 1,
            evidence: [citation.citeId],
            batchId,
            now,
          })
          if (result.ok) edges += 1
        }
        if (typeof row.revision_of === 'string' && row.revision_of.length > 0) {
          if (store.getEntry(row.revision_of) !== null) {
            addRelation(store, {
              fromId: nodeIdForEntry(row.entry_id),
              fromKind: 'entry',
              fromVolume: volumeId,
              toId: nodeIdForEntry(row.revision_of),
              toKind: 'entry',
              toVolume: volumeId,
              type: 'replaces',
              source: 'compiler',
              confidence: 1,
              evidence: [],
              batchId,
              now,
            })
            edges += 1
          }
        }
        // Migrate the legacy weak `related` list into symmetric relatedTo edges.
        let relatedIds = []
        try {
          relatedIds = JSON.parse(row.related ?? '[]')
        } catch {
          relatedIds = []
        }
        if (Array.isArray(relatedIds)) {
          for (const targetId of relatedIds.slice(0, 5)) {
            if (typeof targetId !== 'string' || store.getEntry(targetId) === null) continue
            const result = addRelation(store, {
              fromId: nodeIdForEntry(row.entry_id),
              fromKind: 'entry',
              fromVolume: volumeId,
              toId: nodeIdForEntry(targetId),
              toKind: 'entry',
              toVolume: volumeId,
              type: 'relatedTo',
              source: 'migration',
              confidence: 0.4,
              evidence: [],
              batchId,
              now,
            })
            if (result.ok) edges += 1
          }
        }
        // Incremental hierarchy edge: entry -> its current group.
        if (typeof row.group_id === 'string' && row.group_id.length > 0) {
          const result = addRelation(store, {
            fromId: nodeIdForEntry(row.entry_id),
            fromKind: 'entry',
            fromVolume: volumeId,
            toId: row.group_id,
            toKind: 'group',
            type: 'parent',
            source: 'compiler',
            confidence: 1,
            batchId,
            now,
          })
          if (result.ok) edges += 1
        }
      }
      store.recordRelationBatch({ batchId, kind: 'sync', volumeId, stats: { entries: rows.length, edges }, now })
      store.setKv(watermarkKey, String(now))
    })
    // Group/category/volume hierarchy edges are rebuilt only when the group
    // structure changes; per-entry parent edges are added incrementally above.
    try {
      const groups = store.listGroups(volumeId, null)
        .flatMap((rootGroup) => store.listGroups(volumeId, rootGroup.groupId))
      const signature = createHash('sha1')
        .update(`${volumeId}|${store.getVolume(volumeId)?.entryCount ?? 0}|${groups.map((group) => `${group.groupId}:${group.label}:${group.size}`).join('|')}`)
        .digest('hex')
        .slice(0, 16)
      const hierarchyKey = `relations:hierarchy:${volumeId}`
      if (store.getKv(hierarchyKey) !== signature) {
        store.transaction(() => {
          const summaryNodes = store.listSummaryNodes(volumeId)
          const rootNode = summaryNodes.find((node) => node.level === 0)
          const categories = summaryNodes.filter((node) => node.level === 1)
          for (const group of groups) {
            const categoryKey = CATEGORY_FOR_GROUP_KIND[group.kind] ?? 'memory'
            const category = categories.find((node) => node.label.includes(`[category] ${categoryKey}`))
            if (category === undefined) continue
            addRelation(store, {
              fromId: group.groupId,
              fromKind: 'group',
              fromVolume: volumeId,
              toId: category.nodeId,
              toKind: 'summary',
              type: 'parent',
              source: 'compiler',
              confidence: 1,
              batchId,
              now,
            })
          }
          if (rootNode !== undefined) {
            for (const category of categories) {
              addRelation(store, {
                fromId: category.nodeId,
                fromKind: 'summary',
                fromVolume: volumeId,
                toId: rootNode.nodeId,
                toKind: 'summary',
                type: 'parent',
                source: 'compiler',
                confidence: 1,
                batchId,
                now,
              })
            }
            addRelation(store, {
              fromId: rootNode.nodeId,
              fromKind: 'summary',
              fromVolume: volumeId,
              toId: nodeIdForVolume(volumeId),
              toKind: 'volume',
              type: 'parent',
              source: 'compiler',
              confidence: 1,
              batchId,
              now,
            })
          }
          store.setKv(hierarchyKey, signature)
        })
      }
    } catch (error) {
      options.log?.warn?.(`relation hierarchy sync failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  } catch (error) {
    options.log?.warn?.(`relation sync failed: ${error instanceof Error ? error.message : String(error)}`)
    return { entries: rows.length, edges: 0, batchId, incremental: watermark > 0 }
  }
  try {
    edges += syncTaskContextEdges(store, volumeId, batchId, now)
  } catch (error) {
    options.log?.warn?.(`task-context relation sync skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { entries: rows.length, edges, batchId, incremental: watermark > 0 }
}

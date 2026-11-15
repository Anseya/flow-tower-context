/**
 * --- module contract ---
 * purpose: Relation registry, node-id helpers and edge normalization (pure, store-free).
 * dependsOn: [generated] (none)
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/relations-core.js, lib/relations-view.js, lib/relations.js
 * publicApi: [generated] GRAPH_VERSION, NODE_KINDS, RELATIONS, canonicalType, inverseType, nodeFamily, nodeIdForEntry, nodeIdForGroup, nodeIdForHost, nodeIdForSummary, nodeIdForVolume, normalizeEdge
 * risk: Medium: canonical/inverse/symmetric rules are the graph's invariant; change with cycle and import/export tests.
 * --- end module contract ---
 */

/** Serialized graph format version. */
export const GRAPH_VERSION = 'relations.v1'

/** Node kinds that may participate in the graph. */
export const NODE_KINDS = Object.freeze([
  'file', 'feature', 'api-symbol', 'decision', 'task', 'command', 'error', 'topic',
  'chapter', 'person', 'volume', 'host', 'group', 'summary',
])

/**
 * Relation registry: canonical types with inverse + cycle policy.
 * Inverse types are accepted on input and normalized to the canonical endpoint order.
 */
export const RELATIONS = Object.freeze({
  parent: { inverse: 'child', cyclic: false, canonical: 'parent', label: '父级' },
  child: { inverse: 'parent', cyclic: false, normalizedTo: 'parent', label: '子级' },
  derivedFrom: { inverse: 'derivedTo', cyclic: false, canonical: 'derivedFrom', label: '派生自' },
  derivedTo: { inverse: 'derivedFrom', cyclic: false, normalizedTo: 'derivedFrom', label: '派生出' },
  cites: { inverse: 'citedBy', cyclic: true, canonical: 'cites', label: '引用' },
  citedBy: { inverse: 'cites', cyclic: true, normalizedTo: 'cites', label: '被引用' },
  replaces: { inverse: 'replacedBy', cyclic: false, canonical: 'replaces', label: '替换' },
  replacedBy: { inverse: 'replaces', cyclic: false, normalizedTo: 'replaces', label: '被替换' },
  mergedFrom: { inverse: 'mergedInto', cyclic: false, canonical: 'mergedFrom', label: '合并自' },
  mergedInto: { inverse: 'mergedFrom', cyclic: false, normalizedTo: 'mergedFrom', label: '并入' },
  sibling: { inverse: 'sibling', cyclic: true, canonical: 'sibling', symmetric: true, label: '兄弟' },
  relatedTo: { inverse: 'relatedTo', cyclic: false, canonical: 'relatedTo', symmetric: true, label: '相关' },
  taskContext: { inverse: 'contextOf', cyclic: true, canonical: 'taskContext', label: '任务上下文' },
  contextOf: { inverse: 'taskContext', cyclic: true, normalizedTo: 'taskContext', label: '属于任务' },
})

/** Prefixes used to build node ids. */
export function nodeIdForEntry(entryId) { return entryId }
export function nodeIdForVolume(volumeId) { return `v:${volumeId}` }
export function nodeIdForHost(sessionId, seq) { return `h:${sessionId}:${seq}` }
export function nodeIdForGroup(groupId) { return groupId }
export function nodeIdForSummary(nodeId) { return nodeId }

/**
 * @param {string} type
 * @returns {string} canonical type (for non-canonical inverse input)
 */
export function canonicalType(type) {
  const def = RELATIONS[type]
  return def?.canonical ?? def?.normalizedTo ?? type
}

/**
 * @param {string} nodeId
 * @returns {string} 'entry' | 'volume' | 'host' | 'group' | 'summary' | 'unknown'
 */
export function nodeFamily(nodeId) {
  const value = String(nodeId ?? '')
  if (value.startsWith('e_')) return 'entry'
  if (value.startsWith('v:')) return 'volume'
  if (value.startsWith('h:')) return 'host'
  if (value.startsWith('grp_')) return 'group'
  if (value.startsWith('sum_')) return 'summary'
  return 'unknown'
}

/**
 * Normalize one edge request: canonical type, canonical endpoint order.
 * @param {{ fromId: string, fromKind: string, toId: string, toKind: string, type: string }} input
 * @returns {{ ok: true, edge: any } | { ok: false, reason: string }}
 */
export function normalizeEdge(input) {
  const fromId = String(input?.fromId ?? '')
  const toId = String(input?.toId ?? '')
  const type = String(input?.type ?? '')
  const def = RELATIONS[type]
  if (!def) return { ok: false, reason: `unknown relation type "${type}"` }
  if (fromId.length === 0 || toId.length === 0) return { ok: false, reason: 'both endpoints are required' }
  if (fromId === toId && def.inverse !== type) return { ok: false, reason: 'self relation is not allowed' }
  let canonical = def.canonical
  let from = fromId
  let to = toId
  let fromKind = String(input.fromKind ?? '')
  let toKind = String(input.toKind ?? '')
  if (def.normalizedTo !== undefined) {
    canonical = def.normalizedTo
    ;[from, to] = [to, from]
    ;[fromKind, toKind] = [toKind, fromKind]
  }
  const symmetric = RELATIONS[canonical]?.symmetric === true
  if (symmetric && from > to) {
    ;[from, to] = [to, from]
    ;[fromKind, toKind] = [toKind, fromKind]
  }
  return {
    ok: true,
    edge: {
      fromId: from,
      fromKind,
      toId: to,
      toKind,
      type: canonical,
      inverse: RELATIONS[canonical]?.inverse ?? canonical,
      symmetric,
      cyclic: RELATIONS[canonical]?.cyclic === true,
    },
  }
}

/**
 * @param {string} type
 * @returns {string} the label a reversed lookup should show
 */
export function inverseType(type) {
  return RELATIONS[type]?.inverse ?? type
}

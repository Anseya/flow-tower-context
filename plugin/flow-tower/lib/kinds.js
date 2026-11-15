/**
 * --- module contract ---
 * purpose: Shared kind ordering and kind labels for catalog/digest rendering.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/catalog.js, lib/digest.js
 * publicApi: [generated] KIND_ORDER, kindLabel
 * risk: Low: pure constants.
 * --- end module contract ---
 */

/** Kind display order used by every rendered listing. */
export const KIND_ORDER = Object.freeze([
  'file',
  'feature',
  'api-symbol',
  'decision',
  'task',
  'command',
  'error',
  'topic',
  'chapter',
  'person',
])

/** @param {string} kind @param {any} entry @returns {string} */
export function kindLabel(kind, entry) {
  if (kind === 'task' && entry?.status.length > 0) return `${kind}:${entry.status}`
  return kind
}

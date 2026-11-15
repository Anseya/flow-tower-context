/**
 * --- module contract ---
 * purpose: Sparse TF-IDF/co-occurrence semantic-lite retrieval without neural embeddings.
 * dependsOn: [generated] lib/store.js, lib/text-index.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] eval/search-recall.mjs, lib/hybrid-search.js, lib/tools/search.js, lib/web-read.js, test/flow-tower.test.js
 * publicApi: [generated] expandTerms, semanticSearch
 * risk: Medium: ranking behavior is user-visible and must stay deterministic.
 * --- end module contract ---
 */

import { tokenize } from './text-index.js'

/**
 * Resolve the volume scope for semantic search.
 * @param {import('./store.js').FlowStore} store
 * @param {{ volumeId?: string, project?: string }} options
 * @returns {string[]}
 */
function scopeVolumes(store, options) {
  if (options.volumeId !== undefined) return [options.volumeId]
  if (options.project !== undefined) {
    return store.listVolumes({ project: options.project, limit: 200 }).map((volume) => volume.volumeId)
  }
  return store.db.prepare('SELECT volume_id FROM volumes').all().map((row) => row.volume_id)
}

/**
 * Co-occurrence expansion: for each query term, related terms that appear in
 * the same entries (top-N by shared-entry count).
 * @param {import('./store.js').FlowStore} store
 * @param {string[]} volumeIds
 * @param {string[]} terms
 * @param {{ maxPerTerm?: number, maxTotal?: number }} [options]
 * @returns {string[]}
 */
export function expandTerms(store, volumeIds, terms, options = {}) {
  const maxPerTerm = options.maxPerTerm ?? 2
  const maxTotal = options.maxTotal ?? 6
  if (volumeIds.length === 0 || terms.length === 0) return []
  const placeholders = volumeIds.map(() => '?').join(',')
  const expanded = []
  try {
    const related = store.db.prepare(
      `SELECT s2.term AS term, COUNT(*) AS n
       FROM search_terms s1
       JOIN search_terms s2 ON s2.entry_id = s1.entry_id AND s2.term <> s1.term
       WHERE s1.term = ? AND s1.volume_id IN (${placeholders})
       GROUP BY s2.term ORDER BY n DESC LIMIT ?`,
    )
    for (const term of terms) {
      for (const row of related.all(term, ...volumeIds, maxPerTerm)) {
        if (terms.includes(row.term) || expanded.includes(row.term)) continue
        expanded.push(row.term)
        if (expanded.length >= maxTotal) return expanded
      }
    }
  } catch {
    return expanded
  }
  return expanded
}

/**
 * Sparse-vector (TF-IDF) cosine search with query expansion.
 * @param {import('./store.js').FlowStore} store
 * @param {string} query
 * @param {{ volumeId?: string, project?: string, kind?: string, limit?: number, expand?: boolean }} [options]
 * @returns {{ entry: any, score: number, matched: string[] }[]}
 */
export function semanticSearch(store, query, options = {}) {
  const limit = Math.max(1, Math.min(100, options.limit ?? 20))
  const baseTerms = [...new Set(tokenize(query))].slice(0, 10)
  if (baseTerms.length === 0) return []
  const volumeIds = scopeVolumes(store, options)
  if (volumeIds.length === 0) return []
  store.ensureSearchIndex(volumeIds)
  const placeholders = volumeIds.map(() => '?').join(',')
  const expand = options.expand !== false
  const expanded = expand ? expandTerms(store, volumeIds, baseTerms, { maxPerTerm: 2, maxTotal: 6 }) : []
  const terms = [...baseTerms, ...expanded]
  const totalRow = store.db.prepare(
    `SELECT COUNT(1) AS n FROM entries WHERE volume_id IN (${placeholders})`,
  ).get(...volumeIds)
  const total = Number(totalRow?.n ?? 0)
  if (total === 0) return []

  // Document frequency per term (for idf).
  const idf = new Map()
  for (const term of terms) {
    const row = store.db.prepare(
      `SELECT COUNT(DISTINCT entry_id) AS n FROM search_terms
       WHERE term = ? AND volume_id IN (${placeholders})`,
    ).get(term, ...volumeIds)
    const df = Number(row?.n ?? 0)
    if (df > 0) idf.set(term, Math.log(1 + (total - df + 0.5) / (df + 0.5)))
  }
  if (idf.size === 0) return []

  // Candidate entries and their sparse vectors.
  /** @type {Map<string, Map<string, number>>} */
  const vectors = new Map()
  const termPlaceholders = terms.map(() => '?').join(',')
  const rows = store.db.prepare(
    `SELECT entry_id, term, weight FROM search_terms
     WHERE term IN (${termPlaceholders}) AND volume_id IN (${placeholders})
     LIMIT 8000`,
  ).all(...terms, ...volumeIds)
  for (const row of rows) {
    const vector = vectors.get(row.entry_id) ?? new Map()
    vector.set(row.term, Number(row.weight) * (idf.get(row.term) ?? 1))
    vectors.set(row.entry_id, vector)
  }

  // Query vector: base terms get full weight, expansions half weight.
  const queryVector = new Map()
  for (const term of baseTerms) if (idf.has(term)) queryVector.set(term, (idf.get(term) ?? 1))
  for (const term of expanded) if (idf.has(term)) queryVector.set(term, (idf.get(term) ?? 1) * 0.5)
  const queryNorm = Math.sqrt([...queryVector.values()].reduce((sum, value) => sum + value * value, 0))
  if (queryNorm === 0) return []

  const scored = []
  for (const [entryId, vector] of vectors) {
    let dot = 0
    const matched = []
    for (const [term, weight] of vector) {
      const queryWeight = queryVector.get(term)
      if (queryWeight === undefined) continue
      dot += weight * queryWeight
      if (baseTerms.includes(term)) matched.push(term)
    }
    if (dot <= 0) continue
    const norm = Math.sqrt([...vector.values()].reduce((sum, value) => sum + value * value, 0))
    if (norm === 0) continue
    scored.push({ entryId, score: dot / (norm * queryNorm), matched })
  }
  scored.sort((left, right) => right.score - left.score)
  const out = []
  for (const item of scored.slice(0, limit * 3)) {
    const entry = store.getEntry(item.entryId)
    if (entry === null) continue
    if (options.kind !== undefined && entry.kind !== options.kind) continue
    out.push({ entry, score: Number(item.score.toFixed(3)), matched: item.matched })
    if (out.length >= limit) break
  }
  return out
}

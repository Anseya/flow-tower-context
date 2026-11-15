/**
 * --- module contract ---
 * purpose: Hybrid lexical + sparse-semantic search with exact/prefix/alias boosts and structured filters.
 * dependsOn: [generated] lib/semantic.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] eval/search-recall.mjs, lib/tools/search.js, lib/web-read.js, test/flow-tower.test.js
 * publicApi: [generated] hybridSearch, matchesFilters, sortHits
 * risk: Medium: default search ranking is user-visible; it must stay deterministic and degrade to lexical on semantic failure.
 * --- end module contract ---
 */

import { semanticSearch } from './semantic.js'

/**
 * Lexical order is preserved (it is the trustworthy signal on project
 * dictionaries); sparse-semantic hits fill slots only after lexical hits.
 * A pure RRF fusion measured worse than lexical on the offline recall corpus
 * because sparse semantic noise displaced correct lexical hits.
 */
const SEMANTIC_FILL_FACTOR = 2

/** @param {unknown} text @returns {string} */
function norm(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Post-filter one hit by structured fields (shared by every search mode).
 * @param {{ entry: any }} hit
 * @param {{ kind?: string, module?: string, status?: string, since?: number, until?: number }} filters
 * @returns {boolean}
 */
export function matchesFilters(hit, filters = {}) {
  const entry = hit?.entry
  if (entry === null || entry === undefined) return false
  if (filters.kind !== undefined && filters.kind.length > 0 && entry.kind !== filters.kind) return false
  if (filters.module !== undefined && filters.module.length > 0) {
    const module = String(entry.module ?? '')
    if (module !== filters.module && !module.startsWith(`${filters.module}/`)) return false
  }
  if (filters.status !== undefined && filters.status.length > 0 && entry.status !== filters.status) return false
  if (typeof filters.since === 'number' && Number.isFinite(filters.since) && entry.lastSeenAt < filters.since) return false
  if (typeof filters.until === 'number' && Number.isFinite(filters.until) && entry.lastSeenAt > filters.until) return false
  return true
}

/**
 * Sort hits by relevance or recency.
 * @param {{ score: number, entry: any }[]} hits
 * @param {'relevance' | 'recent'} sort
 * @returns {{ score: number, entry: any }[]}
 */
export function sortHits(hits, sort = 'relevance') {
  return hits.slice().sort((left, right) => {
    if (sort === 'recent') {
      return (right.entry.lastSeenAt - left.entry.lastSeenAt) || (right.score - left.score)
    }
    return (right.score - left.score) || (right.entry.lastSeenAt - left.entry.lastSeenAt)
  })
}

/**
 * Hybrid search: BM25-lite lexical hits + sparse-semantic hits fused with RRF,
 * then deterministic exact/prefix/substring/alias boosts. No network, no model.
 * @param {any} store FlowStore
 * @param {string} query
 * @param {{ volumeId?: string, project?: string, kind?: string, module?: string, status?: string,
 *   since?: number, until?: number, limit?: number, sort?: 'relevance' | 'recent' }} [options]
 * @returns {{ results: { entry: any, score: number, matched: string[], sources: string[], reasons: string[] }[],
 *   meta: { mode: string, lexical: number, semantic: number, timingMs: number } }}
 */
export function hybridSearch(store, query, options = {}) {
  const limit = Math.max(1, Math.min(100, options.limit ?? 15))
  const started = Date.now()
  const scope = {
    ...(options.volumeId === undefined ? {} : { volumeId: options.volumeId }),
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
  }
  let lexical = []
  let semantic = []
  try {
    lexical = store.searchRanked(query, { ...scope, limit: Math.max(limit * 3, 40) })
  } catch { /* semantic fallback below */ }
  try {
    semantic = semanticSearch(store, query, { ...scope, limit: Math.max(limit * SEMANTIC_FILL_FACTOR, 30) })
  } catch { /* lexical-only */ }

  const queryNorm = norm(query)
  const reasonsFor = (entry) => {
    const reasons = []
    const head = norm(entry?.headword)
    if (queryNorm.length < 2) return reasons
    if (head === queryNorm) reasons.push('exact')
    else if (head.startsWith(queryNorm)) reasons.push('prefix')
    else if (head.includes(queryNorm)) reasons.push('substring')
    const aliases = Array.isArray(entry?.aliases) ? entry.aliases.map(norm) : []
    if (aliases.some((alias) => alias === queryNorm || alias.includes(queryNorm))) reasons.push('alias')
    return reasons
  }

  const results = []
  const seen = new Set()
  for (const hit of lexical) {
    if (seen.has(hit.entry.entryId)) continue
    seen.add(hit.entry.entryId)
    results.push({
      entry: hit.entry,
      score: Number(hit.score),
      matched: hit.matched ?? [],
      sources: ['lexical'],
      reasons: reasonsFor(hit.entry),
    })
  }
  // Sparse semantics fill only the slots lexical ranking left empty; this keeps
  // hybrid recall >= lexical by construction on the measured corpus.
  for (const hit of semantic) {
    if (seen.has(hit.entry.entryId)) continue
    seen.add(hit.entry.entryId)
    results.push({
      entry: hit.entry,
      score: Number(hit.score),
      matched: hit.matched ?? [],
      sources: ['semantic'],
      reasons: reasonsFor(hit.entry),
    })
    if (results.length >= limit * SEMANTIC_FILL_FACTOR) break
  }

  const filtered = results.filter((hit) => matchesFilters(hit, options))
  const ordered = options.sort === 'recent'
    ? sortHits(filtered, 'recent')
    : filtered
  const hits = ordered.slice(0, limit)

  return {
    results: hits,
    meta: {
      mode: 'hybrid',
      lexical: lexical.length,
      semantic: semantic.length,
      timingMs: Date.now() - started,
    },
  }
}

/**
 * --- module contract ---
 * purpose: DeepSeek-only smart search: query rewrite and candidate rerank.
 * dependsOn: [generated] lib/store.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/tools/search.js, lib/web-read.js, lib/web.js
 * publicApi: [generated] smartSearch
 * risk: Medium: optional, latency-bearing path; deterministic BM25 must remain the fallback.
 * --- end module contract ---
 */

/**
 * Extract the first balanced JSON object from model output.
 * @param {string} text
 * @returns {string | null}
 */
function firstJsonObject(text) {
  const source = String(text ?? '')
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{') { if (depth === 0) start = index; depth += 1; continue }
    if (char === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) return source.slice(start, index + 1)
      if (depth < 0) { depth = 0; start = -1 }
    }
  }
  return null
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
function parseQueries(raw) {
  const json = firstJsonObject(String(raw ?? '').replace(/```json/gi, '').replace(/```/g, ''))
  if (json === null) return []
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed?.queries)) return []
    return parsed.queries.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 8)
  } catch {
    return []
  }
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
function parseOrder(raw) {
  const json = firstJsonObject(String(raw ?? '').replace(/```json/gi, '').replace(/```/g, ''))
  if (json === null) return []
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed?.order)) return []
    return parsed.order.filter((item) => typeof item === 'string').slice(0, 100)
  } catch {
    return []
  }
}

/**
 * @param {import('./store.js').FlowStore} store
 * @param {string} query
 * @param {{ callModel: (prompt: string) => Promise<string>, volumeId?: string, project?: string,
 *   kind?: string, limit?: number }} options
 * @returns {Promise<{ results: any[], expandedQueries: string[], reranked: boolean, rawRewrite: string, rawRerank: string }>}
 */
export async function smartSearch(store, query, options) {
  const limit = Math.max(1, Math.min(30, Number(options.limit ?? 15)))
  const base = {
    ...(options.volumeId === undefined ? {} : { volumeId: options.volumeId }),
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
  }
  const rewritePrompt = [
    'Rewrite this dictionary search query for a project-memory search engine.',
    'Return JSON only: {"queries":["3-8 alternative phrasings, synonyms, translations and keywords, same intent"]}',
    'Keep code identifiers and proper nouns; do not invent unrelated topics; no explanations.',
    `Query: ${JSON.stringify(String(query ?? ''))}`,
  ].join('\n')
  const rawRewrite = await options.callModel(rewritePrompt)
  const expandedQueries = parseQueries(rawRewrite)
  const merged = new Map()
  for (const candidateQuery of [query, ...expandedQueries].slice(0, 9)) {
    for (const hit of store.searchRanked(candidateQuery, { ...base, limit: limit * 2 })) {
      const current = merged.get(hit.entry.entryId)
      if (current === undefined || hit.score > current.score) merged.set(hit.entry.entryId, hit)
    }
  }
  const candidates = [...merged.values()].sort((left, right) => right.score - left.score).slice(0, Math.max(12, limit * 2))
  if (candidates.length === 0) return { results: [], expandedQueries, reranked: false, rawRewrite, rawRerank: '' }
  const rerankPrompt = [
    'Rerank dictionary entries by semantic relevance to the query.',
    'Return JSON only: {"order":["entryId", ...]} using ONLY the provided entryId values, most relevant first.',
    `Query: ${JSON.stringify(String(query ?? ''))}`,
    `Candidates: ${JSON.stringify(candidates.map((hit) => ({ entryId: hit.entry.entryId, headword: hit.entry.headword, kind: hit.entry.kind, gloss: String(hit.entry.gloss ?? '').slice(0, 180) })))}`,
  ].join('\n')
  const rawRerank = await options.callModel(rerankPrompt)
  const order = parseOrder(rawRerank)
  const byId = new Map(candidates.map((hit) => [hit.entry.entryId, hit]))
  const ranked = []
  for (const id of order) {
    const hit = byId.get(id)
    if (hit !== undefined) { ranked.push(hit); byId.delete(id) }
  }
  for (const hit of candidates) if (byId.has(hit.entry.entryId)) ranked.push(hit)
  return { results: ranked.slice(0, limit), expandedQueries, reranked: order.length > 0, rawRewrite, rawRerank }
}

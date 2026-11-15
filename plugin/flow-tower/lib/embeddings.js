/**
 * --- module contract ---
 * purpose: Optional OpenAI-compatible embedding provider and vector search.
 * dependsOn: [generated] lib/store.js, lib/text-index.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/tools/search.js, test/flow-tower.test.js, tools/embed.mjs
 * publicApi: [generated] cosineSimilarity, createEmbeddingProvider, embeddingSearch, localHashVector
 * risk: Medium: optional network dependency; must fail closed to lexical search.
 * --- end module contract ---
 */

import { tokenize } from './text-index.js'

const LOCAL_DIM = 384

function hashToken(token) {
  let hash = 2166136261
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * Deterministic hashed bag-of-tokens vector (offline bootstrap only).
 * @param {string} text
 * @returns {number[]}
 */
export function localHashVector(text) {
  const vector = new Array(LOCAL_DIM).fill(0)
  for (const token of tokenize(String(text ?? ''))) {
    const hash = hashToken(token)
    const sign = (hash & 1) === 0 ? 1 : -1
    vector[hash % LOCAL_DIM] += sign
  }
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
  }
  return vector
}

/**
 * @param {Record<string, any>} config
 * @returns {{ endpoint: string, model: string, embed: (texts: string[]) => Promise<number[][]> } | null}
 */
export function createEmbeddingProvider(config) {
  const endpoint = typeof config?.embeddingEndpoint === 'string' ? config.embeddingEndpoint.trim() : ''
  if (endpoint.length === 0) return null
  const model = typeof config?.embeddingModel === 'string' && config.embeddingModel.trim().length > 0
    ? config.embeddingModel.trim()
    : endpoint === 'local' ? `local-hash-${LOCAL_DIM}` : 'text-embedding-3-small'
  if (endpoint === 'local' || endpoint === 'local-hash') {
    return {
      endpoint,
      model,
      async embed(texts) {
        return texts.map((text) => localHashVector(text))
      },
    }
  }
  const apiKey = process.env.FLOW_TOWER_EMBEDDING_KEY ?? process.env.OPENAI_API_KEY ?? ''
  const timeoutMs = Number(config?.embeddingTimeoutMs ?? 15000)
  return {
    endpoint,
    model,
    async embed(texts) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 15000)
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ model, input: texts }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`embedding endpoint HTTP ${response.status}`)
        const payload = await response.json()
        const rows = Array.isArray(payload?.data) ? payload.data : []
        const vectors = rows.map((row) => row?.embedding)
        if (vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector) || vector.length === 0)) {
          throw new Error('embedding endpoint returned an unexpected shape')
        }
        return vectors
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * @param {number[]} left
 * @param {number[]} right
 * @returns {number}
 */
export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index])
    const b = Number(right[index])
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

/**
 * @param {import('./store.js').FlowStore} store
 * @param {string} query
 * @param {{ provider: any, volumeId?: string, project?: string, kind?: string, limit?: number }} options
 * @returns {Promise<{ entry: any, score: number, matched: string[] }[]>}
 */
export async function embeddingSearch(store, query, options) {
  if (options?.provider === null || options?.provider === undefined) return []
  const limit = Math.max(1, Math.min(50, Number(options.limit ?? 15)))
  const [vector] = await options.provider.embed([query])
  if (!Array.isArray(vector)) return []
  const rows = store.listEntryVectors({
    ...(options.volumeId === undefined ? {} : { volumeId: options.volumeId }),
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    limit: limit * 6,
  })
  const scored = []
  for (const row of rows) {
    const score = cosineSimilarity(vector, row.vector)
    if (score > 0) scored.push({ entry: row.entry, score: Number(score.toFixed(4)), matched: ['embedding'] })
  }
  scored.sort((left, right) => right.score - left.score)
  return scored.slice(0, limit)
}

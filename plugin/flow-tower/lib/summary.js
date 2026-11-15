/**
 * --- module contract ---
 * purpose: Three-level summary tree build and rendering from entries/citations.
 * dependsOn: [generated] lib/store.js, lib/util.js
 * externalDeps: [generated] node:crypto
 * usedBy: [generated] lib/compiler.js, lib/tools/browse.js, lib/web-read.js, test/flow-tower.test.js
 * publicApi: [generated] CATEGORIES, rebuildSummaryTree, summaryTreeText
 * risk: Medium: summary nodes are searchable durable state.
 * --- end module contract ---
 */

import { createHash } from 'node:crypto'
import { stableId } from './util.js'

/** Category buckets used for the middle layer. */
export const CATEGORIES = Object.freeze([
  {
    key: 'code',
    label: '[category] code',
    kinds: ['file', 'api-symbol'],
  },
  {
    key: 'memory',
    label: '[category] memory',
    kinds: ['feature', 'decision', 'task'],
  },
  {
    key: 'narrative',
    label: '[category] narrative',
    kinds: ['chapter', 'person'],
  },
  {
    key: 'diagnostics',
    label: '[category] diagnostics',
    kinds: ['error', 'command', 'topic'],
  },
])

/**
 * @param {string[]} headwords
 * @param {number} [max]
 * @returns {string}
 */
function topHeadwords(headwords, max = 10) {
  return headwords.slice(0, max).join(' · ')
}

/**
 * Build a deterministic extractive summary from the group's citation excerpts:
 * pick the sentences that best cover the group's headwords (no LLM).
 * @param {import('./store.js').FlowStore} store
 * @param {any[]} entries
 * @param {number} [maxChars]
 * @returns {{ text: string, citations: string[] }}
 */
function extractiveSummary(store, entries, maxChars = 140) {
  const keywords = new Set()
  for (const entry of entries.slice(0, 12)) {
    for (const token of String(entry.headword ?? '').replaceAll(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/)) {
      if (token.length >= 2) keywords.add(token)
    }
  }
  const candidates = []
  for (const entry of entries.slice(0, 8)) {
    for (const citation of store.citationsFor(entry.entryId).slice(0, 2)) {
      for (const sentence of String(citation.excerpt ?? '').split(/[。！？!?\n]+/)) {
        const text = sentence.replace(/\s+/g, ' ').trim()
        if (text.length < 6 || text.length > 120) continue
        let hits = 0
        for (const token of keywords) if (text.includes(token)) hits += 1
        candidates.push({ text, score: hits * 2 + Math.min(4, Math.floor(text.length / 30)), citeId: citation.citeId })
      }
    }
  }
  candidates.sort((left, right) => right.score - left.score)
  const picked = []
  const citations = []
  let length = 0
  for (const candidate of candidates) {
    if (picked.some((item) => item.includes(candidate.text) || candidate.text.includes(item))) continue
    if (length + candidate.text.length > maxChars) break
    picked.push(candidate.text)
    if (candidate.citeId) citations.push(candidate.citeId)
    length += candidate.text.length + 2
    if (picked.length >= 2) break
  }
  return { text: picked.join(' / '), citations }
}

/**
 * Rebuild the summary tree for one volume.
 * @param {import('./store.js').FlowStore} store
 * @param {string} volumeId
 * @param {{ summaryGenerator?: (input: { label: string, headwords: string[], size: number }) => string | null }} [options]
 * @returns {{ nodes: number, levels: number }}
 */
export function rebuildSummaryTree(store, volumeId, options = {}) {
  const volume = store.getVolume(volumeId)
  if (volume === null) return { nodes: 0, levels: 0 }
  const previous = new Map(store.listSummaryNodes(volumeId).map((node) => [node.nodeId, node]))
  store.replaceSummaryNodes(volumeId, [])
  const entries = store.listEntries(volumeId, { limit: 5000 })
  const byKind = new Map()
  for (const entry of entries) {
    const list = byKind.get(entry.kind) ?? []
    list.push(entry)
    byKind.set(entry.kind, list)
  }

  /** @type {{ nodeId: string, parentId: string | null, level: number, label: string, summary: string, size: number }[]} */
  const nodes = []
  const rootId = `sum_${stableId(`${volumeId}\u0000summary-root`, 12)}`
  const allHeadwords = entries.map((entry) => entry.headword)
  const generate = typeof options.summaryGenerator === 'function' ? options.summaryGenerator : null
  const rootSummary = generate?.({ label: 'volume', headwords: allHeadwords, size: entries.length })
    ?? topHeadwords(allHeadwords, 12)
  nodes.push({
    nodeId: rootId,
    parentId: null,
    level: 0,
    label: `[volume] ${volumeId}`,
    summary: rootSummary,
    size: volume.entryCount,
  })

  let levelCount = 1
  for (const category of CATEGORIES) {
    const categoryEntries = category.kinds.flatMap((kind) => byKind.get(kind) ?? [])
    if (categoryEntries.length === 0) continue
    const headwords = categoryEntries.map((entry) => entry.headword)
    const categoryId = `sum_${stableId(`${volumeId}\u0000${category.key}`, 12)}`
    nodes.push({
      nodeId: categoryId,
      parentId: rootId,
      level: 1,
      label: category.label,
      summary: generate?.({ label: category.label, headwords, size: categoryEntries.length })
        ?? topHeadwords(headwords, 10),
      size: categoryEntries.length,
    })
    // Group nodes hang below the category they belong to.
    const groups = store.listGroups(volumeId, null).flatMap((root) => store.listGroups(volumeId, root.groupId))
    for (const group of groups) {
      const groupKinds = group.kind === 'module' ? ['file', 'api-symbol'] : [group.kind]
      if (!groupKinds.some((kind) => category.kinds.includes(kind))) continue
      const groupEntries = store.entriesInGroup(group.groupId, 1000)
      const groupHeadwords = groupEntries.map((entry) => entry.headword)
      const signature = createHash('sha1')
        .update(groupEntries.map((entry) => `${entry.entryId}:${entry.lastSeenAt}`).join('|'))
        .digest('hex')
        .slice(0, 16)
      const nodeId = `sum_${stableId(`${volumeId}\u0000group\u0000${group.groupId}`, 12)}`
      const cached = previous.get(nodeId)
      let summaryText
      let citations
      if (cached !== undefined && cached.signature === signature && cached.summary.length > 0) {
        summaryText = cached.summary
        citations = cached.citations ?? []
      } else {
        const extracted = extractiveSummary(store, groupEntries)
        summaryText = extracted.text.length > 0
          ? extracted.text
          : group.summary.length > 0 ? group.summary : topHeadwords(groupHeadwords, 8)
        citations = extracted.citations
      }
      nodes.push({
        nodeId,
        parentId: categoryId,
        level: 2,
        label: group.label,
        summary: summaryText,
        citations,
        signature,
        size: group.size,
      })
      levelCount = Math.max(levelCount, 3)
    }
  }
  if (nodes.length > 1) levelCount = Math.max(levelCount, 2)
  store.replaceSummaryNodes(volumeId, nodes)
  store.replaceSummaryTerms(volumeId, nodes)
  return { nodes: nodes.length, levels: levelCount }
}

/**
 * Render the summary tree for text tools.
 * @param {import('./store.js').FlowStore} store
 * @param {string} volumeId
 * @returns {string}
 */
export function summaryTreeText(store, volumeId) {
  const nodes = store.listSummaryNodes(volumeId)
  if (nodes.length === 0) return `Volume "${volumeId}" has no summary tree yet (compile more content).`
  const byParent = new Map()
  for (const node of nodes) {
    const key = node.parentId ?? ''
    const list = byParent.get(key) ?? []
    list.push(node)
    byParent.set(key, list)
  }
  const lines = ['# Summary tree']
  const visit = (parentId, depth) => {
    for (const node of byParent.get(parentId) ?? []) {
      lines.push(`${'  '.repeat(depth)}${node.label} (${node.size})`)
      if (node.summary.length > 0) lines.push(`${'  '.repeat(depth + 1)}summary: ${node.summary}`)
      if ((node.citations?.length ?? 0) > 0) lines.push(`${'  '.repeat(depth + 1)}citations: ${node.citations.length}`)
      visit(node.nodeId, depth + 1)
    }
  }
  visit('', 0)
  return lines.join('\n')
}

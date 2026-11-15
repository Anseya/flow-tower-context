/**
 * --- module contract ---
 * purpose: Headword normalization, IDs, tiering, aliases and candidate ingestion into the store.
 * dependsOn: [generated] lib/store.js, lib/util.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] eval/runtime-smoke.mjs, lib/brief.js, lib/catalog.js, lib/compiler.js, lib/digest.js, lib/maintenance.js, lib/proposals.js, test/compaction-storage.test.js, test/flow-tower.test.js, test/manager.test.js, tools/merge-projects.mjs
 * publicApi: [generated] MAX_RELATED, TASK_NOISE_RE, aliasesOf, citeIdFor, displayHeadword, entryIdFor, ingestCandidates, normHeadword, significantTokens, taskQuality, tierFor
 * risk: Medium: entry identity must stay stable across recompiles.
 * --- end module contract ---
 */

import { clampChars, clampTokens, normalizeWhitespace, redactSecrets, safeJsonParse, stableId } from './util.js'

/** Max related entries kept per entry (feature unit connectivity). */
export const MAX_RELATED = 5
/** Shared-token threshold for closing an open task with a completion statement. */
const TASK_CLOSURE_MIN_OVERLAP = 2

/**
 * Tokenize text into significant tokens for task-closure matching:
 * CJK bigrams plus ASCII words of length >= 3.
 * @param {string} text
 * @returns {Set<string>}
 */
export function significantTokens(text) {
  const tokens = new Set()
  const value = String(text ?? '')
  for (const run of value.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2))
  }
  for (const word of value.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []) tokens.add(word)
  return tokens
}

/**
 * Normalize a candidate headword into the lookup key of one volume.
 * @param {string} kind
 * @param {string} headword
 * @returns {string}
 */
export function normHeadword(kind, headword) {
  let value = normalizeWhitespace(headword).toLowerCase()
  if (kind === 'file' || kind === 'api-symbol') value = value.replaceAll('\\', '/').replace(/^\.\//, '')
  if (kind === 'command') value = value.replace(/^\$\s*/, '')
  value = value.replace(/[。；，,;:：、!?！？]+$/g, '')
  return value.slice(0, 120)
}

/**
 * Render a display headword (kept short enough for browse output).
 * @param {string} headword
 * @returns {string}
 */
export function displayHeadword(headword) {
  const value = normalizeWhitespace(headword)
  return value.length <= 80 ? value : `${value.slice(0, 79)}…`
}

/** Headword fragments produced by indexing harness/digest output, not work items. */
export const TASK_NOISE_RE = /(?:BROWSE\s*\[|focus\s*=|ctx\s*=|head\s*=|chars?\s*[:=]|estTokens|Open tasks\s*:|Project memory\s*:|Project map\b|Modules:\s*|Traverse:\s*|Latest:\s*|dict_browse|dict_lookup|dict_cite|\[active\s*·|\[flow-tower\]|<\/?flow-tower-dictionary>|^---|seq\s*=|^e_[0-9a-f]{6,}|^=====|^Open\s*:)/i

/**
 * Heuristic quality of an extracted task headword. `-1` means "not a usable
 * task": heading-only fragments, conditional prose, or dictionary/tool noise.
 * @param {any} entry
 * @returns {number}
 */
export function taskQuality(entry) {
  const head = normalizeWhitespace(entry?.headword)
  if (head.length < 6 || head.length > 120) return -1
  if (TASK_NOISE_RE.test(head)) return -1
  if (head.includes('…')) return -1
  if (/^(?:[一二三四五六七八九十百]+[、.．]|第[一二三四五六七八九十百]+[章节步])/u.test(head) && !/[\u4e00-\u9fa5]{4,}/u.test(head.slice(2))) return -1
  if (/^(?:[一二三四五六七八九十百]+[、.．]|\d+[.)、．])\s*(?:建议|下一步|结论|总结|建议的下一步|下一步建议)[：:\s]*\d*[.、]?$/u.test(head)) return -1
  if (/^(?:如果你|如果你选择|若你|假如你)/u.test(head)) return -1
  if (/^(?:建议|推荐|我建议)/u.test(head)) return -1
  if (/\s\d+[.、]?$/.test(head)) return -1
  let score = 0
  if (/[\u4e00-\u9fa5]/.test(head)) score += 2
  if (head.length >= 8 && head.length <= 60) score += 2
  if (!/^[`\d]|^md\)|\\{1,2}/.test(head)) score += 1
  if (entry?.module) score += 1
  if (entry?.status === 'open') score += 1
  if (/(?:做|加|实现|修|改|跑|测|验证|补|写|删|移|重构|优化|检查|清理|合并|拆分|迁移|升级|接入|支持|确保|完成|提交|更新|扩|统一|补齐|替换|落地|排查|压测|回归|add|fix|implement|test|verify|write|update|remove|refactor|migrate|clean|check|ensure|support|build|ship|measure)/i.test(head)) score += 2
  return score
}

/**
 * Classify the age tier of an entry from its last-seen timestamp.
 * @param {number} updatedAt
 * @param {number} now
 * @param {{ tierHotDays?: number, tierWarmDays?: number }} config
 * @returns {'hot' | 'warm' | 'cold'}
 */
export function tierFor(updatedAt, now, config) {
  const hotDays = config.tierHotDays ?? 3
  const warmDays = config.tierWarmDays ?? 14
  const ageDays = Math.max(0, (now - updatedAt) / 86_400_000)
  if (ageDays <= hotDays) return 'hot'
  if (ageDays <= warmDays) return 'warm'
  return 'cold'
}

/**
 * Deterministic entry identity, stable across recompiles.
 * @param {string} volumeId
 * @param {string} headwordNorm
 * @returns {string}
 */
export function entryIdFor(volumeId, headwordNorm) {
  return `e_${stableId(`${volumeId}\u0000${headwordNorm}`, 14)}`
}

/**
 * Deterministic citation identity, stable across recompiles.
 * @param {string} entryId
 * @param {string} sessionId
 * @param {number} seq
 * @returns {string}
 */
export function citeIdFor(entryId, sessionId, seq) {
  return `c_${stableId(`${entryId}\u0000${sessionId}\u0000${seq}`, 10)}`
}

/**
 * Merge extracted candidates into the volume vocabulary inside one transaction.
 *
 * @param {import('./store.js').FlowStore} store
 * @param {{
 *   volumeId: string,
 *   sessionId: string,
 *   candidates: readonly { kind: string, headword: string, gloss: string, seq: number,
 *     time?: number, module?: string, status?: string }[],
 *   now: number,
 *   config: { glossTokens: number, maxEntries: number, maxCitationsPerEntry: number,
 *     maxCiteExcerptChars: number },
 * }} input
 * @returns {{ created: number, updated: number, skipped: number, citations: number,
 *   tasksOpened: number, tasksDone: number, tasksClosed: number, evicted: number,
 *   rejectedReason?: string }}
 */
export function ingestCandidates(store, input) {
  const { volumeId, sessionId, candidates, now, config } = input
  const stats = {
    created: 0,
    updated: 0,
    skipped: 0,
    citations: 0,
    tasksOpened: 0,
    tasksDone: 0,
    tasksClosed: 0,
    evicted: 0,
    /** Entry ids created/updated in this batch (for incremental relation sync). */
    entryIds: [],
  }
  const seen = new Set()
  const examples = []
  /** @type {Map<string, string>} norm -> entryId */
  const touched = new Map()
  /** @type {Map<number, string[]>} seq -> entryIds (for feature/related units) */
  const coOccurrence = new Map()

  const remember = (candidate, norm, entryId) => {
    touched.set(norm, entryId)
    const group = coOccurrence.get(candidate.seq) ?? []
    if (!group.includes(entryId)) group.push(entryId)
    coOccurrence.set(candidate.seq, group)
  }

  store.transaction(() => {
    for (const candidate of candidates) {
      const norm = normHeadword(candidate.kind, candidate.headword)
      if (norm.length < 2) {
        stats.skipped += 1
        continue
      }
      if (seen.has(norm)) {
        stats.skipped += 1
        continue
      }
      seen.add(norm)

      const existing = store.findEntryByWord(volumeId, norm)
      if (existing !== null) {
        const changed = attachCitation(store, existing, candidate, sessionId, now, config, stats)
        if (changed) {
          stats.updated += 1
          stats.entryIds.push(existing.entryId)
        }
        remember(candidate, norm, existing.entryId)
        continue
      }

      if (store.countEntries(volumeId) >= config.maxEntries) {
        // Rolling retention: drop a cold low-priority entry to make room.
        const evicted = store.evictOne(volumeId)
        if (evicted !== null) {
          stats.evicted += 1
        } else {
          stats.skipped += 1
          if (examples.length < 5) examples.push(norm)
          continue
        }
      }

      const gloss = clampTokens(redactSecrets(candidate.gloss), config.glossTokens)
      const seenAt = candidate.time ?? now
      const entry = {
        entryId: entryIdFor(volumeId, norm),
        volumeId,
        kind: candidate.kind,
        headword: candidate.headword,
        headwordNorm: norm,
        aliases: [],
        gloss,
        senses: [{ text: gloss }],
        related: [],
        module: candidate.module ?? '',
        status: candidate.kind === 'task' ? (candidate.status ?? 'open') : '',
        statusSeq: candidate.kind === 'task' ? candidate.seq : -1,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        tier: 'hot',
        createdAt: now,
        updatedAt: now,
      }
      store.insertEntry(entry)
      stats.created += 1
      stats.entryIds.push(entry.entryId)
      if (entry.kind === 'task') {
        if (entry.status === 'done') stats.tasksDone += 1
        else stats.tasksOpened += 1
      }
      attachCitation(store, entry, candidate, sessionId, now, config, stats)
      remember(candidate, norm, entry.entryId)
    }

    linkCoOccurrences(store, coOccurrence, now)
    closeCompletedTasks(store, volumeId, candidates, now, stats)
    store.addEntryCount(volumeId, stats.created, now)
  })

  if (examples.length > 0) stats.rejectedReason = `maxEntries reached; skipped e.g. ${examples.join(', ')}`
  return stats
}

/**
 * Task closure: a completion statement closes an open task that shares enough
 * significant tokens (e.g. "任务已完成：修复时间轴排序" closes "TODO 修复时间轴").
 * @param {import('./store.js').FlowStore} store
 * @param {string} volumeId
 * @param {readonly any[]} candidates
 * @param {number} now
 * @param {{ tasksClosed: number }} stats
 */
function closeCompletedTasks(store, volumeId, candidates, now, stats) {
  const doneCandidates = candidates.filter((candidate) => candidate.kind === 'task' && candidate.status === 'done')
  if (doneCandidates.length === 0) return
  const openEntries = store.openTasks(volumeId, 100)
  if (openEntries.length === 0) return
  for (const done of doneCandidates) {
    const doneTokens = significantTokens(`${done.headword} ${done.gloss}`)
    if (doneTokens.size === 0) continue
    for (const openEntry of openEntries) {
      if (openEntry.status !== 'open') continue
      const openTokens = significantTokens(openEntry.headword)
      let overlap = 0
      for (const token of openTokens) {
        if (doneTokens.has(token)) overlap += 1
        if (overlap >= TASK_CLOSURE_MIN_OVERLAP) break
      }
      if (overlap < TASK_CLOSURE_MIN_OVERLAP) continue
      store.updateEntry(openEntry.entryId, { status: 'done', statusSeq: done.seq }, now)
      openEntry.status = 'done'
      stats.tasksClosed += 1
    }
  }
}

/**
 * Link entries that appeared in the same message (feature ↔ file ↔ decision).
 * @param {import('./store.js').FlowStore} store
 * @param {Map<number, string[]>} groups
 * @param {number} now
 */
function linkCoOccurrences(store, groups, now) {
  for (const entryIds of groups.values()) {
    if (entryIds.length < 2) continue
    for (const entryId of entryIds) {
      const entry = store.getEntry(entryId)
      if (entry === null) continue
      const related = Array.isArray(entry.related) ? [...entry.related] : []
      for (const other of entryIds) {
        if (other === entryId || related.includes(other)) continue
        if (related.length >= MAX_RELATED) break
        related.push(other)
      }
      if (related.length !== (entry.related?.length ?? 0)) {
        store.updateEntry(entryId, { related }, now)
      }
    }
  }
}

/**
 * Attach one citation and update time/module/status dimensions on an entry.
 * @returns {boolean} whether anything changed
 */
function attachCitation(store, entry, candidate, sessionId, now, config, stats) {
  let changed = false
  const eventTime = candidate.time ?? now
  const count = store.citationCount(entry.entryId)
  if (count < config.maxCitationsPerEntry) {
    const inserted = store.insertCitation({
      citeId: citeIdFor(entry.entryId, sessionId, candidate.seq),
      entryId: entry.entryId,
      sessionId,
      seqStart: candidate.seq,
      seqEnd: candidate.seq,
      eventTime,
      excerpt: clampChars(redactSecrets(candidate.gloss), config.maxCiteExcerptChars ?? 200),
      createdAt: now,
    })
    if (inserted) {
      stats.citations += 1
      changed = true
    }
  }

  const patch = {}
  const firstSeenAt = eventTime > 0 ? Math.min(entry.firstSeenAt || eventTime, eventTime) : entry.firstSeenAt
  const lastSeenAt = Math.max(entry.lastSeenAt ?? 0, eventTime)
  if (firstSeenAt !== entry.firstSeenAt) patch.firstSeenAt = firstSeenAt
  if (lastSeenAt !== entry.lastSeenAt) patch.lastSeenAt = lastSeenAt

  if (entry.module === '' && typeof candidate.module === 'string' && candidate.module.length > 0) {
    patch.module = candidate.module
  }

  // Task status is monotone by seq: the newest statement wins.
  if (entry.kind === 'task' && typeof candidate.status === 'string' && candidate.status.length > 0) {
    if (candidate.seq >= (entry.statusSeq ?? -1) && candidate.status !== entry.status) {
      patch.status = candidate.status
      patch.statusSeq = candidate.seq
      if (candidate.status === 'done') stats.tasksDone += 1
      else stats.tasksOpened += 1
    }
  }

  const nextGloss = clampTokens(redactSecrets(candidate.gloss), config.glossTokens)
  if (nextGloss.length > 0 && nextGloss.length > (entry.gloss?.length ?? 0)) {
    const senses = Array.isArray(entry.senses) && entry.senses.length > 0
      ? entry.senses
      : [{ text: nextGloss }]
    senses[0] = { ...(senses[0] ?? {}), text: nextGloss }
    patch.gloss = nextGloss
    patch.senses = senses
  }

  patch.tier = 'hot'
  store.updateEntry(entry.entryId, patch, now)
  return changed || Object.keys(patch).length > 1
}

/**
 * Read one entry's aliases safely.
 * @param {any} entry
 * @returns {string[]}
 */
export function aliasesOf(entry) {
  const raw = entry?.aliases
  if (Array.isArray(raw)) return raw
  const parsed = safeJsonParse(raw, [])
  return Array.isArray(parsed) ? parsed : []
}

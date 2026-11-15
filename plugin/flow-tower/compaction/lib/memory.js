/**
 * --- module contract ---
 * purpose: Read-only project memory block for the compaction summarizer, ranked/filtered and project-scoped.
 * dependsOn: [generated] compaction/lib/storage.js
 * externalDeps: [generated] node:fs, node:sqlite
 * usedBy: [generated] compaction/index.js, test/compaction-storage.test.js
 * publicApi: [generated] entryScore, loadProjectMemory, taskScore
 * risk: Medium: prompt content quality and storage path resolution; reads only, no writes.
 * --- end module contract ---
 */

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { readStorageConfig, resolveDbPath, resolveSummaryMemoryChars } from './storage.js'

const DEFAULT_MAX_CHARS = 1800
const OPEN_TASKS = 8
const OTHER_ENTRIES = 20

/** Headword fragments produced by indexing harness/digest/tool output. */
const NOISE_RE = /(?:BROWSE\s*\[|focus\s*=|ctx\s*=|head\s*=|chars\s*=|Open tasks\s*:|Project memory\s*:|Use dict_|\[flow-tower\])/i
/** List-heading-only fragments such as "五、下一步建议 1." */
const HEADING_ONLY_RE = /^(?:[一二三四五六七八九十百]+[、.．]|\d+[.)、．])\s*(?:建议|下一步|结论|总结|建议的下一步|下一步建议)[：:\s]*\d*[.、]?$/u
/** Conditional/option prose that is not an actionable item. */
const CONDITIONAL_RE = /^(?:如果你|如果你选择|若你|假如你)/u
/** Any leading numbered heading, even when a fragment follows. */
const LIST_PREFIX_RE = /^(?:[一二三四五六七八九十百]+[、.．]|\d+[.)、．])\s*/u
/** Numbered source-line dumps (`39: * "..."`) are excerpts, not memory units. */
const LINE_DUMP_RE = /(?:^|\s)\d+\s*[:：]\s|\b\d+\s*[+*]\s+["“']|\b\d+\s+[+*]\s/
/** Paths outside the workspace are not project memory. */
const EXTERNAL_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|var|etc|opt|usr|Program)\b)/
/** English/Chinese action verbs that make a short headword look actionable. */
const ACTION_RE = /(?:做|加|实现|修|改|跑|测|验证|补|写|删|移|重构|优化|检查|清理|合并|拆分|迁移|升级|接入|支持|确保|完成|提交|更新|扩|统一|补齐|替换|落地|排查|压测|回归|add|fix|implement|test|verify|write|update|remove|refactor|migrate|clean|check|ensure|support|build|ship|measure)/i

/**
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * Keep section newlines while honoring the overall character budget.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  const cut = value.slice(0, max - 1)
  const lineBreak = cut.lastIndexOf('\n')
  const space = cut.lastIndexOf(' ')
  const at = Math.max(lineBreak, space)
  const body = at > Math.floor(max * 0.6) ? cut.slice(0, at) : cut
  return `${body.trimEnd()}…`
}

/**
 * Reject dictionary/harness noise before it can consume a memory slot.
 * @param {string} head
 * @returns {boolean}
 */
function isNoise(head) {
  return NOISE_RE.test(head)
    || HEADING_ONLY_RE.test(head)
    || CONDITIONAL_RE.test(head)
    || LIST_PREFIX_RE.test(head)
    || />\s*$/.test(head)
    || /```/.test(head)
    || (head.match(/`/g)?.length ?? 0) % 2 === 1
    || /(?:^|[\s;(])import\s*\{|from\s+['"][^'"]+['"]\s*$/.test(head)
}

/**
 * Code/error excerpts routinely start with these prefixes and are poor
 * "project memory" lines even though they are long enough to pass a length
 * filter.
 * @param {string} head
 * @returns {boolean}
 */
function looksLikeCode(head) {
  return /^(?:error'|js'|import\s|export\s|const\s|function\s|if\s*\(|for\s*\(|\{|\}|\/\/|\*\/>?)/.test(head)
    || /\\n/.test(head)
    || /=>/.test(head)
}

/**
 * Score an open task; negative means "not a usable task".
 * @param {any} row
 * @returns {number}
 */
export function taskScore(row) {
  const head = String(row?.headword ?? '').replace(/\s+/g, ' ').trim()
  if (head.length < 6 || head.length > 120) return -1
  if (isNoise(head) || looksLikeCode(head)) return -1
  if (LINE_DUMP_RE.test(head)) return -1
  if (EXTERNAL_PATH_RE.test(head)) return -1
  if (!/[\p{L}\p{N}]/u.test(head)) return -1
  // A bare trailing list marker ("... 1.") is a truncation artifact.
  if (/\s\d+[.、]?$/.test(head)) return -1
  let score = 0
  if (/[\u4e00-\u9fa5]/.test(head)) score += 2
  if (head.length >= 8 && head.length <= 60) score += 2
  if (!/^[`\d]|^md\)|\\{1,2}/.test(head)) score += 1
  if (row?.module) score += 1
  if (row?.status === 'open') score += 1
  if (ACTION_RE.test(head)) score += 2
  return score
}

/**
 * Score one project-memory entry (decisions/errors/features first).
 * @param {any} row
 * @returns {number}
 */
export function entryScore(row) {
  const head = String(row?.headword ?? '').replace(/\s+/g, ' ').trim()
  const gloss = String(row?.gloss ?? '').replace(/\s+/g, ' ').trim()
  if (head.length < 4 || head.length > 160) return -1
  if (isNoise(head) || isNoise(gloss)) return -1
  if (looksLikeCode(head) || looksLikeCode(gloss)) return -1
  if (LINE_DUMP_RE.test(head) || LINE_DUMP_RE.test(gloss)) return -1
  if (EXTERNAL_PATH_RE.test(head)) return -1
  if (!/[\p{L}\p{N}]/u.test(head)) return -1
  const weights = { decision: 4, error: 4, feature: 3, 'api-symbol': 2, command: 2, file: 1, topic: 0, chapter: 0 }
  let score = weights[row?.kind] ?? 0
  if (row?.module) score += 1
  if (gloss.length >= 20) score += 1
  return score
}

/** @param {string} head @returns {string} */
function dedupeKey(head) {
  return head.toLowerCase().replace(/[\s`*_~#"'\u3000]+/g, '')
}

/**
 * @param {string} project project root
 * @param {number} [maxChars]
 * @returns {string} prompt-ready memory block, or '' when unavailable
 */
export function loadProjectMemory(project, maxChars = resolveSummaryMemoryChars(readStorageConfig())) {
  if (typeof project !== 'string' || project.trim().length === 0) return ''
  const config = readStorageConfig()
  const dbPath = resolveDbPath(config, project)
  if (!existsSync(dbPath)) return ''
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    // Global/custom storage can hold several projects; scope the memory to the
    // session's project so one workspace never sees another's tasks.
    const projectKey = String(project).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
    const scope = projectKey.length > 0
      ? "AND LOWER(REPLACE(v.project, char(92), '/')) = ?"
      : ''
    const scopeParams = projectKey.length > 0 ? [projectKey] : []
    const taskRows = db.prepare(`
      SELECT e.kind, e.headword, e.gloss, e.module, e.status, e.last_seen_at AS lastSeenAt
      FROM entries e JOIN volumes v ON v.volume_id = e.volume_id
      WHERE e.superseded_by IS NULL AND e.kind = 'task' AND e.status = 'open' ${scope}
      ORDER BY e.last_seen_at DESC LIMIT 80
    `).all(...scopeParams)
    const entryRows = db.prepare(`
      SELECT e.kind, e.headword, e.gloss, e.module, e.status, e.last_seen_at AS lastSeenAt
      FROM entries e JOIN volumes v ON v.volume_id = e.volume_id
      WHERE e.superseded_by IS NULL AND e.kind <> 'task'
        AND e.kind IN ('decision','file','feature','api-symbol','error','command','topic','chapter') ${scope}
      ORDER BY e.last_seen_at DESC LIMIT 80
    `).all(...scopeParams)

    const seen = new Set()
    const tasks = taskRows
      .map((row) => ({ row, score: taskScore(row) }))
      .filter((item) => item.score >= 0)
      .sort((left, right) => (right.score - left.score) || (Number(right.row.lastSeenAt ?? 0) - Number(left.row.lastSeenAt ?? 0)))
      .filter((item) => {
        const key = dedupeKey(String(item.row.headword ?? ''))
        if (key.length === 0 || seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, OPEN_TASKS)
      .map((item) => item.row)

    const entries = entryRows
      .map((row) => ({ row, score: entryScore(row) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => (right.score - left.score) || (Number(right.row.lastSeenAt ?? 0) - Number(left.row.lastSeenAt ?? 0)))
      .filter((item) => {
        const key = `${item.row.kind}\u0000${dedupeKey(String(item.row.headword ?? ''))}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, OTHER_ENTRIES)
      .map((item) => item.row)

    const lines = []
    if (tasks.length > 0) {
      lines.push('Open tasks:')
      for (const row of tasks) {
        lines.push(`- ${clip(row.headword, 160)}${row.module ? ` [${row.module}]` : ''}`)
      }
    }
    if (entries.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push('Project memory (decisions/files/features/errors):')
      for (const row of entries) {
        lines.push(`- ${row.kind}: ${clip(row.headword, 140)}${row.module ? ` [${row.module}]` : ''}${row.gloss ? ` — ${clip(row.gloss, 180)}` : ''}`)
      }
    }
    if (lines.length === 0) return ''
    const text = lines.join('\n')
    const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS
    return truncate(text, Math.max(300, Math.min(8000, budget)))
  } catch {
    return ''
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

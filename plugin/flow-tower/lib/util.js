/**
 * --- module contract ---
 * purpose: Shared pure utilities: path normalization, token estimation, text/secret helpers.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] node:crypto
 * usedBy: [generated] eval/context-cost.mjs, eval/long-session-eval.mjs, eval/multi-session-stats.mjs, eval/offline-eval.mjs, eval/real-session-eval.mjs, eval/runtime-smoke.mjs, eval/shadow-report.mjs, eval/txt-corpus-eval.mjs, index.js, lib/brief.js, lib/catalog.js, lib/compiler-samples.js, lib/compiler.js, lib/digest.js, lib/extract.js, lib/injection-policy.js, lib/manager.js, lib/project-policy.js, lib/proposals.js, lib/raw.js, lib/relations-view.js, lib/relations.js, lib/session-read.js, lib/store-schema.js, lib/store.js, lib/summary.js, lib/tools/common.js, lib/tools/dev.js, lib/topics.js, lib/vocabulary.js, test/flow-tower.test.js, test/manager.test.js, tools/clean-noise.mjs, tools/embed.mjs, tools/export-data.mjs, tools/import-data.mjs, tools/mcp-server.mjs, tools/merge-projects.mjs, tools/relations.mjs
 * publicApi: [generated] clampChars, clampTokens, contentToText, estimateTokens, formatClock, formatStamp, normalizeProjectPath, normalizeWhitespace, redactSecrets, retryBusy, safeJsonParse, stableId
 * risk: Low: pure functions; touched by most modules, so keep behavior stable.
 * --- end module contract ---
 */

import { createHash } from 'node:crypto'

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/g

/**
 * Rough token estimate that is good enough for budget clamping.
 * CJK characters count as one token each; other characters as one quarter.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  const cjk = (text.match(CJK_RE) ?? []).length
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

/**
 * Collapse all whitespace runs into one space and trim.
 * @param {string} text
 * @returns {string}
 */
export function normalizeWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Clamp text to an approximate token budget, appending an ellipsis when cut.
 * @param {string} text
 * @param {number} maxTokens
 * @param {string} [suffix]
 * @returns {string}
 */
export function clampTokens(text, maxTokens, suffix = '…') {
  const value = String(text ?? '')
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return ''
  if (estimateTokens(value) <= maxTokens) return value
  // Binary search the longest prefix that fits the budget.
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimateTokens(value.slice(0, mid) + suffix) <= maxTokens) low = mid
    else high = mid - 1
  }
  return value.slice(0, low) + suffix
}

/**
 * Clamp text to a character budget.
 * @param {string} text
 * @param {number} maxChars
 * @param {string} [suffix]
 * @returns {string}
 */
export function clampChars(text, maxChars, suffix = '…') {
  const value = String(text ?? '')
  if (!Number.isFinite(maxChars) || maxChars <= 0) return ''
  if (value.length <= maxChars) return value
  return value.slice(0, maxChars) + suffix
}

/**
 * Stable short id derived from a seed string.
 * @param {string} seed
 * @param {number} [length]
 * @returns {string}
 */
export function stableId(seed, length = 12) {
  return createHash('sha1').update(String(seed)).digest('hex').slice(0, length)
}

/**
 * Parse JSON with a fallback instead of throwing.
 * @template T
 * @param {string} text
 * @param {T} fallback
 * @returns {T | unknown}
 */
export function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * Extract plain text from a DSH content-block array.
 * Non-text blocks become short placeholders so citations stay readable.
 * @param {readonly any[]} content
 * @returns {string}
 */
export function contentToText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
        break
      case 'tool-call': {
        const name = typeof block.name === 'string' ? block.name : 'tool'
        const args = typeof block.arguments === 'string' ? block.arguments : ''
        parts.push(`[tool-call ${name}${args.length > 0 ? ` ${args.slice(0, 160)}` : ''}]`)
        break
      }
      case 'image':
        parts.push('[image]')
        break
      case 'file':
        parts.push('[file]')
        break
      case 'reasoning':
        break
      default:
        break
    }
  }
  return normalizeWhitespace(parts.join('\n'))
}

/**
 * Format an epoch-millisecond timestamp as a short local wall clock.
 * @param {number | undefined} ms
 * @returns {string}
 */
export function formatClock(ms) {
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Format an epoch-millisecond timestamp as a short local date-time.
 * @param {number | undefined} ms
 * @returns {string}
 */
export function formatStamp(ms) {
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Normalize a project root path into a stable key.
 * Uses forward slashes, lower-cases the Windows drive letter, strips trailing
 * slashes; returns '' for empty/relative inputs.
 * @param {string | undefined | null} cwd
 * @returns {string}
 */
export function normalizeProjectPath(cwd) {
  const value = String(cwd ?? '').trim().replaceAll('\\', '/')
  if (value.length === 0) return ''
  // Accept only absolute paths (Windows drive or POSIX root).
  if (!/^[A-Za-z]:\//.test(value) && !value.startsWith('/')) return ''
  return value.replace(/\/+$/, '').replace(/^([A-Za-z]):/, (_match, drive) => `${String(drive).toLowerCase()}:`)
}

const SECRET_PATTERNS = [
  // Common API keys/tokens. Order matters: longest prefixes first.
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
]

/**
 * Redact likely secrets before persisting short excerpts. The raw session log
 * remains the verbatim source of truth (dict_cite); only plugin-owned copies
 * are masked.
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let value = String(text ?? '')
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, '[redacted]')
  }
  return value
}

/**
 * Retry a synchronous SQLite operation when another connection holds the write
 * lock. Multi-instance use is still discouraged; this only softens brief
 * contention (WAL + busy_timeout do the rest).
 * @template T
 * @param {() => T} fn
 * @param {{ attempts?: number, delayMs?: number }} [options]
 * @returns {T}
 */
export function retryBusy(fn, options = {}) {
  const attempts = Math.max(1, options.attempts ?? 5)
  const delayMs = Math.max(1, options.delayMs ?? 20)
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return fn()
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (!/SQLITE_BUSY|database is locked|SQLITE_LOCKED/i.test(message)) throw error
      if (attempt + 1 < attempts) {
        const until = Date.now() + delayMs * (attempt + 1)
        while (Date.now() < until) {
          // Short synchronous back-off (node:sqlite is synchronous).
        }
      }
    }
  }
  throw lastError
}

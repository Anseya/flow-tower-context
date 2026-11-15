/**
 * --- module contract ---
 * purpose: Citation seq helpers and bounded raw-message replay.
 * dependsOn: [generated] lib/util.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/tools/cite.js, test/flow-tower.test.js
 * publicApi: [generated] citationSeqs, renderSeqLine, renderSeqRange
 * risk: Low-medium: replay is the evidence path; must degrade when a session log is unavailable.
 * --- end module contract ---
 */

import { contentToText, formatClock } from './util.js'

/**
 * Render one seq as a `[#seq role HH:MM] text` line from a live Session.
 * Compatibility fallback for compositions without `ctx.sessionQuery`.
 * @param {any} session live Session (has `eventAt` and `deriveEventMessage`)
 * @param {number} seq
 * @returns {{ seq: number, role: string, time: number, text: string } | null}
 */
export function renderSeqLine(session, seq) {
  try {
    const event = session?.eventAt?.(seq)
    if (event === undefined || event === null) return null
    const message = session.deriveEventMessage(event)
    if (message === null || message === undefined) return null
    const text = contentToText(message.content)
    if (text.length === 0) return null
    const role = String(message.role ?? 'unknown')
    const time = typeof event.time === 'number' ? event.time : undefined
    const clock = Number.isFinite(time) ? formatClock(time) : ''
    return {
      seq,
      role,
      time: time ?? 0,
      text: `[#${seq} ${role}${clock.length > 0 ? ` ${clock}` : ''}] ${text}`,
    }
  } catch {
    return null
  }
}

/**
 * Render a sparse seq range from a live Session.
 * @param {any} session
 * @param {readonly number[]} seqs
 * @param {{ maxTokens?: number }} [options]
 * @returns {{ text: string, count: number, missing: number, truncated: boolean }}
 */
export function renderSeqRange(session, seqs, options = {}) {
  const maxTokens = options.maxTokens ?? 12_000
  const lines = []
  let usedTokens = 0
  let count = 0
  let missing = 0
  let truncated = false

  for (const seq of seqs) {
    const line = renderSeqLine(session, seq)
    if (line === null) {
      missing += 1
      continue
    }
    const tokens = Math.ceil(line.text.length / 4) + 8
    if (usedTokens + tokens > maxTokens) {
      truncated = true
      break
    }
    usedTokens += tokens
    count += 1
    lines.push(line.text)
  }

  if (truncated) lines.push(`… [truncated at ${maxTokens} tokens; more seqs available]`)
  return { text: lines.join('\n'), count, missing, truncated }
}

/**
 * Expand one citation into its seq list.
 * @param {{ seqStart: number, seqEnd: number }} citation
 * @returns {number[]}
 */
export function citationSeqs(citation) {
  const start = Number(citation?.seqStart)
  const end = Number(citation?.seqEnd)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return []
  const out = []
  for (let seq = start; seq <= end && out.length < 500; seq += 1) out.push(seq)
  return out
}

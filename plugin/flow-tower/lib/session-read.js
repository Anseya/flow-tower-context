/**
 * --- module contract ---
 * purpose: Read/project session events through the sessionQuery seam with live-session fallback.
 * dependsOn: [generated] lib/util.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] eval/long-session-eval.mjs, eval/real-session-eval.mjs, eval/txt-corpus-eval.mjs, index.js, lib/compiler-samples.js, lib/tools/cite.js, lib/tools/dev.js, lib/web.js, test/flow-tower.test.js
 * publicApi: [generated] indexBySeq, projectEventMessage, readLiveEvents, readSessionEvents, renderEventLine, renderEvents, sampleFromEvents
 * risk: Medium: Host session API compatibility; deprecated fallback must remain contained here.
 * --- end module contract ---
 */

import { contentToText, formatClock } from './util.js'

/** Upper bound for one in-memory event snapshot built by the fallback path. */
const MAX_FALLBACK_EVENTS = 200_000

/**
 * Project one session event into its model-visible message, if any.
 * Mirrors the host's derivation for the event types this plugin cares about.
 * @param {any} event
 * @returns {any | null}
 */
export function projectEventMessage(event) {
  if (event === null || typeof event !== 'object') return null
  switch (event.type) {
    case 'user/message':
    case 'developer/message':
      return event.data ?? null
    case 'system/message':
      return event.data?.message ?? event.data ?? null
    case 'assistant/message':
      return event.data?.message ?? null
    case 'tool/result':
      return event.data?.message ?? null
    default:
      return null
  }
}

/**
 * Read one session's complete raw event log.
 * @param {any} ctx plugin context (needs `get('sessionQuery')` when available)
 * @param {string} sessionId
 * @param {any} [liveSession] live Session fallback
 * @returns {Promise<any[] | null>}
 */
export async function readSessionEvents(ctx, sessionId, liveSession) {
  const query = typeof ctx?.get === 'function'
    ? ctx.get('sessionQuery')
    : ctx?.sessionQuery
  if (query !== null && query !== undefined && typeof query.readSession === 'function') {
    try {
      const snapshot = await query.readSession(sessionId)
      const events = snapshot?.events
      if (Array.isArray(events)) return events
    } catch {
      // Fall through to the live-session fallback.
    }
  }
  return readLiveEvents(liveSession)
}

/**
 * Compatibility fallback: walk a live session's log through `eventAt`.
 * @param {any} liveSession
 * @returns {any[] | null}
 */
export function readLiveEvents(liveSession) {
  if (liveSession === null || liveSession === undefined || typeof liveSession.eventAt !== 'function') return null
  const events = []
  try {
    for (let seq = 0; seq < MAX_FALLBACK_EVENTS; seq += 1) {
      const event = liveSession.eventAt(seq)
      if (event === undefined || event === null) break
      events.push(event)
    }
  } catch {
    return null
  }
  return events.length > 0 ? events : null
}

/**
 * Index events by seq.
 * @param {readonly any[]} events
 * @returns {Map<number, any>}
 */
export function indexBySeq(events) {
  const map = new Map()
  for (const event of events) {
    if (Number.isSafeInteger(event?.seq)) map.set(event.seq, event)
  }
  return map
}

/**
 * Render one event as a `[#seq role HH:MM] text` line.
 * @param {any} event
 * @returns {string | null}
 */
export function renderEventLine(event) {
  const message = projectEventMessage(event)
  if (message === null) return null
  const text = contentToText(message.content)
  if (text.length === 0) return null
  const role = String(message.role ?? 'unknown')
  const clock = Number.isFinite(event.time) ? formatClock(event.time) : ''
  return `[#${event.seq} ${role}${clock.length > 0 ? ` ${clock}` : ''}] ${text}`
}

/**
 * Render a sparse seq range from an already-read event log.
 * @param {readonly any[]} events
 * @param {readonly number[]} seqs
 * @param {{ maxTokens?: number }} [options]
 * @returns {{ text: string, count: number, missing: number, truncated: boolean }}
 */
export function renderEvents(events, seqs, options = {}) {
  const maxTokens = options.maxTokens ?? 12_000
  const log = indexBySeq(events)
  const lines = []
  let usedTokens = 0
  let count = 0
  let missing = 0
  let truncated = false

  for (const seq of seqs) {
    const event = log.get(seq)
    if (event === undefined) {
      missing += 1
      continue
    }
    const line = renderEventLine(event)
    if (line === null) {
      missing += 1
      continue
    }
    const tokens = Math.ceil(line.length / 4) + 8
    if (usedTokens + tokens > maxTokens) {
      truncated = true
      break
    }
    usedTokens += tokens
    count += 1
    lines.push(line)
  }

  if (truncated) lines.push(`… [truncated at ${maxTokens} tokens; more seqs available]`)
  return { text: lines.join('\n'), count, missing, truncated }
}

/**
 * Extract readable text samples for compilation from raw events.
 * @param {readonly any[]} events
 * @param {readonly number[]} seqs
 * @param {{ maxChars?: number, filter?: (message: any) => boolean }} [options]
 * @returns {{ seq: number, role: string, text: string, time: number }[]}
 */
export function sampleFromEvents(events, seqs, options = {}) {
  const maxChars = options.maxChars ?? 6000
  const log = indexBySeq(events)
  const out = []
  for (const seq of seqs) {
    const event = log.get(seq)
    if (event === undefined) continue
    const message = projectEventMessage(event)
    if (message === null) continue
    const role = String(message.role ?? '')
    if (role === 'system' || role === 'developer') continue
    if (options.filter !== undefined && options.filter(message) !== true) continue
    const text = contentToText(message.content).slice(0, maxChars)
    if (text.trim().length < 2) continue
    out.push({
      seq,
      role,
      text,
      time: Number.isFinite(event.time) ? event.time : 0,
    })
  }
  return out
}

/**
 * --- module contract ---
 * purpose: Project raw session events into bounded text samples for extraction.
 * dependsOn: [generated] lib/session-read.js, lib/util.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/compiler.js
 * publicApi: [generated] MAX_SAMPLE_CHARS, sampleForSeq, samplesForDelta
 * risk: Low-medium: sample cap bounds compile cost; sessionQuery-first with live-session fallback.
 * --- end module contract ---
 */

import { sampleFromEvents } from './session-read.js'
import { contentToText } from './util.js'

export const MAX_SAMPLE_CHARS = 6000

/**
 * Build extraction samples for one delta, preferring the queried event log
 * (`sessionQuery`) and falling back to the live Session projection.
 * @param {{ readEvents?: (sessionId: string, liveSession: any) => Promise<any[] | null>, log: { warn: (message: string) => void }, shouldSample: (message: any) => boolean }} deps
 * @param {any} session
 * @param {readonly number[]} delta
 * @returns {Promise<{ seq: number, role: string, text: string, time: number }[]>}
 */
export async function samplesForDelta(deps, session, delta) {
  if (typeof deps.readEvents === 'function') {
    try {
      const events = await deps.readEvents(session.id, session)
      if (Array.isArray(events) && events.length > 0) {
        return sampleFromEvents(events, delta, {
          maxChars: MAX_SAMPLE_CHARS,
          filter: deps.shouldSample,
        })
      }
    } catch (error) {
      deps.log.warn(`session event query failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const samples = []
  for (const seq of delta) {
    const sample = sampleForSeq(session, seq, deps.shouldSample)
    if (sample !== null) samples.push(sample)
  }
  return samples
}

/**
 * Project one raw session event into an extraction sample (live fallback).
 * @param {any} session
 * @param {number} seq
 * @param {(message: any) => boolean} shouldSample
 * @returns {{ seq: number, role: string, text: string, time: number } | null}
 */
export function sampleForSeq(session, seq, shouldSample) {
  try {
    const event = session.eventAt(seq)
    if (event === undefined || event === null) return null
    const message = session.deriveEventMessage(event)
    if (message === null || message === undefined) return null
    const role = String(message.role ?? '')
    if (role === 'system' || role === 'developer') return null
    if (!shouldSample(message)) return null
    const text = contentToText(message.content).slice(0, MAX_SAMPLE_CHARS)
    if (text.trim().length < 2) return null
    return { seq, role, text, time: Number.isFinite(event.time) ? event.time : 0 }
  } catch {
    return null
  }
}

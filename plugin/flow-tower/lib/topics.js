/**
 * --- module contract ---
 * purpose: Deterministic TF-IDF topic entry extraction per compile round.
 * dependsOn: [generated] lib/text-index.js, lib/util.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/compiler.js
 * publicApi: [generated] extractTopics
 * risk: Low-medium: bounded by maxTopicsPerRound.
 * --- end module contract ---
 */

import { clampChars, normalizeWhitespace } from './util.js'
import { tokenize } from './text-index.js'

/** Function characters that make a CJK bigram a poor topic. */
const TOPIC_STOP_CHAR = /[的了着便就是不在有这那他她我你们个说问答笑怒冷沉声口知想要会把被让给对从到看听走跑站坐起回过来去上下前后里外手中]/i

/**
 * Extract topic candidates from text samples.
 * @param {readonly { seq: number, text: string, time?: number }[]} samples
 * @param {{ maxTopics?: number, minDf?: number, minTf?: number }} [options]
 * @returns {{ kind: 'topic', headword: string, gloss: string, seq: number, time: number }[]}
 */
export function extractTopics(samples, options = {}) {
  const maxTopics = options.maxTopics ?? 20
  const minDf = options.minDf ?? 2
  const minTf = options.minTf ?? 3
  const totalDocs = samples.length
  if (totalDocs === 0) return []

  /** @type {Map<string, { tf: number, df: number, firstSeq: number, firstTime: number, firstText: string }>} */
  const stats = new Map()
  for (const sample of samples) {
    const text = String(sample.text ?? '')
    if (text.length === 0) continue
    const seen = new Set()
    for (const token of tokenize(text)) {
      if (token.length < 2) continue
      const isCjk = /[\u4e00-\u9fa5]/.test(token)
      if (isCjk) {
        if (TOPIC_STOP_CHAR.test(token)) continue
      } else if (token.length < 4) {
        continue
      }
      const bucket = stats.get(token) ?? {
        tf: 0,
        df: 0,
        firstSeq: sample.seq,
        firstTime: Number.isFinite(sample.time) ? sample.time : 0,
        firstText: text,
      }
      bucket.tf += 1
      if (!seen.has(token)) {
        bucket.df += 1
        seen.add(token)
      }
      stats.set(token, bucket)
    }
  }

  const ranked = [...stats.entries()]
    .filter(([, info]) => info.df >= minDf && info.tf >= minTf)
    .map(([term, info]) => ({
      term,
      info,
      score: info.tf * Math.log(1 + totalDocs / (info.df + 1)),
    }))
    .sort((left, right) => right.score - left.score || left.term.localeCompare(right.term))
    .slice(0, maxTopics * 3)

  // Drop near-duplicate topics that are substrings of an already chosen term.
  const chosen = []
  for (const item of ranked) {
    if (chosen.length >= maxTopics) break
    if (chosen.some((existing) => existing.term.includes(item.term) || item.term.includes(existing.term))) continue
    chosen.push(item)
  }

  return chosen.map(({ term, info }) => ({
    kind: 'topic',
    headword: term,
    gloss: clampChars(normalizeWhitespace(info.firstText), 160),
    seq: info.firstSeq,
    time: info.firstTime,
  }))
}

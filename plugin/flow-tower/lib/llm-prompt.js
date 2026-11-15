/**
 * --- module contract ---
 * purpose: Prompt construction and tolerant JSON repair for model responses.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/llm.js, lib/tools/dev.js, tools/propose-agent.mjs
 * publicApi: [generated] buildProposalPrompt, parseProposalJson, repairModelJson, salvageEntries
 * risk: Low: pure text transformations.
 * --- end module contract ---
 */

/**
 * @param {{ seq: number, text: string }[]} samples
 * @param {{ maxEntries?: number, existing?: string[] }} [options]
 * @returns {string}
 */
export function buildProposalPrompt(samples, options = {}) {
  const maxEntries = options.maxEntries ?? 20
  const existing = (options.existing ?? []).slice(0, 80)
  const maxChars = 24000
  let budget = maxChars
  const lines = []
  for (const sample of samples) {
    const text = String(sample.text ?? '').replace(/\s+/g, ' ').trim()
    if (text.length === 0 || budget <= 0) continue
    const chunk = text.slice(0, Math.min(1600, budget))
    lines.push(`[seq ${sample.seq}] ${chunk}`)
    budget -= chunk.length
  }
  return [
    'You are the dictionary compiler of a project memory system.',
    'Read the numbered conversation excerpts and extract durable, reusable memory entries.',
    `Return JSON only, at most ${maxEntries} entries: {"entries":[{"kind":"topic|feature|decision|task|person|file|api-symbol|chapter","headword":"...","gloss":"one factual sentence","citations":[seq,...],"status":"open|done (task only)","module":"optional"}]}`,
    'Rules: every entry MUST cite at least one [seq N] from the excerpts; never invent seq numbers; headword 2-60 chars, no code/JSON payloads; gloss must be supported by the cited text; prefer project facts, decisions, open tasks, insights over chit-chat; merge duplicates.',
    'EXCLUDE process noise: never record file created/updated/deleted logs, test results, command output, tool calls, install/link/patch success, bundle applied, pnpm/npm output. These are already covered by raw evidence.',
    'Each entry may include aliases: 2-6 short alternative names, abbreviations or synonyms (same language as the headword) that help retrieval; do not invent unrelated words.',
    'DO record durable knowledge: design decisions and reasons, constraints/agreements, open tasks with actionable content, domain concepts, names/relationships, and project facts.',
    'Bad examples (do NOT output): {"kind":"file","headword":"plugin/lib/x.js","gloss":"file was updated successfully"}, {"kind":"topic","headword":"test result","gloss":"tests passed"}.',
    existing.length > 0 ? `Already known headwords (avoid duplicating): ${existing.join(' | ')}` : '',
    '',
    lines.join('\n'),
  ].filter(Boolean).join('\n')
}

/**
 * Extract the first JSON object from model output (fenced or bare), repairing
 * common model mistakes: unescaped double quotes inside strings and raw
 * newlines/tabs inside strings (a frequent failure mode with reasoning models).
 * @param {string} text
 * @returns {any | null}
 */
export function parseProposalJson(text) {
  const value = String(text ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(value)
  const candidate = fenced !== null ? fenced[1] : value
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const slice = candidate.slice(start, end + 1)
  try {
    return JSON.parse(slice)
  } catch {
    try {
      return JSON.parse(repairModelJson(slice))
    } catch {
      return salvageEntries(slice)
    }
  }
}

/**
 * Salvage individually-valid entry objects from a malformed entries array.
 * Handles reasoning-model outputs where one field breaks the whole JSON.
 * @param {string} text
 * @returns {{ entries: any[] } | null}
 */
export function salvageEntries(text) {
  const start = text.indexOf('"entries"')
  if (start < 0) return null
  const arrayStart = text.indexOf('[', start)
  if (arrayStart < 0) return null
  const entries = []
  let index = arrayStart + 1
  while (index < text.length) {
    while (index < text.length && /[\s,]/.test(text[index])) index += 1
    if (text[index] !== '{') break
    let depth = 0
    let inString = false
    let escaped = false
    let end = index
    for (; end < text.length; end += 1) {
      const char = text[end]
      if (escaped) { escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === '"') { inString = !inString; continue }
      if (inString) continue
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (end >= text.length) break
    const slice = text.slice(index, end + 1)
    try {
      entries.push(JSON.parse(repairModelJson(slice)))
    } catch {
      // Skip this broken entry.
    }
    index = end + 1
  }
  return entries.length > 0 ? { entries } : null
}

/**
 * Repair unescaped quotes and raw control characters inside JSON strings.
 * @param {string} text
 * @returns {string}
 */
export function repairModelJson(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) {
      out += char
      escaped = false
      continue
    }
    if (char === '\\') {
      const following = text[index + 1]
      // Invalid JSON escapes (e.g. Windows paths like C:\Users) → escape the backslash.
      if (following === undefined || !'"\\/bfnrtu'.includes(following)) {
        out += '\\\\'
        continue
      }
      out += char
      escaped = true
      continue
    }
    if (char === '"') {
      if (!inString) {
        inString = true
        out += char
        continue
      }
      let next = index + 1
      while (next < text.length && /\s/.test(text[next])) next += 1
      const following = text[next]
      if (following === ',' || following === '}' || following === ']' || following === ':') {
        inString = false
        out += char
      } else {
        out += '\\"'
      }
      continue
    }
    if (inString && char === '\n') { out += '\\n'; continue }
    if (inString && char === '\r') { out += '\\r'; continue }
    if (inString && char === '\t') { out += '\\t'; continue }
    out += char
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}

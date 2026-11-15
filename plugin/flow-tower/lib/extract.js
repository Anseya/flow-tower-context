/**
 * --- module contract ---
 * purpose: Deterministic rule extraction of dictionary candidates from text samples.
 * dependsOn: [generated] lib/util.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/compiler.js, lib/maintenance.js, lib/proposals.js, test/flow-tower.test.js
 * publicApi: [generated] ENTRY_KINDS, candidatesTokenEstimate, deriveModule, extractCandidates, splitSentences
 * risk: Medium: candidate quality drives the whole memory layer; changes need extraction regression tests.
 * --- end module contract ---
 */

import { clampChars, estimateTokens, normalizeWhitespace } from './util.js'

/** Every entry kind the deterministic compiler can produce. */
export const ENTRY_KINDS = Object.freeze([
  'file',
  'feature',
  'api-symbol',
  'decision',
  'task',
  'command',
  'error',
  'topic',
  'chapter',
  'person',
])

const FILE_EXT_RE = /\b(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|markdown|py|pyi|yml|yaml|toml|ini|cfg|txt|sql|css|scss|sass|html|htm|sh|bash|ps1|psm1|go|rs|java|kt|c|h|cc|cpp|hpp|cs|rb|php|swift|lua|vue|svelte)\b/
const FILE_RE = /(?<![\w:])(?:[A-Za-z]:[\\/])?(?:[\w.@~-]+[\\/])*[\w.@-]+\.[A-Za-z0-9]{1,8}\b/g
const CMD_MARK_RE = /^\s*(?:\$|>)\s+(.{2,200})$/gm
const CMD_HEAD_RE = /^\s*(git|npm|pnpm|yarn|npx|node|python3?|pip3?|uv|dsh|cd|ls|dir|cat|type|grep|rg|curl|wget|pwsh|powershell|bash|sh|docker|kubectl|make|cmake|cargo|go|java|javac|mvn|gradle|ffmpeg|magick)\b\s*(.*)$/
const ERR_CODE_RE = /\b(E[A-Z]{2,}[A-Z0-9_]*|ERR_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_(?:ERROR|FAILED|EXCEEDED|INVALID|NOT_FOUND))\b/g
const ERR_PHRASE_RE = /\b(?:error|exception|panic|fatal|failed|failure)\b[^\n]{0,160}/gi
const DECISION_ZH_RE = /(决定|采用|选择|放弃|改为|不再|方案是|结论是|确认下来|约定|我们(?:将|要|会|不)|必须|不要|禁止|改用)/
const DECISION_EN_RE = /\b(decided|decide|choose|chose|adopt(?:ed)?|abandon(?:ed)?|instead|switch(?:ed)? to|plan is|we will|we should|must|should not|do not|rejected)\b/i
const TASK_RE = /(TODO|FIXME|下一步|待办|待确认|待定|blocked by|blocking|需要确认)/
const TASK_DONE_RE = /(?:(?:任务|待办|工作项|事项)[^。！？\n]{0,12}(?:已完成|完成|关闭|done|completed|resolved|finished))|(?:(?:已完成|完成|closed|done|completed)[^。！？\n]{0,6}(?:任务|待办|工作项|事项))/i
/** Our own injected digest and tool dumps of it: compiling them creates a feedback loop. */
const SELF_REFERENCE_RE = /(?:\[flow-tower\]|<\/?flow-tower-dictionary>|Project memory \(decisions|^---\s*(?:digest|stats|memory)\s*---$)/im
/** An explicit marker authorizes a task even when the sample is an assistant or tool turn. */
const TODO_MARK_RE = /\b(?:TODO|FIXME)\b\s*[:：]?/
/** Whole headwords that are only headings, list numbers or punctuation. */
const TASK_HEADING_RE = /^(?:[一二三四五六七八九十百]+[、.．]|第[一二三四五六七八九十百]+[章节步]|\d+[.)、．]?|[a-zA-Z][.)]|[\p{P}\p{S}\s]+)$/u
/** Digest/stat fragments that survive whitespace cleanup but are not work items. */
const TASK_META_RE = /(?:^chars?\s*[:=]|^stats\b|^estTokens\b|^Open\s*:|^Modules\s*:|^Latest\s*:|^Goal\s*:|^seq\s*=|^BROWSE\s*\[|^e_[0-9a-f]{6,}|^=====)/

const FEATURE_ZH_RE = /(?:实现|支持|添加|新增|开发|接入|修复|优化|重构|设计|完善|补齐)([^，。；、\n]{2,24})/g
const FEATURE_EN_RE = /\b(?:implement(?:ed|ing)?|add(?:ed|ing)?|support(?:ed|ing)?|build(?:ing)?|create[ds]?|develop(?:ed|ing)?|integrat(?:e|ed|ing)|fix(?:ed|ing)?|refactor(?:ed|ing)?|optimi[sz](?:e|ed|ing)|design(?:ed|ing)?|complet(?:e|ed|ing))\s+([a-zA-Z0-9][^.;\n]{2,40})/gi
const BACKTICK_SYMBOL_RE = /`([A-Za-z_$][\w$]*(?:\.[\w$]+)*(?:\(\))?)`/g
const SENTENCE_SPLIT_RE = /(?<=[。！？；;.!?\n])\s*/
// Narrative support: chapter headings and dialogue-attributed character names.
const CHAPTER_ZH_RE = /(第[\d一二三四五六七八九十百千万零两]{1,7}[章回节卷][ \u3000]*[^\r\n，。；]{0,30})/g
const CHAPTER_EN_RE = /(?:^|\r?\n)[ \u3000]*(Chapter\s+\d+[^\r\n]{0,50})/g
const DIALOGUE_ATTR_RE = /([\u4e00-\u9fa5]{2,4}?)(?:说道|问道|答道|笑道|叫道|沉声道|冷声道|低声道|开口|道)[：:]/g
/** Chinese novels often attribute after the closing quote: `”韩立问道`. */
const DIALOGUE_AFTER_QUOTE_RE = /”[ \u3000]*([\u4e00-\u9fa5]{2,3})(?:[^”"\n]{0,6}?)(?:说道|问道|答道|笑道|叫道|沉声道|冷声道|低声道|道)/g
/** Characters that never appear in a plausible Chinese name here (verbs/particles/pronouns/adverbs). */
const PERSON_STOP_CHARS = /[的了着便就是不在有这那他她我你们个说问答笑怒冷沉声口知想要会把被让给对从到看听走跑站坐起回过来去上下前后里外手中黯缓轻淡苦惊急忙连奇怪哼叹也没自关]/
/** Whole phrases that look like names but are not. */
const PERSON_STOP_WORDS = new Set([
  '自己', '对方', '众人', '此人', '一人', '两人', '三人', '他们', '她们', '我们', '你们',
  '旁人', '别人', '有人', '无人', '那人', '这人', '诸位', '各位', '大家', '在下', '老夫',
  '本座', '贫道', '道友', '师父', '师傅', '师兄', '师姐', '师弟', '师妹', '前辈', '晚辈',
  '姑娘', '公子', '少爷', '小姐', '掌柜', '小二',
])

/**
 * @param {string} name
 * @returns {boolean}
 */
function looksLikePersonName(name) {
  if (typeof name !== 'string') return false
  let value = name
  // Attribution capture often absorbs one trailing adverb/verb char (韩立也/韩立没).
  while (value.length > 2) {
    const last = value.slice(-1)
    if (!PERSON_STOP_CHARS.test(last)) break
    value = value.slice(0, -1)
  }
  if (!/^[\u4e00-\u9fa5]{2,4}$/.test(value)) return false
  if (PERSON_STOP_CHARS.test(value)) return false
  if (PERSON_STOP_WORDS.has(value)) return false
  return true
}

/**
 * Normalize a captured attribution name (strip trailing noise chars).
 * @param {string} name
 * @returns {string | null}
 */
function normalizePersonName(name) {
  let value = String(name ?? '')
  while (value.length > 2) {
    const last = value.slice(-1)
    if (!PERSON_STOP_CHARS.test(last)) break
    value = value.slice(0, -1)
  }
  return looksLikePersonName(value) ? value : null
}

/**
 * Derive a code-module prefix from a path-like headword.
 * When the path lives under the current project, the module is relative to it;
 * otherwise the first two path segments (after an optional drive) are used.
 * `src/a.ts` -> `src`, `src/compiler/x.ts` -> `src/compiler`,
 * `packages/core/agent/src/x.ts` -> `packages/core`.
 * @param {string} headword
 * @param {string} [project] normalized project root (forward slashes)
 * @returns {string}
 */
export function deriveModule(headword, project) {
  let value = String(headword ?? '').replaceAll('\\', '/').replace(/^[A-Za-z]:\//, '')
  const root = String(project ?? '').replaceAll('\\', '/').replace(/^[A-Za-z]:\//, '').replace(/\/+$/, '')
  if (root.length > 0 && value.startsWith(`${root}/`)) value = value.slice(root.length + 1)
  const parts = value.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.length < 2) return ''
  // Home/temp/absolute system prefixes are not project modules.
  const HOME_LIKE = new Set(['users', 'home', 'tmp', 'var', 'usr', 'opt', 'mnt', 'private', 'volumes', 'windows', 'programdata'])
  if (HOME_LIKE.has(parts[0].toLowerCase())) return ''
  if (/^[A-Za-z]:$/.test(parts[0])) return ''
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0]
}

/**
 * Split prose into sentence-ish chunks usable as glosses.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  return String(text ?? '').split(SENTENCE_SPLIT_RE).map((part) => part.trim()).filter(Boolean)
}

/** Find the sentence containing a match offset. */
function sentenceAtOffset(text, textOffset) {
  if (!Number.isInteger(textOffset) || textOffset < 0) return ''
  let cursor = 0
  for (const sentence of splitSentences(text)) {
    const start = text.indexOf(sentence, cursor)
    if (start < 0) continue
    const end = start + sentence.length
    cursor = end
    if (textOffset >= start && textOffset <= end) return sentence
  }
  return ''
}

const NOISE_HEADWORD_RE = /[{}<>|]|\\n|```|\btool-call\b|"content":|<\/?[a-z][\w-]*>|^\d+:\s|^\s*[-*]\s*\{/

/**
 * Strip markdown decoration and reject tool-payload/markup noise from a
 * candidate headword without touching meaningful identifier characters.
 * @param {string} text
 * @param {string} [kind]
 * @returns {string}
 */
function cleanHeadword(text, kind = '') {
  let value = normalizeWhitespace(String(text ?? '')
    .replace(/^[\s#>*`'"“”‘’([【]+/, '')
    .replace(/[\s`'"“”‘’",，。；;:：]+$/, ''))
  if (value.length === 0 || NOISE_HEADWORD_RE.test(value)) return ''
  if (!/[\p{L}\p{N}]/u.test(value)) return ''
  if (kind === 'decision' || kind === 'task' || kind === 'feature' || kind === 'topic') {
    value = value.replace(/^[-*#>\s]+/, '')
    value = value.split(/[。！？!?；;]/)[0] ?? value
    value = value.split(/[，,]/)[0] ?? value
    value = clampChars(value, 60)
  }
  return value
}

/**
 * Heuristic: is this text sample narrative prose (novel-style) rather than
 * project/task content? Narrative samples only yield chapter/person entries.
 * @param {string} text
 * @returns {boolean}
 */
function isNarrativeSample(text) {
  const quotes = (text.match(/[“”]/g) ?? []).length
  if (quotes >= 6) return true
  CHAPTER_ZH_RE.lastIndex = 0
  return CHAPTER_ZH_RE.test(text)
}

/**
 * Mine deterministic candidates from one text sample.
 * @param {{ seq: number, role: string, text: string, time?: number }} sample
 * @param {Map<string, any>} out
 * @param {number} maxGlossChars
 * @param {string} project
 * @param {Map<string, { count: number, seq: number, time: number, gloss: string }>} personCounts
 */
function mineSample(sample, out, maxGlossChars, project, personCounts) {
  const text = String(sample.text ?? '')
  if (text.length === 0) return
  // Re-indexing our own digest/tool dump would turn generated text into tasks.
  if (SELF_REFERENCE_RE.test(text)) return
  const role = String(sample.role ?? '')
  const toolRole = role === 'tool'
  const explicitTodo = TODO_MARK_RE.test(text)
  const time = Number.isFinite(sample.time) ? sample.time : 0
  /** File paths seen in this sample, used to attribute tasks/features/decisions to a module. */
  const sampleFiles = []
  /** @returns {boolean} whether a new candidate was recorded */
  const take = (kind, headword, gloss, extra = {}) => {
    const cleaned = cleanHeadword(headword, kind)
    if (cleaned.length < 2 || cleaned.length > 120) return false
    const key = `${kind}\u0000${cleaned.toLowerCase()}`
    const existing = out.get(key)
    if (existing !== undefined) {
      // A later completed task upgrades an open one; keep the latest status.
      if (kind === 'task' && extra.status === 'done' && existing.status !== 'done') existing.status = 'done'
      return false
    }
    out.set(key, {
      kind,
      headword: cleaned,
      gloss: clampChars(normalizeWhitespace(gloss), maxGlossChars),
      seq: sample.seq,
      time,
      ...(kind === 'file' || kind === 'api-symbol' ? { module: deriveModule(cleaned, project) } : {}),
      ...((kind === 'task' || kind === 'feature' || kind === 'decision') && sampleFiles.length > 0
        ? { module: deriveModule(sampleFiles[0], project) }
        : {}),
      ...(kind === 'task' ? { status: extra.status ?? 'open' } : {}),
    })
    return true
  }

  // Project/task extraction (suppressed for narrative prose).
  if (!isNarrativeSample(text)) {
  // Files: keep path-like tokens whose extension is a known source/config type.
  FILE_RE.lastIndex = 0
  for (let match = FILE_RE.exec(text); match !== null; match = FILE_RE.exec(text)) {
    const value = match[0]
    if (value.length < 4 || value.length > 160) continue
    // Skip URL-ish tokens (scheme or domain-looking prefix) — they are content, not code paths.
    if (value.includes('://') || /^(?:[\w-]+\.)+[a-z]{2,}\//i.test(value)) continue
    const ext = value.slice(value.lastIndexOf('.') + 1).toLowerCase()
    if (!FILE_EXT_RE.test(`.${ext}`) && !FILE_EXT_RE.test(ext)) continue
    sampleFiles.push(value)
    take('file', value, sentenceAtOffset(text, match.index))
  }

  // Commands: explicit shell markers, otherwise known CLI heads.
  CMD_MARK_RE.lastIndex = 0
  for (let match = CMD_MARK_RE.exec(text); match !== null; match = CMD_MARK_RE.exec(text)) {
    take('command', clampChars(match[1], 120), clampChars(match[1], 200))
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length < 4 || trimmed.length > 200) continue
    if (!CMD_HEAD_RE.test(trimmed)) continue
    take('command', clampChars(trimmed, 120), clampChars(trimmed, 200))
  }

  // Error codes and error phrases.
  ERR_CODE_RE.lastIndex = 0
  for (let match = ERR_CODE_RE.exec(text); match !== null; match = ERR_CODE_RE.exec(text)) {
    take('error', match[1], sentenceAtOffset(text, match.index))
  }
  ERR_PHRASE_RE.lastIndex = 0
  for (let match = ERR_PHRASE_RE.exec(text); match !== null; match = ERR_PHRASE_RE.exec(text)) {
    take('error', clampChars(match[0], 100), sentenceAtOffset(text, match.index))
  }

/**
 * Turn a task-like sentence into a short, human-readable headword instead of
 * keeping the whole fragment (the biggest source of noisy open tasks).
 * @param {string} sentence
 * @returns {string}
 */
function cleanTaskHeadword(sentence) {
  let text = String(sentence ?? '')
  text = text.replace(/^\s*(?:[-*•>]+|\d+[.)])\s*/, '')
  text = text.replace(/^(?:\/\/+|#+|--+|;+)\s*/, '')
  text = text.replace(/^#{1,6}\s*/, '')
  text = text.replace(/\*\*/g, '')
  text = text.replace(/^(?:TODO|FIXME|下一步|待办|待确认|待定)\s*[:：\-]?\s*/i, '')
  text = text.replace(/^[`"'“”)\]}】\s]+/, '').trim()
  text = text.split(/[。！？；;!?\n]/)[0].trim()
  if (text.length > 50) {
    const cut = text.search(/[，,]/)
    if (cut >= 8) text = text.slice(0, cut)
  }
  const head = text.slice(0, 80).trim()
  if (head.length < 4) return ''
  if (TASK_HEADING_RE.test(head)) return ''
  if (TASK_META_RE.test(head)) return ''
  // Digest excerpts are truncated with an ellipsis; a clipped sentence is not a task.
  if (head.includes('…')) return ''
  return head
}

  // Decisions, tasks and feature/capability units come from whole sentences.
  let featureCount = 0
  for (const sentence of splitSentences(text)) {
    if (sentence.length < 8 || sentence.length > 500) continue
    const looksLikeTask = TASK_RE.test(sentence) || TASK_DONE_RE.test(sentence)
    if (looksLikeTask) {
      const done = TASK_DONE_RE.test(sentence)
      // User asks create work; assistant "next steps" advice must not; a done
      // statement from the assistant closes work; explicit TODO/FIXME may live
      // in any role (including code shown in tool output).
      const allowed = role === 'user' || explicitTodo || (role === 'assistant' && done)
      if (allowed) take('task', clampChars(cleanTaskHeadword(sentence), 80), sentence, { status: done ? 'done' : 'open' })
      continue
    }
    if (!toolRole && (DECISION_ZH_RE.test(sentence) || DECISION_EN_RE.test(sentence))) {
      take('decision', clampChars(sentence, 80), sentence)
    }
    if (!toolRole && featureCount < 3) {
      FEATURE_ZH_RE.lastIndex = 0
      for (let match = FEATURE_ZH_RE.exec(sentence); match !== null; match = FEATURE_ZH_RE.exec(sentence)) {
        if (featureCount >= 3) break
        if (take('feature', clampChars(match[0], 40), sentence)) featureCount += 1
      }
      FEATURE_EN_RE.lastIndex = 0
      for (let match = FEATURE_EN_RE.exec(sentence); match !== null; match = FEATURE_EN_RE.exec(sentence)) {
        if (featureCount >= 3) break
        if (take('feature', clampChars(match[0], 40), sentence)) featureCount += 1
      }
    }
  }

  // Backticked API symbols.
  BACKTICK_SYMBOL_RE.lastIndex = 0
  for (let match = BACKTICK_SYMBOL_RE.exec(text); match !== null; match = BACKTICK_SYMBOL_RE.exec(text)) {
    take('api-symbol', match[1], sentenceAtOffset(text, match.index))
  }
  }

  // Narrative: chapter headings become topic entries (time axis landmarks).
  CHAPTER_ZH_RE.lastIndex = 0
  for (let match = CHAPTER_ZH_RE.exec(text); match !== null; match = CHAPTER_ZH_RE.exec(text)) {
    take('chapter', clampChars(match[1], 60), 'chapter marker')
  }
  CHAPTER_EN_RE.lastIndex = 0
  for (let match = CHAPTER_EN_RE.exec(text); match !== null; match = CHAPTER_EN_RE.exec(text)) {
    take('chapter', clampChars(match[1], 60), 'chapter marker')
  }

  // Narrative: count dialogue-attributed names; the caller keeps frequent ones.
  const rememberPerson = (name, index) => {
    const normalized = normalizePersonName(name)
    if (normalized === null) return
    const existing = personCounts.get(normalized)
    if (existing === undefined) {
      personCounts.set(normalized, { count: 1, seq: sample.seq, time, gloss: sentenceAtOffset(text, index) })
    } else {
      existing.count += 1
    }
  }
  DIALOGUE_ATTR_RE.lastIndex = 0
  for (let match = DIALOGUE_ATTR_RE.exec(text); match !== null; match = DIALOGUE_ATTR_RE.exec(text)) {
    rememberPerson(match[1], match.index)
  }
  DIALOGUE_AFTER_QUOTE_RE.lastIndex = 0
  for (let match = DIALOGUE_AFTER_QUOTE_RE.exec(text); match !== null; match = DIALOGUE_AFTER_QUOTE_RE.exec(text)) {
    rememberPerson(match[1], match.index)
  }
}

/**
 * Extract deterministic candidates from projected messages.
 * @param {readonly { seq: number, role: string, text: string, time?: number }[]} samples
 * @param {{ maxGlossChars?: number, maxCandidates?: number, project?: string,
 *   minPersonMentions?: number, maxPersons?: number }} [options]
 * @returns {{ kind: string, headword: string, gloss: string, seq: number,
 *   time: number, module?: string, status?: string }[]}
 */
export function extractCandidates(samples, options = {}) {
  const maxGlossChars = options.maxGlossChars ?? 180
  const maxCandidates = options.maxCandidates ?? 400
  const project = options.project ?? ''
  const minPersonMentions = options.minPersonMentions ?? 2
  const maxPersons = options.maxPersons ?? 100
  const out = new Map()
  const personCounts = new Map()
  for (const sample of samples) {
    if (out.size >= maxCandidates) break
    if (sample === null || typeof sample !== 'object') continue
    if (sample.role === 'system' || sample.role === 'developer') continue
    mineSample(sample, out, maxGlossChars, project, personCounts)
  }
  // Frequent dialogue speakers become person entries (narrative corpus only).
  const persons = [...personCounts.entries()]
    .filter(([, info]) => info.count >= minPersonMentions)
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
    .slice(0, maxPersons)
    .map(([name, info]) => ({
      kind: 'person',
      headword: name,
      gloss: clampChars(normalizeWhitespace(info.gloss), maxGlossChars),
      seq: info.seq,
      time: info.time,
    }))
  // Keep the candidate budget but never drop the high-value person entries.
  const base = [...out.values()]
  const room = Math.max(0, maxCandidates - persons.length)
  return [...base.slice(0, room), ...persons]
}

/**
 * Approximate extraction budget for metrics/diagnostics.
 * @param {readonly any[]} candidates
 * @returns {number}
 */
export function candidatesTokenEstimate(candidates) {
  let total = 0
  for (const candidate of candidates) {
    total += estimateTokens(candidate.headword) + estimateTokens(candidate.gloss)
  }
  return total
}

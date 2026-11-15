/**
 * --- module contract ---
 * purpose: Decide per-step injection mode from task type, native checkpoint freshness and context pressure (dual / dual-lite / long-only / short-only).
 * dependsOn: [generated] lib/util.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] index.js, lib/brief.js, lib/digest.js, test/flow-tower.test.js
 * publicApi: [generated] CHECKPOINT_MARKER, classifyTask, detectCheckpoint, planMarker, resolveInjectionPlan
 * risk: Low-medium: prompt-visible policy, but pure and deterministic; every unexpected message shape must degrade to the previous full-digest behavior.
 * --- end module contract ---
 */

import { contentToText } from './util.js'

/** Opening tag of the native DSH compaction checkpoint (compaction-basic). */
export const CHECKPOINT_MARKER = '<compacted-summary>'

/** The checkpoint preamble is stable in dsh-compaction-basic; keep both probes. */
const CHECKPOINT_PREAMBLE_RE = /automatically generated checkpoint condensing an earlier span/i

const TASK_KINDS = new Set(['coding', 'planning', 'research', 'history', 'general'])
const INJECTION_MODES = new Set(['auto', 'dual', 'off'])

/** Tool names that change the workspace; their presence means an editing task. */
const EDIT_TOOL_RE = /^(?:edit|write|apply_patch|multi_edit|notebook_edit|file_edit|create_file|delete_file|move_file)$/i
/** Tool names that only read; their presence means exploration/research. */
const READ_TOOL_RE = /^(?:read|grep|glob|ls|list_dir|list_files|web_search|web_fetch|webfetch|search|skill|dict_[a-z_]+|cordis_inspect_[a-z_]+)$/i
/** Planning/coordination tools. */
const PLAN_TOOL_RE = /^(?:todo_write|exit_plan_mode|ask_user_question|plan_mode)$/i

const CODING_RE = /(?:修改|实现|修复|重构|补全|补齐|加上|加入|删除|替换|升级|迁移|接入|落地|写|改|implement|fix|refactor|edit|write|patch|rename|migrate|upgrade|build|test|port)/iu
const PLANNING_RE = /(?:规划|计划|方案|路线图|设计|决定|取舍|评估|对比|梳理|定位|roadmap|plan|design|decide|strategy|assess|compare)/iu
const HISTORY_RE = /(?:之前|上次|历史|进度|全貌|上下文|记忆|回顾|当时|曾经|what did we|history|progress|earlier|previous|remember|recap)/iu
const RESEARCH_RE = /(?:论文|研究|调研|解释|为什么|原理|机制|怎么实现|how does|why|research|paper|explain|understand)/iu

/**
 * Flatten one message's text without throwing on unknown content blocks.
 * @param {any} message
 * @returns {string}
 */
function messageText(message) {
  try {
    return contentToText(message?.content)
  } catch {
    return ''
  }
}

/**
 * Locate the newest native compaction checkpoint in the derived history.
 * The checkpoint is a durable user message; its age is measured in turns so the
 * policy can tell "native short-range state is fresh" from "the summary is stale".
 *
 * The replacement user message sits at the START of the retained region (right
 * after the system prompt), not at the tail. Scanning only the last N messages
 * misses it as soon as the post-compaction tool loop grows beyond N - which
 * wrongly downgraded dual/dual-lite to long-only in long sessions. Scan the head
 * first, then the tail as a fallback for unusual forks.
 * @param {readonly any[]} messages derived messages (session.deriveMessages())
 * @param {{ headScan?: number, tailScan?: number }} [options]
 * @returns {{ present: boolean, index: number, ageMessages: number, ageTurns: number }}
 */
export function detectCheckpoint(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : []
  const headScan = Number.isSafeInteger(options.headScan) && options.headScan > 0 ? options.headScan : 50
  const tailScan = Number.isSafeInteger(options.tailScan) && options.tailScan > 0 ? options.tailScan : 50
  const candidates = []
  for (let index = 0; index < Math.min(list.length, headScan); index += 1) candidates.push(index)
  for (let index = Math.max(0, list.length - tailScan); index < list.length; index += 1) {
    if (!candidates.includes(index)) candidates.push(index)
  }
  for (const index of candidates) {
    const message = list[index]
    if (message?.role !== 'user') continue
    const text = messageText(message)
    if (text.length === 0) continue
    if (!text.includes(CHECKPOINT_MARKER) && !CHECKPOINT_PREAMBLE_RE.test(text)) continue
    let ageMessages = 0
    for (let next = index + 1; next < list.length; next += 1) {
      const role = list[next]?.role
      if (role === 'user' || role === 'assistant') ageMessages += 1
    }
    return { present: true, index, ageMessages, ageTurns: Math.floor(ageMessages / 2) }
  }
  return { present: false, index: -1, ageMessages: 0, ageTurns: 0 }
}

/**
 * Last real user request: skip checkpoints and this plugin's own digest messages,
 * otherwise the policy classifies its own injected text as the task.
 * @param {readonly any[]} messages
 * @returns {string}
 */
function latestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (message?.source?.kind === 'flow-tower') continue
    const text = messageText(message)
    if (text.length === 0) continue
    if (text.includes(CHECKPOINT_MARKER) || CHECKPOINT_PREAMBLE_RE.test(text)) continue
    return text
  }
  return ''
}

/**
 * Collect recent tool-call names from assistant blocks and tool results.
 * @param {readonly any[]} messages
 * @param {number} limit
 * @returns {string[]}
 */
function collectToolNames(messages, limit = 12) {
  const names = []
  for (let index = messages.length - 1; index >= 0 && names.length < limit; index -= 1) {
    const message = messages[index]
    if (message?.role === 'tool' && typeof message?.source?.toolName === 'string') names.push(message.source.toolName)
    if (typeof message?.toolName === 'string') names.push(message.toolName)
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'tool-call' && typeof block.name === 'string') names.push(block.name)
    }
  }
  return names
}

/**
 * Classify the current work phase from recent tools and the latest user request.
 * Deliberately coarse: the policy only needs "needs exact recent details" versus
 * "needs long-range orientation".
 * @param {readonly any[]} messages derived messages
 * @returns {'coding'|'planning'|'research'|'history'|'general'}
 */
export function classifyTask(messages) {
  const list = Array.isArray(messages) ? messages : []
  const recent = list.slice(-40)
  const toolNames = collectToolNames(recent)
  // Tool loops can push the last real user request far from the tail; look back
  // 400 messages before calling the intent general.
  const latest = latestUserText(list.slice(-400))
  const hasEditTool = toolNames.some((name) => EDIT_TOOL_RE.test(name))
  const hasPlanTool = toolNames.some((name) => PLAN_TOOL_RE.test(name))
  const onlyReadTools = toolNames.length > 0
    && toolNames.every((name) => READ_TOOL_RE.test(name) || PLAN_TOOL_RE.test(name))
  if (hasEditTool) return 'coding'
  // Explicit edit verbs beat incidental planning words ("决定…修改…"): a written
  // request to change code needs the recent-detail path, not the planning path.
  const planningHits = (latest.match(PLANNING_RE) ?? []).length
  const codingHits = (latest.match(CODING_RE) ?? []).length
  if (hasPlanTool && codingHits === 0) return 'planning'
  if (planningHits > 0 && codingHits === 0) return 'planning'
  if (codingHits > 0) return 'coding'
  if (HISTORY_RE.test(latest)) return 'history'
  if (RESEARCH_RE.test(latest) || (onlyReadTools && /[?？]/.test(latest))) return 'research'
  return 'general'
}

/**
 * Resolve the injection plan for one step.
 *
 * Roles:
 * - native short-range: the DSH checkpoint already in history after compaction;
 * - Flow Tower long-range: this plugin's digest / Project map.
 *
 * `auto` keeps both only when they contribute different information:
 * - no checkpoint            -> long-only (this digest is the only continuity);
 * - fresh checkpoint+coding  -> dual-lite (map orientation, no recency recap);
 * - fresh checkpoint+planning-> dual (decisions/open work + recent constraints);
 * - stale checkpoint         -> dual (the summary no longer describes current work);
 * - fresh checkpoint+general -> short-only (skip, the native summary is enough);
 * - pressure >= 0.85         -> short-only (yield to native compaction).
 * @param {{ config?: any, checkpoint?: { present: boolean, ageTurns: number }, taskKind?: string, pressureRatio?: number | null }} [input]
 * @returns {{
 *   inject: boolean, mode: 'dual'|'dual-lite'|'long-only'|'short-only'|'off',
 *   label: string, reason: string, taskKind: string,
 *   checkpointPresent: boolean, checkpointAgeTurns: number | null,
 *   budgetScale: number, omitRecency: boolean, omitLatest: boolean
 * }}
 */
export function resolveInjectionPlan(input = {}) {
  const config = input.config !== null && typeof input.config === 'object' ? input.config : {}
  const checkpoint = input.checkpoint !== null && typeof input.checkpoint === 'object'
    ? input.checkpoint
    : { present: false, ageTurns: 0 }
  const taskKind = TASK_KINDS.has(input.taskKind) ? input.taskKind : 'general'
  const pressureRatio = typeof input.pressureRatio === 'number' && Number.isFinite(input.pressureRatio)
    ? input.pressureRatio
    : null
  const forced = INJECTION_MODES.has(config.injectionMode) ? config.injectionMode : 'auto'
  const base = {
    taskKind,
    checkpointPresent: checkpoint.present === true,
    checkpointAgeTurns: checkpoint.present === true ? Number(checkpoint.ageTurns ?? 0) : null,
  }

  if (forced === 'off') {
    return { ...base, inject: false, mode: 'off', label: 'short-only', reason: 'injectionMode=off', budgetScale: 0, omitRecency: false, omitLatest: false }
  }
  if (forced === 'dual') {
    return { ...base, inject: true, mode: 'dual', label: 'dual', reason: 'injectionMode=dual', budgetScale: 1, omitRecency: false, omitLatest: false }
  }

  if (checkpoint.present !== true) {
    return {
      ...base,
      inject: true,
      mode: 'long-only',
      label: 'long-only',
      reason: 'no native checkpoint; the digest carries both orientation and recent progress',
      budgetScale: 1,
      omitRecency: false,
      omitLatest: false,
    }
  }

  if (base.checkpointAgeTurns !== null && base.checkpointAgeTurns > 2) {
    return {
      ...base,
      inject: true,
      mode: 'dual',
      label: 'dual',
      reason: 'checkpoint is older than 2 turns; recent work is no longer covered',
      budgetScale: 1,
      omitRecency: false,
      omitLatest: false,
    }
  }

  if (pressureRatio !== null && pressureRatio >= 0.85) {
    return {
      ...base,
      inject: false,
      mode: 'short-only',
      label: 'short-only',
      reason: 'context pressure >= 0.85; leave the window to the native checkpoint and live work',
      budgetScale: 0,
      omitRecency: false,
      omitLatest: false,
    }
  }

  if (taskKind === 'coding' || taskKind === 'research' || taskKind === 'history') {
    return {
      ...base,
      inject: true,
      mode: 'dual-lite',
      label: 'dual-lite',
      reason: 'fresh checkpoint already carries recent details; inject long-range orientation only',
      budgetScale: 0.6,
      omitRecency: true,
      omitLatest: true,
    }
  }

  if (taskKind === 'planning') {
    return {
      ...base,
      inject: true,
      mode: 'dual',
      label: 'dual',
      reason: 'planning needs decisions/open work beside the recent constraints',
      budgetScale: 1,
      omitRecency: false,
      omitLatest: false,
    }
  }

  return {
    ...base,
    inject: false,
    mode: 'short-only',
    label: 'short-only',
    reason: 'fresh checkpoint and no long-range task signal; keep tokens for the task',
    budgetScale: 0,
    omitRecency: false,
    omitLatest: false,
  }
}

/**
 * One-line header suffix describing the plan, e.g. `inject: dual-lite · short: checkpoint 1t · task: coding`.
 * @param {{ inject?: boolean, label?: string, taskKind?: string, checkpointAgeTurns?: number | null } | null | undefined} plan
 * @returns {string}
 */
export function planMarker(plan) {
  if (plan === null || plan === undefined || plan.inject !== true) return ''
  const parts = [`inject: ${plan.label ?? plan.mode ?? 'dual'}`]
  if (plan.checkpointAgeTurns !== null && plan.checkpointAgeTurns !== undefined) {
    parts.push(`short: checkpoint ${plan.checkpointAgeTurns}t ago`)
  }
  if (typeof plan.taskKind === 'string' && plan.taskKind.length > 0 && plan.taskKind !== 'general') {
    parts.push(`task: ${plan.taskKind}`)
  }
  return ` · ${parts.join(' · ')}`
}

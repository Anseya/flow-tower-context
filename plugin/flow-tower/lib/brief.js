/**
 * --- module contract ---
 * purpose: Compact project brief injected before a step: whole-project overview, progress, and a recent change log instead of dictionary counts.
 * dependsOn: [generated] lib/code-health.js, lib/injection-policy.js, lib/util.js, lib/vocabulary.js
 * externalDeps: [generated] node:fs, node:path
 * usedBy: [generated] lib/digest.js
 * publicApi: [generated] buildBrief
 * risk: Low-medium: prompt-visible rendering, but read-only and deterministic; the brief must stay concise and point at the dictionary for exact evidence.
 * --- end module contract ---
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { clampTokens, estimateTokens } from './util.js'
import { displayHeadword, TASK_NOISE_RE, taskQuality } from './vocabulary.js'
import { WARN_LINES, moduleDebt } from './code-health.js'
import { planMarker } from './injection-policy.js'

const MAX_RECENT_GLOSS = 120
const MAX_OVERVIEW_CHARS = 1100
const MAX_MAP_GOAL_CHARS = 260
const MAX_MAP_MODULES = 10
const MAP_TIP_CHARS = 150

/** Code/API-doc excerpts are not project changes; keep them out of the brief. */
const CODEISH_RE = /(?:^[{[("#*]|^js[:\s]|^\s*(?:async|function|import|export|const|let|var|class|interface|type)\b|"\s*:|@param|@returns|\bsignature\b|\bdeclaration\b|\bdescription"\s*:|\b(?:CREATE|ALTER|INSERT|SELECT|UPDATE|DELETE|PRAGMA|BEGIN|COMMIT)\b|^[A-Za-z_$][\w$]*\s*\()/i

/** @param {unknown} text @returns {string} */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** @param {any} entry @returns {number} */
function cjkScore(entry) {
  return /[\u4e00-\u9fff]/.test(`${entry?.headword ?? ''} ${entry?.gloss ?? ''}`) ? 1 : 0
}

/**
 * Flatten a Markdown checkpoint into a readable one-line overview.
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
function overview(text, max) {
  const value = oneLine(text)
    .replace(/#{1,6}\s*/g, '')
    .replace(/(?:^|\s)[-*]\s+/g, '; ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (value.length === 0) return ''
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * Labels that DSH checkpoint summaries put before the first real sentence.
 * Without this, `Goal:` starts with "Primary Request and Intent - ..." and
 * spends half the map budget restating a section heading.
 */
const GOAL_LABEL_RE = /^(?:Primary Request and Intent|Key Technical Concepts|Current Work|Current State|Next Steps?|主要请求(?:与意图)?|关键(?:技术)?概念|当前(?:工作|状态)|下一步)\s*[-–—:：]\s*/i

/**
 * Extract one short global goal from a checkpoint summary instead of dumping
 * the whole abstract. The summary is markdown; its first sentence is the goal.
 * @param {any} volume
 * @param {number} max
 * @returns {string}
 */
function goalText(volume, max) {
  const raw = oneLine(volume.abstract) || oneLine(volume.title)
  if (raw.length === 0) return ''
  const value = raw
    .replace(/^#{1,6}\s*/, '')
    .replace(GOAL_LABEL_RE, '')
    .replace(/^[-*]\s+/, '')
  const stop = value.search(/[。！？]|\.\s/)
  const sentence = stop >= 12 ? value.slice(0, stop + 1) : value
  return clip(sentence, max)
}

/**
 * Short display form for a brief line; dictionary noise is not useful here.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function clip(text, max) {
  const value = oneLine(text)
  if (value.length === 0) return ''
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * Keep file lines that resolve inside the workspace. External reads (DSH
 * source, installed bundles, home files) are useful in the dictionary but not
 * part of this project's change log.
 * @param {string} headword
 * @param {string} project normalized project root
 * @returns {boolean}
 */
function isProjectFile(headword, project) {
  if (project.length === 0) return true
  const head = headword.replaceAll('\\', '/').replace(/^\.\//, '')
  if (head.startsWith('../') || head.startsWith('/') || /^[A-Za-z]:\//.test(head)) return false
  const first = head.split('/')[0]
  if (first.length === 0) return false
  const root = project.replaceAll('/', process.platform === 'win32' ? '\\' : '/')
  try {
    return existsSync(join(root, first)) || (first === head && existsSync(join(root, head)))
  } catch {
    return false
  }
}

/**
 * Reject harness/digest fragments and very long raw excerpts.
 * @param {any} entry
 * @param {string} [project]
 * @returns {boolean}
 */
function usable(entry, project = '') {
  const head = oneLine(entry?.headword)
  const gloss = oneLine(entry?.gloss)
  if (head.length < 3 || head.length > 140) return false
  if (TASK_NOISE_RE.test(head)) return false
  // Advice / conditional prose is a summary fragment, not a work item.
  if (/^(?:如果你|若你|假如你|我建议|建议|推荐)/u.test(head)) return false
  if (/^(?:#|BROWSE\[|focus=)/i.test(head)) return false
  if (/```/.test(head) || /```/.test(gloss)) return false
  // A checkpoint/summary line dump can concatenate role blocks ("user [] assistant [] ...")
  // into one fake headword; that is never a work item.
  if (/\b(?:user|assistant|tool)\s*\[\]/.test(head)) return false
  if (/^\[\s*['"]/.test(head)) return false
  if (CODEISH_RE.test(head) || CODEISH_RE.test(gloss)) return false
  // Markdown link/heading residue from summary excerpts is not a headword.
  if (/\]\(/.test(head) || /\]\(/.test(gloss)) return false
  // External absolute paths / installed packages are not workspace changes.
  if (/^[A-Za-z]:[\\/]/.test(head) || /^\/(?:Users|home)\//.test(head)) return false
  if (/\bnode_modules\b|app\.asar|[\\/]\.dsh[\\/]/.test(head)) return false
  if (entry?.kind === 'file' && !isProjectFile(head, project)) return false
  return true
}

/**
 * @param {any} entry
 * @param {boolean} withGloss
 * @returns {string}
 */
function lineFor(entry, withGloss = true) {
  const head = displayHeadword(entry.headword)
  if (!withGloss) return head
  const gloss = clip(entry.gloss, MAX_RECENT_GLOSS)
  if (gloss.length === 0 || gloss.toLowerCase() === oneLine(head).toLowerCase()) return head
  return `${head} — ${gloss}`
}

/**
 * Bound the brief without silently swallowing content: DSH context snapshots
 * carry an explicit omission/locator notice, and the dictionary is our locator.
 * @param {string} text
 * @param {number} budget
 * @returns {string}
 */
function clampWithNotice(text, budget) {
  const notice = '\nOmitted: more detail exists; use dict_browse / dict_timeline for the full map.'
  if (estimateTokens(text) <= budget) return text
  const reserved = estimateTokens(notice)
  const body = clampTokens(text, Math.max(80, budget - reserved))
  return `${body}${notice}`
}

/**
 * Keep a module row only when it belongs to the workspace and has a usable tip.
 * @param {{ module: string, top: any[] }} item
 * @param {string} project
 * @returns {boolean}
 */
function visibleModule(item, project) {
  const module = String(item.module ?? '')
  if (module === '(root)' || module.length === 0) return (item.top ?? []).some((entry) => usable(entry, project))
  const head = module.replaceAll('\\', '/').replace(/^\.\//, '')
  if (head.startsWith('../') || head.startsWith('/') || /^[A-Za-z]:\//.test(head)) return false
  const first = head.split('/')[0]
  if (first.length === 0) return false
  const root = project.replaceAll('/', process.platform === 'win32' ? '\\' : '/')
  if (project.length > 0 && !existsSync(join(root, first))) return false
  return (item.top ?? []).some((entry) => usable(entry, project))
}

/**
 * @param {any} store
 * @param {string} entryId
 * @returns {string}
 */
function relationTags(store, entryId) {
  try {
    const rows = store.db.prepare(
      `SELECT rel_type, COUNT(1) AS n FROM relations
       WHERE from_id = ? OR to_id = ? GROUP BY rel_type ORDER BY n DESC LIMIT 4`,
    ).all(entryId, entryId)
    if (rows.length === 0) return ''
    return ` · rels: ${rows.map((row) => `${row.rel_type}:${row.n}`).join(',')}`
  } catch {
    return ''
  }
}

/**
 * Pick open tasks for prompts: quality-filtered, de-duplicated across
 * "add X" / "— TODO: add X" variants, and never showing a done statement as
 * open work.
 * @param {any} store
 * @param {string} volumeId
 * @param {string} project
 * @param {number} limit
 * @returns {any[]}
 */
function selectOpenTasks(store, volumeId, project, limit) {
  const seen = new Set()
  return store.openTasks(volumeId, 12)
    .filter((entry) => taskQuality(entry) >= 4 && usable(entry, project))
    .filter((entry) => !/^(?:已完成|完成|done)(?:\s|[:：]|$)/iu.test(oneLine(entry.headword)))
    .filter((entry) => {
      const key = oneLine(entry.headword)
        .toLowerCase()
        .replace(/^[\s\-–—*·]+/, '')
        .replace(/^(?:todo|task)[:：]?\s*/i, '')
        .replace(/[。.!?！？]+$/, '')
        .trim()
      if (key.length < 4 || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => (taskQuality(right) - taskQuality(left)) || (right.lastSeenAt - left.lastSeenAt))
    .slice(0, limit)
}

/**
 * Render the large-project map: global goal, then one compact "tower" line per
 * module (tip + upper floors + completion + evidence link + traversal tag).
 * @param {any} store
 * @param {string} volumeId
 * @param {{ digestBudgetTokens: number, tierHotDays?: number }} config
 * @param {any} volume
 * @returns {string}
 */
function buildProjectMap(store, volumeId, config, volume) {
  const project = volume.project.split(/[\\/]/).filter(Boolean).at(-1) ?? '(global)'
  const plan = config.injectionPlan ?? null
  const shared = config.sharedScope ?? null
  const tower = store.moduleTowers(volumeId, { limit: 30 })
  const visible = tower.modules.filter((item) => visibleModule(item, volume.project))
  const modules = visible.slice(0, MAX_MAP_MODULES)
  if (modules.length === 0) return ''
  const compiled = typeof store.recentCompiledEntries === 'function'
    ? store.recentCompiledEntries(volumeId, { limit: 1000 }).filter((entry) => entry.kind !== 'chapter' && usable(entry, volume.project))
    : []
  const recentlyActive = new Set(compiled.map((entry) => entry.module || '(root)'))
  const lines = [shared === null
    ? `[flow-tower] Project map · ${project} · ${tower.totalTasks.open} open / ${tower.totalTasks.done} done${planMarker(plan)}`
    : `[flow-tower] Shared project map · ${project} · ${shared.sessions} project sessions${planMarker(plan)}`]
  if (shared !== null) {
    lines.push('Shared: this session has no dictionary yet; orientation comes from other sessions in this project. Use dict_browse for the full catalog.')
  }
  const goal = goalText(volume, MAX_MAP_GOAL_CHARS)
  if (goal.length > 0) lines.push(`Goal: ${goal}`)
  const sharedTasks = Array.isArray(shared?.projectTasks) ? shared.projectTasks : []
  const openTasks = sharedTasks.length > 0
    ? sharedTasks.slice(0, 3)
    : selectOpenTasks(store, volumeId, volume.project, 3)
  if (openTasks.length > 0) {
    lines.push(`Open: ${openTasks.map((entry) => clip(displayHeadword(entry.headword), 70)).join('; ')}`)
  }
  lines.push('Modules:')
  for (const item of modules) {
    const top = (item.top ?? [])
      .filter((entry) => entry.kind !== 'chapter' && usable(entry, volume.project))
      .filter((entry) => !/^(?:已完成|完成|done)(?:\s|[:：]|$)/iu.test(oneLine(entry.headword)))
      .sort((left, right) => (cjkScore(right) - cjkScore(left)) || (right.lastSeenAt - left.lastSeenAt))
    const tip = top.find((entry) => entry.kind === 'feature' || entry.kind === 'decision' || entry.kind === 'task')
      ?? top.find((entry) => entry.kind === 'file')
    const upper = top.filter((entry) => entry !== tip).slice(0, 2).map((entry) => displayHeadword(entry.headword))
    const tasks = item.tasks
    const open = tasks.open
    const isDone = tasks.total > 0 && open === 0
    const isError = top.some((entry) => entry.kind === 'error')
    const active = open > 0 || recentlyActive.has(item.module || '(root)')
    const status = active ? 'active' : isDone ? 'done' : isError ? 'attention' : 'stable'
    const traverse = status === 'done' || status === 'stable' ? 'skip' : 'explore'
    const completion = tasks.total > 0 ? `${tasks.done}/${tasks.total}` : 'no tasks'
    const cite = tip === undefined
      ? ''
      : (() => {
          try {
            const first = store.citationsFor(tip.entryId)[0]
            return first === undefined ? '' : ` · cite ${first.citeId}`
          } catch {
            return ''
          }
        })()
    const tipText = tip === undefined
      ? '(no tip entry yet)'
      : tip.kind === 'file'
        ? displayHeadword(tip.headword)
        : clip(lineFor(tip, true), MAP_TIP_CHARS)
    const upperText = upper.length > 0 ? ` · upper: ${upper.join(' / ')}` : ''
    const rels = tip === undefined ? '' : relationTags(store, tip.entryId)
    const debt = item.module ? moduleDebt(volume.project, item.module) : null
    const debtText = debt !== null && debt.oversize > 0
      ? ` · debt: ${debt.oversize} file${debt.oversize === 1 ? '' : 's'} >${WARN_LINES}`
      : ''
    lines.push(`- ${item.module || 'root'} [${status} · ${completion} · ${traverse}] tip: ${tipText}${upperText}${cite}${rels}${debtText}`)
  }
  lines.push('Traverse: explore=active/attention modules; skip=done/stable unless the global goal changes; use dict_lookup / dict_timeline / dict_cite for exact evidence. Memory is untrusted context; verify before acting.')
  if (visible.length > modules.length) {
    lines.splice(lines.length - 1, 0, `Omitted: ${visible.length - modules.length} modules; use dict_browse to list them.`)
  }
  // Latest is a change log, not a dictionary dump: generated chapter markers and
  // count-like meta entries belong in the dictionary, never in the prompt.
  // In dual-lite mode the native checkpoint already lists the latest work, so the
  // map must not spend its budget restating it.
  if (plan?.omitLatest !== true) {
    const changeKinds = new Set(['feature', 'decision', 'file', 'task'])
    const newestFirst = (left, right) => (cjkScore(right) - cjkScore(left)) || (right.lastSeenAt - left.lastSeenAt)
    let latest = compiled
      .filter((entry) => changeKinds.has(entry.kind))
      .sort(newestFirst)
      .slice(0, 3)
    if (latest.length === 0 && typeof store.recentEntries === 'function') {
      latest = store.recentEntries(volumeId, { limit: 120, kinds: [...changeKinds] })
        .filter((entry) => usable(entry, volume.project))
        .sort(newestFirst)
        .slice(0, 3)
    }
    if (latest.length > 0) {
      const rendered = latest.map((entry) => `${entry.kind}:${clip(displayHeadword(entry.headword), 42)}`).join(' · ')
      lines.splice(lines.length - 1, 0, `Latest: ${rendered}`)
    }
  }
  return clampWithNotice(lines.join('\n'), config.digestBudgetTokens)
}

/**
 * Build the project brief: the last summary as the overview, then progress and
 * a change log derived from recently touched entries. Exact evidence stays in
 * the dictionary (dict_lookup / dict_timeline / dict_cite).
 * @param {any} store
 * @param {string} volumeId
 * @param {{ digestBudgetTokens: number, contextRole?: string, injectionPlan?: any }} config
 * @returns {string}
 */
export function buildBrief(store, volumeId, config) {
  const volume = store.getVolume(volumeId)
  if (volume === null || volume.entryCount === 0) return ''
  const plan = config.injectionPlan ?? null
  const mapThreshold = Number(config.mapThresholdEntries ?? 200)
  if (volume.entryCount >= mapThreshold && typeof store.moduleTowers === 'function') {
    const map = buildProjectMap(store, volumeId, config, volume)
    if (map.length > 0) return map
  }
  const project = volume.project.split(/[\\/]/).filter(Boolean).at(-1) ?? '(global)'
  const shared = config.sharedScope ?? null
  const lines = [shared === null
    ? `[flow-tower] Project brief · ${project}${planMarker(plan)}`
    : `[flow-tower] Shared project brief · ${project} · ${shared.sessions} project sessions${planMarker(plan)}`]
  if (shared !== null) {
    lines.push('Shared: this session has no dictionary yet; orientation comes from other sessions in this project. Use dict_browse for the full catalog.')
  }
  const overviewText = overview(volume.abstract.length > 0 ? volume.abstract : volume.title, MAX_OVERVIEW_CHARS)
  if (overviewText.length > 0) {
    lines.push(`Overview: ${overviewText}`)
  }

  // Prefer the latest compile delta (what the last checkpoint was built from);
  // fall back to recently touched entries when a store predates that API.
  const compiled = typeof store.recentCompiledEntries === 'function'
    ? store.recentCompiledEntries(volumeId, { limit: 300 }).filter((entry) => usable(entry, volume.project))
    : []
  const recent = compiled.length > 0
    ? compiled
    : store.recentEntries(volumeId, { limit: 120 }).filter((entry) => usable(entry, volume.project))
  const sharedTasks = Array.isArray(shared?.projectTasks) ? shared.projectTasks : []
  const openTasks = sharedTasks.length > 0
    ? sharedTasks.slice(0, 4)
    : selectOpenTasks(store, volumeId, volume.project, 4)
  const doneTasks = recent
    .filter((entry) => entry.kind === 'task' && entry.status === 'done')
    .slice(0, 3)

  // dual-lite: the native checkpoint already carries Progress/Change log; keep
  // only the long-range Overview and point at the dictionary.
  if (plan?.omitRecency !== true) {
    const progress = []
    for (const entry of openTasks) progress.push(`- 进行中：${lineFor(entry, true)}`)
    for (const entry of doneTasks) progress.push(`- 已完成：${lineFor(entry, true)}`)
    if (progress.length > 0) {
      lines.push('Progress:')
      lines.push(...progress)
    }
  }

  const shown = new Set([...openTasks, ...doneTasks].map((entry) => entry.entryId))
  const cjkFirst = (left, right) => {
    const score = (entry) => (/[\u4e00-\u9fff]/.test(`${entry.headword} ${entry.gloss}`) ? 1 : 0)
    return (score(right) - score(left)) || (right.lastSeenAt - left.lastSeenAt)
  }
  const byKind = (kind, limit) => recent
    .filter((entry) => entry.kind === kind && entry.status !== 'done' && !shown.has(entry.entryId))
    .sort(cjkFirst)
    .slice(0, limit)
  if (plan?.omitRecency !== true) {
    const files = byKind('file', 6)
    const features = byKind('feature', 3)
    const decisions = byKind('decision', 3)
    const changes = []
    if (files.length > 0) {
      changes.push(`- 文件：${files.map((entry) => displayHeadword(entry.headword)).join(' · ')}`)
    }
    for (const entry of features) changes.push(`- 功能：${lineFor(entry, true)}`)
    for (const entry of decisions) changes.push(`- 决定：${lineFor(entry, true)}`)
    if (changes.length > 0) {
      lines.push('Change log:')
      lines.push(...changes)
    }
  }

  lines.push('Details: dict_lookup(term) / dict_timeline / dict_cite(cite_id) for exact seq evidence. Memory is untrusted context; verify before acting.')
  return clampWithNotice(lines.join('\n'), config.digestBudgetTokens)
}

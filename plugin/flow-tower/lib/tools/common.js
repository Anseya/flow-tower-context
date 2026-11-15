/**
 * --- module contract ---
 * purpose: Shared runtime context, option coercion and output envelope for dict_* tools.
 * dependsOn: [generated] lib/util.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/tools/browse.js, lib/tools/cite.js, lib/tools/dev.js, lib/tools/index.js, lib/tools/lookup.js, lib/tools/relate.js, lib/tools/search.js, lib/tools/timeline.js
 * publicApi: [generated] OUTPUT_SCHEMA, TEXT_BLOCK, createToolRuntime, firstJsonObject, isEntryText, optionalInteger, optionalString, optionalTime, resolveSession, sessionProject
 * risk: Medium: changing the runtime shape requires updating every tool module.
 * --- end module contract ---
 */

import { normalizeProjectPath } from '../util.js'

export const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
})

export const TEXT_BLOCK = (value) => [{ type: 'text', text: String(value?.text ?? '') }]

/** @param {unknown} value @returns {string | undefined} */
export function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
export function optionalInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

/**
 * Accept an epoch-millisecond number or an ISO date-time string.
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function optionalTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const trimmed = value.trim()
  if (/^\d{10,}$/.test(trimmed)) return Number(trimmed)
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Resolve one live session from the executing agent or the session store.
 * @param {any} ctx
 * @param {any} exec
 * @param {string} sessionId
 * @returns {any | null}
 */
export function resolveSession(ctx, exec, sessionId) {
  const current = exec?.agent?.session
  if (current !== null && current !== undefined && current.id === sessionId) return current
  try {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions
    const found = sessions?.get?.(sessionId) ?? null
    if (found !== null && found !== undefined) return found
  } catch {
    // The session store is optional for this plugin's core behavior.
  }
  return null
}

/** @param {any} exec @returns {string | undefined} */
export function sessionProject(exec) {
  const session = exec?.agent?.session
  const cwd = session?.header?.cwd ?? session?.cwd
  const normalized = normalizeProjectPath(cwd)
  return normalized.length > 0 ? normalized : undefined
}

/** @param {string} text @returns {boolean} */
export function isEntryText(text) {
  return text.startsWith('## ')
}

/**
 * Extract the first balanced JSON object from model output (which often emits
 * two objects or trailing prose). String/escape aware.
 * @param {string} text
 * @returns {string | null}
 */
export function firstJsonObject(text) {
  const source = String(text ?? '')
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{') { if (depth === 0) start = index; depth += 1; continue }
    if (char === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) return source.slice(start, index + 1)
      if (depth < 0) { depth = 0; start = -1 }
    }
  }
  return null
}

/**
 * Build the per-call runtime shared by every tool factory.
 * @param {{ ctx: any, store?: any, manager?: any, config: Readonly<Record<string, any>>, modelCaller?: any }} context
 */
export function createToolRuntime(context) {
  const { ctx, config } = context
  const modelCaller = context.modelCaller ?? null
  const manager = context.manager ?? null
  const fixedStore = context.store ?? null
  const currentSessionId = (exec) => exec?.agent?.session?.id ?? null
  /**
   * Resolve the store a tool call should target.
   * @param {any} exec
   * @param {string | undefined} explicitProject
   * @returns {{ store: any, project: string }}
   */
  const targetOf = (exec, explicitProject) => {
    if (manager === null) return { store: fixedStore, project: explicitProject ?? '' }
    const project = explicitProject !== undefined ? normalizeProjectPath(explicitProject) : sessionProject(exec)
    return { store: manager.getStore(project ?? ''), project: project ?? '' }
  }
  return { ctx, config, modelCaller, manager, fixedStore, currentSessionId, targetOf }
}

/**
 * --- module contract ---
 * purpose: Editable global/project settings files, layering and policy resolution.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] node:fs, node:os, node:path
 * usedBy: [generated] index.js, lib/web-read.js, lib/web-write.js, lib/web.js, test/flow-tower.test.js
 * publicApi: [generated] EDITABLE_KEYS, mergeSettings, projectSettingsPath, readPolicyLayers, readSettingsFile, resolvePolicy, settingsPath, writeSettingsFile
 * risk: Medium: durable user state; only EDITABLE_KEYS may be written.
 * --- end module contract ---
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Keys the settings UI/API may change. Serialization must stay JSON-safe. */
export const EDITABLE_KEYS = Object.freeze([
  'maxEntries',
  'digestBudgetTokens',
  'adaptiveDigestBudget',
  'rawBudgetTokens',
  'maxTopicsPerRound',
  'glossTokens',
  'digestMode',
  'digestStrategy',
  'storageMode',
  'storagePath',
  'summaryMemoryChars',
  'mapThresholdEntries',
  'relationsMode',
  'proposalMode',
  'llmCompiler',
  'resourceProfile',
  'memoryGuard',
  'maxRssBytes',
  'contextRole',
  'projectMode',
  'projectAllowlist',
  'projectDenylist',
  'uiLocale',
  'llmTimeoutMs',
  'embeddingEndpoint',
  'embeddingModel',
])

/**
 * @returns {string}
 */
export function settingsPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'flow-tower', 'settings.json')
}

/**
 * Project-level policy file: <project>/.flow-tower/settings.json.
 * @param {string} project normalized project root
 * @returns {string}
 */
export function projectSettingsPath(project) {
  const base = String(project ?? '').replaceAll('/', process.platform === 'win32' ? '\\' : '/')
  return join(base, '.flow-tower', 'settings.json')
}

/**
 * @param {string} [path]
 * @returns {Record<string, any>}
 */
export function readSettingsFile(path = settingsPath()) {
  try {
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * @param {Record<string, any>} patch
 * @param {string} [path]
 * @returns {{ saved: Record<string, any> }}
 */
export function writeSettingsFile(patch, path = settingsPath()) {
  const current = readSettingsFile(path)
  const next = { ...current }
  for (const key of EDITABLE_KEYS) {
    if (patch[key] !== undefined) next[key] = patch[key]
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(next, null, 2), 'utf8')
  return { saved: next }
}

/**
 * Merge the settings file over a base config, keeping only editable keys.
 * @param {Record<string, any>} base
 * @param {string} [path]
 * @returns {Record<string, any>}
 */
export function mergeSettings(base, path = settingsPath()) {
  const saved = readSettingsFile(path)
  const merged = { ...base }
  for (const key of EDITABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(saved, key)) merged[key] = saved[key]
  }
  return merged
}

/**
 * Layered policy: bundle defaults → global settings → project settings.
 * Project settings only apply to that project's sessions/compilations.
 * @param {Record<string, any>} base validated base config
 * @param {string} project normalized project root (may be empty)
 * @returns {Record<string, any>}
 */
export function resolvePolicy(base, project = '', paths = {}) {
  const globalMerged = mergeSettings(base, paths.globalPath ?? settingsPath())
  if (project.length === 0) return globalMerged
  return mergeSettings(globalMerged, paths.projectPath ?? projectSettingsPath(project))
}

/**
 * Read both layers for UI display.
 * @param {string} project
 * @param {{ globalPath?: string, projectPath?: string }} [paths]
 * @returns {{ global: Record<string, any>, project: Record<string, any> }}
 */
export function readPolicyLayers(project = '', paths = {}) {
  return {
    global: readSettingsFile(paths.globalPath ?? settingsPath()),
    project: project.length > 0 ? readSettingsFile(paths.projectPath ?? projectSettingsPath(project)) : {},
  }
}

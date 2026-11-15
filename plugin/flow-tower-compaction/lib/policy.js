/**
 * --- module contract ---
 * purpose: Project opt-out check for the compaction backend's memory injection.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] node:fs, node:os, node:path
 * usedBy: [generated] compaction/index.js
 * publicApi: [generated] projectAllowed
 * risk: Low: reads global settings; default allows the current project.
 * --- end module contract ---
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function norm(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function settingsPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'flow-tower', 'settings.json')
}

/**
 * @param {string} project
 * @returns {boolean}
 */
export function projectAllowed(project) {
  const root = norm(project)
  if (root.length === 0) return true
  let settings
  try {
    settings = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  } catch {
    return true
  }
  const mode = settings?.projectMode ?? 'current'
  if (mode === 'current' || mode === 'all') return true
  const list = Array.isArray(mode === 'allowlist' ? settings.projectAllowlist : settings.projectDenylist)
    ? (mode === 'allowlist' ? settings.projectAllowlist : settings.projectDenylist)
    : []
  const matched = list.some((entry) => {
    const candidate = norm(entry)
    return candidate.length > 0 && (root === candidate || root.startsWith(`${candidate}/`))
  })
  return mode === 'allowlist' ? matched : !matched
}

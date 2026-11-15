/**
 * --- module contract ---
 * purpose: Decide whether the memory layer is enabled for one project.
 * dependsOn: [generated] lib/util.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] index.js, lib/compiler.js, test/flow-tower.test.js
 * publicApi: [generated] projectEnabled
 * risk: Low: prefix-based policy; default is current-project-only.
 * --- end module contract ---
 */

import { normalizeProjectPath } from './util.js'

/**
 * @param {string} value
 * @returns {string}
 */
function normalized(value) {
  return normalizeProjectPath(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * @param {Record<string, any>} config
 * @param {string} project
 * @param {string} [currentProject] the project of the acting DSH session
 * @returns {boolean}
 */
export function projectEnabled(config, project, currentProject = '') {
  const root = normalized(project)
  if (root.length === 0) return true
  const mode = config?.projectMode ?? 'current'
  if (mode === 'all') return true
  if (mode === 'current') {
    const current = normalized(currentProject)
    return current.length === 0 ? true : root === current
  }
  const list = (mode === 'allowlist' ? config?.projectAllowlist : config?.projectDenylist) ?? []
  const matched = list.some((entry) => {
    const candidate = normalized(entry)
    if (candidate.length === 0) return false
    return root === candidate || root.startsWith(`${candidate}/`)
  })
  return mode === 'allowlist' ? matched : !matched
}

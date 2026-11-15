/**
 * --- module contract ---
 * purpose: Panel write routes: task close and settings/storage changes with migration.
 * dependsOn: [generated] lib/config.js, lib/manager.js, lib/settings.js, lib/web-common.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/web.js
 * publicApi: [generated] closeTask, handleWritePayload
 * risk: Medium: storage migration is side-effecting; a failed migration must not persist settings.
 * --- end module contract ---
 */

import { resolveConfig } from './config.js'
import { EDITABLE_KEYS, projectSettingsPath, resolvePolicy, settingsPath, writeSettingsFile } from './settings.js'
import { storageSnapshot, routeOf } from './web-common.js'

/**
 * Close one open task via the read/write panel API (the only write operation).
 * @param {import('./manager.js').StoreManager} manager
 * @param {string} project
 * @param {string} entryId
 * @param {number} [now]
 * @returns {{ ok: boolean, error?: string, entry?: any }}
 */
export function closeTask(manager, project, entryId, now = Date.now()) {
  try {
    const store = manager.getStore(project)
    const entry = store.getEntry(entryId)
    if (entry === null) return { ok: false, error: 'entry not found' }
    if (entry.kind !== 'task') return { ok: false, error: 'entry is not a task' }
    store.updateEntry(entryId, { status: 'done', statusSeq: Math.max(entry.statusSeq, 0) + 1 }, now)
    store.bumpVersion(entry.volumeId, now)
    store.rebuildGroups(entry.volumeId)
    return { ok: true, entry: store.getEntry(entryId) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Handle write requests (task close + settings).
 * @param {import('./manager.js').StoreManager} manager
 * @param {string} pathname
 * @param {any} payload
 * @param {{ onSettingsSaved?: (config: Record<string, any>) => void }} [options]
 * @returns {{ status: number, json: any }}
 */
export function handleWritePayload(manager, pathname, payload, options = {}) {
  const route = routeOf(pathname)
  if (route === '/api/task/close') {
    const project = typeof payload?.project === 'string' ? payload.project : ''
    const entryId = typeof payload?.entryId === 'string' ? payload.entryId : ''
    if (entryId.length === 0) return { status: 400, json: { error: 'entryId is required' } }
    const result = closeTask(manager, project, entryId)
    return { status: result.ok ? 200 : 400, json: result }
  }
  if (route === '/api/settings') {
    if (typeof payload?.settings !== 'object' || payload.settings === null) {
      return { status: 400, json: { error: 'settings object is required' } }
    }
    const scope = payload?.scope === 'project' ? 'project' : 'global'
    const project = typeof payload?.project === 'string' ? payload.project : ''
    if (scope === 'project' && project.length === 0) {
      return { status: 400, json: { error: 'project is required for project scope' } }
    }
    try {
      const base = resolvePolicy(manager.config, project)
      const patch = { ...payload.settings }
      // Storage location is a Host-wide decision; project-layer files can hold
      // retrieval overrides but must not silently fork where data lives.
      if (scope === 'project') {
        delete patch.storageMode
        delete patch.storagePath
        delete patch.summaryMemoryChars
      }
      const validated = resolveConfig({ ...base, ...patch })
      let migration = null
      if (scope === 'global') {
        const storageChanged = validated.storageMode !== base.storageMode
          || (validated.storagePath ?? null) !== (base.storagePath ?? null)
        if (storageChanged) {
          migration = manager.migrateStorageForProject(validated, project)
          if (migration.error !== undefined) {
            manager.setConfig(base)
            return {
              status: 400,
              json: {
                error: `storage switch failed: ${migration.error}`,
                storage: manager.storageSnapshot(project),
              },
            }
          }
        }
      }
      const targetPath = scope === 'project' ? projectSettingsPath(project) : settingsPath()
      const saved = writeSettingsFile(Object.fromEntries(EDITABLE_KEYS.map((key) => [key, validated[key]])), targetPath)
      try {
        options.onSettingsSaved?.(validated)
      } catch {
        // Settings are already durably saved; a live-refresh failure only means
        // this process keeps the previous runtime view until the plugin reloads.
      }
      return {
        status: 200,
        json: {
          ok: true,
          scope,
          path: targetPath,
          saved: saved.saved,
          storage: manager.storageSnapshot(project),
          ...(migration === null ? {} : { migration }),
          note: migration !== null && migration.migrated > 0
            ? `Saved; migrated ${migration.migrated} volume(s) to the new storage location (old database kept).`
            : 'Saved locally; runtime settings applied where possible.',
        },
      }
    } catch (error) {
      return { status: 400, json: { error: error instanceof Error ? error.message : String(error) } }
    }
  }
  return { status: 404, json: { error: `unknown write route ${route}` } }
}

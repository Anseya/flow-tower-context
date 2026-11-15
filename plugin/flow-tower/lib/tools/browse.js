/**
 * --- module contract ---
 * purpose: dict_browse tool: dictionary/catalog/tree exploration.
 * dependsOn: [generated] lib/catalog.js, lib/summary.js, lib/tools/common.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/tools/index.js
 * publicApi: [generated] createBrowseTool
 * risk: Low: read-only rendering through catalog/store APIs.
 * --- end module contract ---
 */

import { browseText, catalogFromStores, treeText } from '../catalog.js'
import { summaryTreeText } from '../summary.js'
import {
  OUTPUT_SCHEMA, TEXT_BLOCK, optionalInteger, optionalString, optionalTime,
} from './common.js'

/**
 * @param {ReturnType<import('./common.js').createToolRuntime>} runtime
 */
export function createBrowseTool(runtime) {
  const { manager, fixedStore, currentSessionId, targetOf } = runtime
  return {
    name: 'dict_browse',
    description: [
      'List the compiled conversation dictionary: headwords grouped by kind, filterable by project/module/task-status/time.',
      'By default this browses the current session volume (stored in the project folder); pass `catalog: true` for the union catalog of known project stores, `tree: true` for the volume hierarchy, `project` to focus one workspace, `module` to focus one code module.',
      'Use this when you do not know the exact term to look up, then use dict_lookup(term) or dict_search(query) for definitions.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        volume: { type: 'string', description: 'Volume id (usually a session id). Defaults to the current session volume.' },
        catalog: { type: 'boolean', description: 'When true, list known project stores and their volumes.' },
        tree: { type: 'boolean', description: 'When true, render the volume hierarchy (volume -> kind/module groups -> entries).' },
        project: { type: 'string', description: 'Optional project root path; its project dictionary is opened on demand.' },
        kind: {
          type: 'string',
          description: 'Optional kind filter: file, feature, api-symbol, decision, task, command, error, topic, chapter, person.',
        },
        prefix: { type: 'string', description: 'Optional headword prefix filter.' },
        status: { type: 'string', description: 'Optional task status filter: open or done.' },
        module: { type: 'string', description: 'Optional code-module prefix filter, e.g. src/compiler.' },
        since: { type: 'string', description: 'Optional lower time bound (ISO date-time or epoch ms) on last-seen time.' },
        until: { type: 'string', description: 'Optional upper time bound (ISO date-time or epoch ms) on last-seen time.' },
        limit: { type: 'integer', description: 'Maximum headwords per kind (default 40, max 100).' },
        include_abstract: { type: 'boolean', description: 'Include the volume abstract when browsing one volume.' },
      },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => TEXT_BLOCK(value) },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const explicitProject = optionalString(input.project)
      const explicitVolume = optionalString(input.volume)

      if (input.catalog === true) {
        if (manager === null) {
          return { text: browseText(fixedStore, { volumeId: null, project: explicitProject ?? null }) }
        }
        // Open the current project so an empty current project still appears once it has data.
        targetOf(exec, explicitProject)
        return { text: catalogFromStores(manager.openStores().map((item) => ({ project: item.project, store: item.store }))) }
      }

      let target = targetOf(exec, explicitProject)
      const volumeId = explicitVolume ?? currentSessionId(exec)
      if (input.tree === true) {
        if (target.store === null || target.store === undefined) return { text: 'No dictionary store is available for this project.' }
        const volume = volumeId ?? ''
        const summary = target.store.listSummaryNodes(volume).length > 0
          ? summaryTreeText(target.store, volume)
          : treeText(target.store, volume, { limit: optionalInteger(input.limit, 6, 1, 20) })
        return { text: summary }
      }
      if (manager !== null && explicitVolume !== undefined && target.store !== null
        && target.store.getVolume(explicitVolume) === null) {
        // Volume may belong to another open project store.
        for (const item of manager.openStores()) {
          if (item.store.getVolume(explicitVolume) !== null) {
            target = { store: item.store, project: item.project }
            break
          }
        }
      }
      if (target.store === null || target.store === undefined) return { text: 'No dictionary store is available for this project.' }
      const text = browseText(target.store, {
        volumeId,
        kind: optionalString(input.kind) ?? null,
        prefix: optionalString(input.prefix) ?? null,
        status: optionalString(input.status) ?? null,
        module: optionalString(input.module) ?? null,
        project: null,
        since: optionalTime(input.since),
        until: optionalTime(input.until),
        limit: optionalInteger(input.limit, 40, 1, 100),
        includeAbstract: input.include_abstract === true,
      })
      void target.project
      return { text }
    },
  }
}

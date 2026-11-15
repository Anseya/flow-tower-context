/**
 * --- module contract ---
 * purpose: dict_timeline tool: chronological dictionary view.
 * dependsOn: [generated] lib/catalog.js, lib/tools/common.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/tools/index.js
 * publicApi: [generated] createTimelineTool
 * risk: Low: read-only rendering.
 * --- end module contract ---
 */

import { timelineText } from '../catalog.js'
import {
  OUTPUT_SCHEMA, TEXT_BLOCK, optionalInteger, optionalString, optionalTime,
} from './common.js'

/**
 * @param {ReturnType<import('./common.js').createToolRuntime>} runtime
 */
export function createTimelineTool(runtime) {
  const { currentSessionId, targetOf } = runtime
  return {
    name: 'dict_timeline',
    description: [
      'Show the dictionary along the time axis: entries ordered by last-seen time (newest first), with kind, task status and code module.',
      'Use it for "what happened when", "what did we do recently", or when you do not know the headword but know roughly when it happened.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        volume: { type: 'string', description: 'Optional volume id. Defaults to the current session volume.' },
        project: { type: 'string', description: 'Optional project root path; overrides the current project.' },
        module: { type: 'string', description: 'Optional code-module prefix filter.' },
        kind: { type: 'string', description: 'Optional kind filter (file, feature, task, decision, error, ...).' },
        since: { type: 'string', description: 'Optional lower time bound (ISO date-time or epoch ms).' },
        until: { type: 'string', description: 'Optional upper time bound (ISO date-time or epoch ms).' },
        limit: { type: 'integer', description: 'Maximum entries (default 30, max 100).' },
      },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => TEXT_BLOCK(value) },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const explicitProject = optionalString(input.project)
      const volume = optionalString(input.volume) ?? (explicitProject === undefined ? currentSessionId(exec) : null)
      const target = targetOf(exec, explicitProject)
      if (target.store === null || target.store === undefined) return { text: 'No dictionary store is available for this project.' }
      const text = timelineText(target.store, {
        volumeId: volume,
        project: target.project.length > 0 ? target.project : null,
        module: optionalString(input.module) ?? null,
        kind: optionalString(input.kind) ?? null,
        since: optionalTime(input.since),
        until: optionalTime(input.until),
        now: Date.now(),
        limit: optionalInteger(input.limit, 30, 1, 100),
      })
      return { text }
    },
  }
}

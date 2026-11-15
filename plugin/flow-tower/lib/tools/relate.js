/**
 * --- module contract ---
 * purpose: dict_relate tool: typed relation listing with opportunistic fail-soft sync.
 * dependsOn: [generated] lib/relations.js, lib/tools/common.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/tools/index.js
 * publicApi: [generated] createRelateTool
 * risk: Medium: relation sync is a side effect and must never break the call.
 * --- end module contract ---
 */

import { nodeIdForEntry, nodeIdForVolume, relateText, syncRelations } from '../relations.js'
import {
  OUTPUT_SCHEMA, TEXT_BLOCK, optionalInteger, optionalString,
} from './common.js'

/**
 * @param {ReturnType<import('./common.js').createToolRuntime>} runtime
 */
export function createRelateTool(runtime) {
  const { config, currentSessionId, targetOf } = runtime
  return {
    name: 'dict_relate',
    description: [
      'Show typed, directional relations for one dictionary entry or volume: derivedFrom/cites/replaces/mergedFrom/parent/sibling (outgoing → and incoming ←).',
      'Use it to trace provenance, replacements, merges and cross-project links; all relations are read-only and evidence-backed where available.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'Entry headword to start from (e.g. a file, task, decision or person).' },
        node: { type: 'string', description: 'Explicit node id (e.g. e_…, v:<volume>, h:<session>:<seq>); overrides term.' },
        volume: { type: 'string', description: 'Optional volume id (defaults to the current session volume).' },
        project: { type: 'string', description: 'Optional project root path.' },
        direction: { type: 'string', description: 'both | outgoing | incoming (default both).' },
        minConfidence: { type: 'number', description: 'Optional minimum edge confidence 0..1 (e.g. 0.8 to hide weak relatedTo edges).' },
        limit: { type: 'integer', description: 'Maximum relations to list (default 30, max 100).' },
      },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => TEXT_BLOCK(value) },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      if (config.relationsMode === 'off') return { text: 'Relation graph is disabled (relationsMode=off).' }
      const target = targetOf(exec, optionalString(input.project))
      if (target.store === null || target.store === undefined) return { text: 'No dictionary store is available for this project.' }
      const volumeId = optionalString(input.volume) ?? currentSessionId(exec) ?? ''
      let nodeId = optionalString(input.node)
      const term = optionalString(input.term)
      if (nodeId === undefined && term !== undefined) {
        const entry = target.store.findEntryByWord(volumeId, term.toLowerCase())
          ?? target.store.searchRanked(term, { volumeId, limit: 1 })[0]?.entry
        if (entry !== null && entry !== undefined) nodeId = nodeIdForEntry(entry.entryId)
      }
      if (nodeId === undefined && volumeId.length > 0) nodeId = nodeIdForVolume(volumeId)
      if (nodeId === undefined) return { text: 'dict_relate needs `term`, `node` or a current session volume.' }
      if (volumeId.length > 0 && target.store.listEntries(volumeId, { limit: 1 }).length > 0) {
        const hasEdges = target.store.db.prepare(
          'SELECT 1 FROM relations WHERE from_volume = ? OR to_volume = ? LIMIT 1',
        ).get(volumeId, volumeId)
        if (hasEdges === undefined) {
          try {
            syncRelations(target.store, volumeId, {})
          } catch {
            // Fail-soft: relation building must not break tool calls.
          }
        }
      }
      const direction = optionalString(input.direction) === 'outgoing'
        ? 'outgoing'
        : optionalString(input.direction) === 'incoming' ? 'incoming' : 'both'
      return {
        text: relateText(target.store, nodeId, {
          direction,
          limit: optionalInteger(input.limit, 30, 1, 100),
          minConfidence: Number(input.minConfidence ?? 0) || 0,
        }),
      }
    },
  }
}

/**
 * --- module contract ---
 * purpose: dict_cite tool: exact original-message replay for one citation.
 * dependsOn: [generated] lib/raw.js, lib/session-read.js, lib/tools/common.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/tools/index.js
 * publicApi: [generated] createCiteTool
 * risk: Medium: depends on optional session-read services and must degrade to stored excerpts.
 * --- end module contract ---
 */

import { citationSeqs, renderSeqRange } from '../raw.js'
import { readSessionEvents, renderEvents } from '../session-read.js'
import {
  OUTPUT_SCHEMA, TEXT_BLOCK, optionalInteger, optionalString, resolveSession,
} from './common.js'

/**
 * @param {ReturnType<import('./common.js').createToolRuntime>} runtime
 */
export function createCiteTool(runtime) {
  const { ctx, config, manager, fixedStore } = runtime
  return {
    name: 'dict_cite',
    description: [
      'Replay the exact original messages behind one citation id (`c_...`) from dict_lookup.',
      'This is the only lossless source of truth; entries and digests are only an index over it.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        cite_id: { type: 'string', description: 'Citation id returned by dict_lookup, e.g. c_ab12cd34ef.' },
        max_tokens: { type: 'integer', description: 'Optional replay budget (default from config, max 48000).' },
      },
      required: ['cite_id'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => TEXT_BLOCK(value) },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const citeId = optionalString(input.cite_id)
      if (citeId === undefined) return { text: 'dict_cite failed: `cite_id` must be a non-empty string.' }
      let citation = null
      if (manager !== null) {
        const found = manager.findCitation(citeId)
        if (found !== null) citation = found.citation
      } else {
        citation = fixedStore?.getCitation(citeId) ?? null
      }
      if (citation === null) return { text: `Unknown citation id "${citeId}". Use dict_lookup(term) to see available ids.` }
      const liveSession = resolveSession(ctx, exec, citation.sessionId)
      const seqs = citationSeqs(citation)
      const maxTokens = optionalInteger(input.max_tokens, config.rawBudgetTokens, 200, 48000)

      const events = await readSessionEvents(ctx, citation.sessionId, liveSession)
      let rendered = null
      if (events !== null) rendered = renderEvents(events, seqs, { maxTokens })
      else if (liveSession !== null) rendered = renderSeqRange(liveSession, seqs, { maxTokens })

      if (rendered === null) {
        return {
          text: [
            `Citation ${citation.citeId} belongs to session "${citation.sessionId}", whose original log is not readable in this process.`,
            `Recorded span: seq ${citation.seqStart}-${citation.seqEnd}; excerpt: ${citation.excerpt || '(none)'}.`,
            'Open that session and retry to replay the verbatim text.',
          ].join('\n'),
        }
      }
      if (rendered.count === 0) {
        return { text: `Citation ${citation.citeId}: original events are no longer derivable (${rendered.missing} missing seqs).` }
      }
      const header = `# citation ${citation.citeId} · seq ${citation.seqStart}-${citation.seqEnd} · ${rendered.count} message(s)`
      return { text: `${header}\n${rendered.text}` }
    },
  }
}

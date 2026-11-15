/**
 * --- module contract ---
 * purpose: Dev-only shadow proposal probe and alias backfill tools.
 * dependsOn: [generated] lib/llm-prompt.js, lib/llm.js, lib/session-read.js, lib/tools/common.js, lib/util.js
 * externalDeps: [generated] node:fs, node:path
 * usedBy: [generated] lib/tools/index.js
 * publicApi: [generated] createDevTools
 * risk: Medium: explicit writes/shadow files; registered only when llmCompiler is on.
 * --- end module contract ---
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSessionEvents, projectEventMessage } from '../session-read.js'
import { contentToText } from '../util.js'
import { generateHostProposals } from '../llm.js'
import { repairModelJson } from '../llm-prompt.js'
import {
  OUTPUT_SCHEMA, TEXT_BLOCK, firstJsonObject, optionalInteger, optionalString,
} from './common.js'

/**
 * @param {ReturnType<import('./common.js').createToolRuntime>} runtime
 */
export function createDevTools(runtime) {
  const { ctx, config, modelCaller, targetOf } = runtime
  const shadowProbe = {
    name: 'dict_shadow_probe',
    description: 'Run one real host-LLM shadow compilation over recent messages of the current session (validated, never committed). Returns accepted/rejected counts, latency and sample proposals; for shadow-mode evaluation only.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Recent messages to sample (default 30, max 60).' },
        offset: { type: 'integer', description: 'Skip this many newest messages before sampling (for older windows; default 0).' },
      },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => TEXT_BLOCK(value) },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const session = exec?.agent?.session
      if (session === null || session === undefined || typeof session.id !== 'string') {
        return { text: 'dict_shadow_probe needs a current session.' }
      }
      const started = Date.now()
      let events
      try {
        events = await readSessionEvents(ctx, session.id, session)
      } catch (error) {
        return { text: `dict_shadow_probe cannot read the session log: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (!Array.isArray(events) || events.length === 0) return { text: 'dict_shadow_probe: no session events to sample.' }
      const limit = Math.max(1, Math.min(60, optionalInteger(input.limit, 30, 1, 60)))
      const offset = Math.max(0, Math.min(10000, optionalInteger(input.offset, 0, 0, 10000)))
      const samples = []
      for (const event of events) {
        const message = projectEventMessage(event)
        if (message === null || message === undefined) continue
        if (!['user', 'assistant', 'tool'].includes(message.role)) continue
        const text = contentToText(message.content)
        if (text.length === 0) continue
        samples.push({ seq: event.seq, text })
      }
      const recent = samples.slice(0, Math.max(0, samples.length - offset)).slice(-limit)
      if (recent.length === 0) return { text: 'dict_shadow_probe: no usable messages in the session.' }
      try {
        const proposal = await generateHostProposals({ callModel: modelCaller, samples: recent, config })
        const target = targetOf(exec, undefined)
        if (target.store !== null && target.store !== undefined) {
          target.store.recordMetric({
            volumeId: session.id,
            kind: 'llm-proposals',
            data: {
              mode: 'probe',
              accepted: proposal.entries.length,
              rejected: proposal.rejected.length,
              metaFiltered: proposal.metaFiltered ?? 0,
              committed: 0,
              ms: proposal.ms,
              samples: recent.length,
            },
            now: Date.now(),
          })
        }
        // Persist the shadow sample so precision can be evaluated later.
        try {
          if (target.project.length > 0) {
            const dir = join(target.project, '.flow-tower', 'shadow')
            mkdirSync(dir, { recursive: true })
            writeFileSync(join(dir, `shadow-${Date.now()}.json`), JSON.stringify({
              at: Date.now(),
              samples: recent.length,
              entries: proposal.entries,
              rejected: proposal.rejected,
              metaFiltered: proposal.metaFiltered ?? 0,
              ms: proposal.ms,
              diagnostics: modelCaller.lastDiagnostics ?? null,
            }, null, 2), 'utf8')
          }
        } catch {
          // Shadow persistence is best-effort.
        }
        const lines = [
          `Shadow probe (not committed): accepted=${proposal.entries.length} rejected=${proposal.rejected.length} metaFiltered=${proposal.metaFiltered ?? 0} ms=${proposal.ms} samples=${recent.length} total=${Date.now() - started}ms`,
        ]
        for (const entry of proposal.entries.slice(0, 12)) {
          lines.push(`- ${entry.kind} · ${entry.headword} · citations ${entry.citations.join(',')}`)
        }
        for (const rejection of proposal.rejected.slice(0, 5)) {
          lines.push(`  rejected[${rejection.index}]: ${rejection.reason}`)
        }
        lines.push(`  raw preview: ${JSON.stringify(String(proposal.raw ?? '').slice(0, 300))}`)
        lines.push(`  raw length=${String(proposal.raw ?? '').length} tail=${JSON.stringify(String(proposal.raw ?? '').slice(-120))}`)
        if (typeof modelCaller.lastDiagnostics === 'object' && modelCaller.lastDiagnostics !== null) {
          lines.push(`  model diagnostics: ${JSON.stringify(modelCaller.lastDiagnostics)}`)
        }
        lines.push('Shadow mode: nothing was written to the dictionary.')
        return { text: lines.join('\n') }
      } catch (error) {
        return { text: `dict_shadow_probe failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }

  const aliasBackfill = {
    name: 'dict_alias_backfill',
    description: 'Admin/backfill: use the host LLM to generate aliases for entries that have none and persist them (explicit write). Requires llmCompiler != off. Small batches, bounded by limit; aliases are indexed for retrieval.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Maximum entries to backfill this call (default 20, max 100).' },
        kind: { type: 'string', description: 'Optional kind filter (decision, feature, task, ...).' },
        volume: { type: 'string', description: 'Optional volume id; defaults to the first volume of the project store.' },
        project: { type: 'string', description: 'Optional project root path; overrides the current project.' },
      },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => TEXT_BLOCK(value) },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const limit = Math.max(1, Math.min(100, optionalInteger(input.limit, 20, 1, 100)))
      const explicitProject = optionalString(input.project)
      const target = targetOf(exec, explicitProject)
      if (target.store === null || target.store === undefined) return { text: 'No dictionary store is available for this project.' }
      const volumes = target.store.listVolumes({ ...(target.project.length > 0 ? { project: target.project } : {}), limit: 20 })
      const volumeId = optionalString(input.volume) ?? volumes[0]?.volumeId
      if (volumeId === undefined) return { text: 'No volume to backfill yet.' }
      const kind = optionalString(input.kind)
      const all = target.store.listEntries(volumeId, {
        ...(kind === undefined ? {} : { kind }),
        limit: 3000,
      })
      const missing = all.filter((entry) => !Array.isArray(entry.aliases) || entry.aliases.length === 0)
      const chosen = missing.slice(0, limit)
      if (chosen.length === 0) return { text: `dict_alias_backfill: all ${all.length} entries already have aliases.` }
      let updated = 0
      let failed = 0
      let lastError = ''
      const now = Date.now()
      for (let offset = 0; offset < chosen.length; offset += 10) {
        const batch = chosen.slice(offset, offset + 10)
        const payload = batch.map((entry) => ({ headword: entry.headword, kind: entry.kind, gloss: String(entry.gloss ?? '').slice(0, 240) }))
        const prompt = [
          'Generate short retrieval aliases for these project-dictionary entries.',
          'Return JSON only: {"aliases":[{"headword":"<exact headword>","aliases":["2-6 short aliases/synonyms/abbreviations"]}]}',
          'Use the same language as each headword; never include the headword itself; keep each alias 2-60 chars; no explanations.',
          `Entries: ${JSON.stringify(payload)}`,
        ].join('\n')
        try {
          const raw = await modelCaller(prompt)
          const cleaned = String(raw ?? '').replace(/```json/gi, '').replace(/```/g, '').trim()
          let parsed = null
          const jsonText = firstJsonObject(cleaned)
          if (jsonText !== null) {
            try { parsed = JSON.parse(jsonText) } catch { parsed = JSON.parse(repairModelJson(jsonText)) }
          } else {
            lastError = `no JSON object in model output: ${JSON.stringify(String(raw ?? '').slice(0, 220))}`
          }
          const rows = Array.isArray(parsed?.aliases) ? parsed.aliases : []
          if (rows.length === 0) lastError = `no aliases array: ${JSON.stringify(String(raw ?? '').slice(0, 220))}`
          const byWord = new Map()
          for (const row of rows) {
            if (typeof row?.headword === 'string' && Array.isArray(row.aliases)) byWord.set(row.headword.toLowerCase(), row.aliases)
          }
          if (rows.length > 0 && byWord.size === 0) lastError = `aliases rows missing headword/aliases: ${JSON.stringify(String(raw ?? '').slice(0, 220))}`
          for (const entry of batch) {
            const aliases = (byWord.get(entry.headword.toLowerCase()) ?? [])
              .filter((alias) => typeof alias === 'string')
              .map((alias) => alias.trim())
              .filter((alias) => alias.length >= 2 && alias.length <= 60 && alias.toLowerCase() !== entry.headword.toLowerCase())
              .slice(0, 8)
            if (aliases.length === 0) { failed += 1; continue }
            target.store.updateEntry(entry.entryId, { aliases: [...new Set(aliases)] }, now)
            updated += 1
          }
        } catch (error) {
          failed += batch.length
          lastError = error instanceof Error ? error.message : String(error)
        }
      }
      try {
        target.store.recordMetric({ volumeId, kind: 'alias-backfill', data: { requested: chosen.length, updated, failed, lastError }, now })
      } catch { /* metrics are best-effort */ }
      return { text: `dict_alias_backfill: updated=${updated} failed=${failed} requested=${chosen.length} (volume ${volumeId})${lastError ? `\nlast error: ${lastError}` : ''}` }
    },
  }

  return [shadowProbe, aliasBackfill]
}

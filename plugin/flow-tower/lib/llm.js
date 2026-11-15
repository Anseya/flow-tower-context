/**
 * --- module contract ---
 * purpose: Host LLM model caller for optional proposal/shadow work.
 * dependsOn: [generated] lib/llm-filter.js, lib/llm-prompt.js, lib/proposals.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] index.js, lib/compiler.js, lib/tools/dev.js, test/flow-tower.test.js
 * publicApi: [generated] createHostModelCaller, generateHostProposals
 * risk: Medium: optional network/LLM path; failures must fall back to deterministic compilation.
 * --- end module contract ---
 */

import { buildProposalPrompt, parseProposalJson } from './llm-prompt.js'
import { validateProposal } from './proposals.js'
import { filterMetaProposals } from './llm-filter.js'

/**
 * @param {any} ctx Cordis context
 * @param {{ provider?: string | null, model?: string | null, maxTokens?: number,
 *   timeoutMs?: number }} [options]
 * @returns {((prompt: string) => Promise<string>) | null}
 */
export function createHostModelCaller(ctx, options = {}) {
  let llm
  let defaultModel
  try {
    llm = typeof ctx?.get === 'function' ? ctx.get('llm') : ctx?.llm
    defaultModel = typeof ctx?.get === 'function'
      ? ctx.get('agentDefaultModel')?.currentSelection?.()
      : ctx?.agentDefaultModel?.currentSelection?.()
  } catch {
    return null
  }
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') return null
  const maxTokens = Math.min(32000, Math.max(64, options.maxTokens ?? 1000))
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 30000)

  return async function callModel(prompt) {
    let provider = options.provider ?? defaultModel?.provider
    let model = options.model ?? defaultModel?.model
    if (provider === undefined && typeof llm.listProviders === 'function') {
      const providers = await llm.listProviders()
      provider = providers?.[0]?.id
    }
    if (model === undefined && provider !== undefined && typeof llm.listModels === 'function') {
      const models = await llm.listModels(provider)
      model = models?.[0]?.id
    }
    if (provider === undefined || model === undefined) {
      throw new Error('no host LLM route is configured')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const diagnostics = { provider, model, maxTokens, chunkTypes: {}, textChars: 0, reasoningChars: 0, blockEnds: 0, finish: null }
    try {
      let text = ''
      for await (const chunk of llm.stream({
        provider,
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens,
        sessionId: options.sessionId,
        purpose: 'flow-tower-compile',
        signal: controller.signal,
      })) {
        const type = String(chunk?.type ?? 'unknown')
        diagnostics.chunkTypes[type] = (diagnostics.chunkTypes[type] ?? 0) + 1
        if (type === 'text-delta') {
          text += chunk.text
          diagnostics.textChars += String(chunk.text ?? '').length
        } else if (type === 'reasoning-delta') {
          diagnostics.reasoningChars += String(chunk.text ?? '').length
        } else if (type === 'block-end') {
          diagnostics.blockEnds += 1
          if (chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
            text += chunk.block.text
            diagnostics.textChars += chunk.block.text.length
          }
        } else if (type === 'finish') {
          diagnostics.finish = chunk.reason?.kind ?? String(chunk.reason ?? '')
        } else if (type === 'error') {
          throw new Error(chunk.failure?.message ?? 'LLM stream error')
        }
      }
      callModel.lastDiagnostics = diagnostics
      return text
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Generate validated LLM proposal entries for one compaction delta.
 * Citations must reference seqs that exist in the provided samples.
 * @param {{ callModel: (prompt: string) => Promise<string>, samples: { seq: number, text: string }[],
 *   config: any, existing?: string[] }} input
 * @returns {Promise<{ entries: any[], rejected: any[], raw: string, ms: number }>}
 */
export async function generateHostProposals(input) {
  const started = Date.now()
  const prompt = buildProposalPrompt(input.samples, {
    maxEntries: input.config.llmMaxEntries ?? 10,
    existing: input.existing,
  })
  const raw = await input.callModel(prompt)
  const parsed = parseProposalJson(raw)
  if (parsed === null) {
    return { entries: [], rejected: [{ index: -1, reason: 'model output is not JSON' }], raw, ms: Date.now() - started }
  }
  const allowed = new Set(input.samples.map((sample) => sample.seq))
  const validated = validateProposal(parsed, input.config)
  const entries = []
  const rejected = [...validated.rejected]
  validated.entries.forEach((entry, index) => {
    const citations = entry.citations.filter((seq) => allowed.has(seq))
    if (citations.length === 0) {
      rejected.push({ index, reason: 'citations do not reference the provided seqs' })
      return
    }
    entries.push({ ...entry, citations })
  })
  const meta = filterMetaProposals(entries)
  for (const entry of meta.filtered) {
    rejected.push({ index: -1, reason: `process-noise filtered: ${entry.headword}` })
  }
  return {
    entries: meta.kept,
    rejected,
    metaFiltered: meta.filtered.length,
    raw,
    ms: Date.now() - started,
  }
}

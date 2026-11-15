/**
 * --- module contract ---
 * purpose: dict_search tool: lexical, semantic-lite, embedding and smart search.
 * dependsOn: [generated] lib/catalog.js, lib/embeddings.js, lib/hybrid-search.js, lib/llm-search.js, lib/semantic.js, lib/tools/common.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/tools/index.js
 * publicApi: [generated] createSearchTool
 * risk: Medium: optional network/LLM paths must fall back to deterministic search.
 * --- end module contract ---
 */

import { searchText } from '../catalog.js'
import { semanticSearch } from '../semantic.js'
import { hybridSearch, matchesFilters, sortHits } from '../hybrid-search.js'
import { createEmbeddingProvider, embeddingSearch } from '../embeddings.js'
import { smartSearch } from '../llm-search.js'
import {
  OUTPUT_SCHEMA, TEXT_BLOCK, optionalInteger, optionalString,
} from './common.js'

/**
 * @param {ReturnType<import('./common.js').createToolRuntime>} runtime
 */
export function createSearchTool(runtime) {
  const { config, modelCaller, targetOf } = runtime
  return {
    name: 'dict_search',
    description: [
      'Ranked search over dictionary entries: use it when you remember roughly what the content said but not an exact headword.',
      'Default mode is hybrid: BM25-lite lexical hits fused with sparse TF-IDF/co-occurrence hits, plus exact/prefix/alias boosts (deterministic, no network). When an embedding provider is configured, embedding vectors are also available; `smart` adds DeepSeek rewrite+rerank.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, e.g. "时间轴 排序", "compaction cache", "韩立".' },
        volume: { type: 'string', description: 'Optional volume id; omitted searches the current project store.' },
        project: { type: 'string', description: 'Optional project root path; overrides the current project.' },
        kind: { type: 'string', description: 'Optional kind filter (file, feature, task, decision, error, chapter, person, ...).' },
        module: { type: 'string', description: 'Optional module prefix filter, e.g. "plugin/flow-tower".' },
        status: { type: 'string', description: 'Optional task status filter (open/done), only useful with kind=task.' },
        mode: { type: 'string', description: 'hybrid (default) | lexical | semantic. semantic uses sparse TF-IDF + co-occurrence; with an embedding endpoint it also uses real vectors.' },
        semantic: { type: 'boolean', description: 'Compatibility shortcut: when true, behaves like mode=semantic.' },
        smart: { type: 'boolean', description: 'DeepSeek-only semantic search: host LLM rewrites the query, then reranks merged BM25 candidates. No embedding model; one or two chat calls, slower but better semantics.' },
        sort: { type: 'string', description: 'relevance (default) | recent.' },
        scope: { type: 'string', description: 'entries (default) | summaries | both. Summaries search the 3-level summary tree labels/text (drill down with dict_browse tree).' },
        limit: { type: 'integer', description: 'Maximum hits (default 15, max 50).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => TEXT_BLOCK(value) },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const query = optionalString(input.query)
      if (query === undefined) return { text: 'dict_search failed: `query` must be a non-empty string.' }
      const explicitProject = optionalString(input.project)
      const target = targetOf(exec, explicitProject)
      if (target.store === null || target.store === undefined) return { text: 'No dictionary store is available for this project.' }
      const volume = optionalString(input.volume)
      const kind = optionalString(input.kind)
      const module = optionalString(input.module)
      const status = optionalString(input.status)
      const limit = optionalInteger(input.limit, 15, 1, 50)
      const mode = optionalString(input.mode) ?? (input.semantic === true ? 'semantic' : 'hybrid')
      const sort = input.sort === 'recent' ? 'recent' : 'relevance'
      const filters = {
        ...(module === undefined ? {} : { module }),
        ...(status === undefined ? {} : { status }),
      }
      const scopeOptions = {
        ...(volume === undefined ? {} : { volumeId: volume }),
        ...(target.project.length > 0 ? { project: target.project } : {}),
        ...(kind === undefined ? {} : { kind }),
      }
      let finalResults = []
      if (mode === 'semantic') {
        finalResults = semanticSearch(target.store, query, { ...scopeOptions, limit })
        if (typeof config?.embeddingEndpoint === 'string' && config.embeddingEndpoint.length > 0) {
          try {
            const provider = createEmbeddingProvider(config)
            if (provider !== null) {
              const embedded = await embeddingSearch(target.store, query, {
                provider,
                ...scopeOptions,
                limit,
              })
              if (embedded.length > 0) finalResults = embedded
            }
          } catch {
            // Embedding endpoint is optional; keep semantic-lite results.
          }
        }
      } else if (mode === 'lexical') {
        finalResults = target.store.searchRanked(query, { ...scopeOptions, limit })
      } else {
        finalResults = hybridSearch(target.store, query, { ...scopeOptions, ...filters, limit, sort }).results
      }
      finalResults = sortHits(finalResults.filter((hit) => matchesFilters(hit, filters)), sort).slice(0, limit)
      let smartMeta = null
      if (input.smart === true && typeof modelCaller === 'function') {
        try {
          const smart = await smartSearch(target.store, query, {
            callModel: modelCaller,
            ...(optionalString(input.volume) === undefined ? {} : { volumeId: optionalString(input.volume) }),
            ...(target.project.length > 0 ? { project: target.project } : {}),
            ...(optionalString(input.kind) === undefined ? {} : { kind: optionalString(input.kind) }),
            limit: optionalInteger(input.limit, 15, 1, 30),
          })
          if (smart.results.length > 0) {
            finalResults = smart.results
            smartMeta = smart
          }
        } catch {
          // Smart search is opt-in; keep deterministic results on failure.
        }
      }
      if (smartMeta !== null) {
        finalResults = sortHits(
          finalResults.filter((hit) => matchesFilters(hit, filters)),
          'relevance',
        ).slice(0, limit)
      }
      const scope = optionalString(input.scope) ?? 'entries'
      const summaryResults = scope === 'summaries' || scope === 'both'
        ? target.store.searchSummariesRanked(query, {
          ...(optionalString(input.volume) === undefined ? {} : { volumeId: optionalString(input.volume) }),
          ...(target.project.length > 0 ? { project: target.project } : {}),
          limit: optionalInteger(input.limit, 10, 1, 20),
        })
        : []
      let text = scope === 'summaries' ? '' : searchText(finalResults.map(({ entry, score, matched }) => ({ entry, score, matched })), query)
      if (smartMeta !== null && text.length > 0) {
        const prefix = [
          `DeepSeek smart search: rewrote query${smartMeta.expandedQueries.length > 0 ? ` → ${smartMeta.expandedQueries.slice(0, 5).join(' | ')}` : ''}${smartMeta.reranked ? ' · LLM reranked' : ''}`,
        ].join('\n')
        text = prefix + '\n' + text
      }
      if (summaryResults.length > 0) {
        const lines = ['## Summary matches']
        for (const { node, score } of summaryResults) {
          lines.push(`- ${node.label} (level ${node.level}, ${node.size} items, score ${score})`)
          if (node.summary.length > 0) lines.push(`  ${node.summary}`)
        }
        lines.push('Use dict_browse({tree:true}) to expand a summary node.')
        text = text.length > 0 ? `${text}\n\n${lines.join('\n')}` : lines.join('\n')
      }
      return { text: text.length > 0 ? text : `No matches for "${query}" in scope=${scope}.` }
    },
  }
}

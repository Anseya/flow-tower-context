/**
 * --- module contract ---
 * purpose: Read-only GET API routes for the panel.
 * dependsOn: [generated] lib/catalog.js, lib/hybrid-search.js, lib/llm-search.js, lib/manager.js, lib/relations.js, lib/resource-guard.js, lib/resources.js, lib/semantic.js, lib/settings.js, lib/summary.js, lib/web-common.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/web.js
 * publicApi: [generated] buildApiPayload
 * risk: Medium: route names and payload keys are the panel contract.
 * --- end module contract ---
 */

import {
  browseText, lookupText, searchText, timelineText, treeText, buildLegend,
} from './catalog.js'
import { summaryTreeText } from './summary.js'
import { semanticSearch } from './semantic.js'
import { hybridSearch, matchesFilters, sortHits } from './hybrid-search.js'
import { smartSearch } from './llm-search.js'
import { memoryState } from './resource-guard.js'
import { EDITABLE_KEYS, projectSettingsPath, readPolicyLayers, resolvePolicy, settingsPath } from './settings.js'
import { hardwareProfile } from './resources.js'
import {
  exportGraph, nodeIdForEntry, nodeIdForVolume, relateText,
  resolveNode, syncRelations, toDot, toMermaid,
} from './relations.js'
import {
  PLUGIN_VERSION, lastSummarizeRun, resolveStore, routeOf, storageSnapshot,
  taskContextCount, taskQuality,
} from './web-common.js'

/**
 * @param {import('./manager.js').StoreManager} manager
 * @param {string} pathname
 * @param {URLSearchParams} [query]
 * @returns {{ status: number, json: any }}
 */
export function buildApiPayload(manager, pathname, query = new URLSearchParams()) {
  const route = routeOf(pathname)
  const text = (value) => query.get(value) ?? ''
  try {
    if (route === '/api/catalog') {
      const projects = manager.openStores().map((item) => {
        const volumes = item.store.listVolumes({ limit: 500 }).map((volume) => ({
          volumeId: volume.volumeId,
          entryCount: volume.entryCount,
          project: volume.project,
          title: volume.title,
          updatedAt: volume.updatedAt,
        }))
        return { project: item.project, volumes }
      })
      return { status: 200, json: { projects, legend: buildLegend() } }
    }

    const { store, project } = resolveStore(manager, text('project'))
    if (store === null) {
      return { status: 503, json: { error: 'no dictionary store is available yet; compile some content first' } }
    }
    const volume = text('volume')
    const volumeId = volume.length > 0
      ? volume
      : store.listVolumes({ ...(project.length > 0 ? { project } : {}), limit: 1 })[0]?.volumeId

    if (route === '/api/browse') {
      const kind = text('kind')
      const module = text('module')
      const status = text('status')
      if (query.get('tree') === 'true') {
        const volume = volumeId ?? ''
        const text = store.listSummaryNodes(volume).length > 0 ? summaryTreeText(store, volume) : treeText(store, volume, { limit: 8 })
        return { status: 200, json: { text, project } }
      }
      return {
        status: 200,
        json: {
          text: browseText(store, {
            volumeId: volumeId ?? null,
            volumeId: volumeId ?? null,
            ...(kind.length > 0 ? { kind } : {}),
            ...(module.length > 0 ? { module } : {}),
            ...(status.length > 0 ? { status } : {}),
            ...(project.length > 0 ? { project } : {}),
            limit: Number(query.get('limit') ?? 100) || 100,
          }),
          project,
        },
      }
    }
    if (route === '/api/lookup') {
      const term = text('term')
      if (term.length === 0) return { status: 400, json: { error: 'term is required' } }
      const entry = store.findEntryByWord(volumeId ?? '', term.toLowerCase())
        ?? store.searchRanked(term, { ...(volumeId !== undefined ? { volumeId } : {}), limit: 1 })[0]?.entry
      return {
        status: 200,
        json: {
          text: lookupText(store, { term, volumeId: volumeId ?? null, ...(project.length > 0 ? { project } : {}) }),
          citations: entry === null || entry === undefined ? [] : store.citationsFor(entry.entryId),
          project,
        },
      }
    }
    if (route === '/api/search') {
      const q = text('q')
      if (q.length === 0) return { status: 400, json: { error: 'q is required' } }
      const limit = Math.max(1, Math.min(100, Number(query.get('limit') ?? 15) || 15))
      const scope = text('scope') || 'entries'
      const requestedMode = text('mode')
      const legacySemantic = query.get('semantic') === 'true'
      const mode = requestedMode === 'lexical' || requestedMode === 'semantic'
        ? requestedMode
        : (requestedMode === 'hybrid' ? 'hybrid' : (legacySemantic ? 'semantic' : 'hybrid'))
      const filters = {
        ...(text('kind').length > 0 ? { kind: text('kind') } : {}),
        ...(text('module').length > 0 ? { module: text('module') } : {}),
        ...(text('status').length > 0 ? { status: text('status') } : {}),
        ...(Number.isFinite(Number(query.get('since'))) && query.get('since') !== null ? { since: Number(query.get('since')) } : {}),
        ...(Number.isFinite(Number(query.get('until'))) && query.get('until') !== null ? { until: Number(query.get('until')) } : {}),
      }
      const sort = text('sort') === 'recent' ? 'recent' : 'relevance'
      const scopeOptions = {
        ...(volumeId !== undefined ? { volumeId } : {}),
        ...(project.length > 0 ? { project } : {}),
        ...(filters.kind !== undefined ? { kind: filters.kind } : {}),
      }
      const started = Date.now()
      let results = []
      let meta = { mode, timingMs: 0 }
      if (mode === 'hybrid') {
        const hybrid = hybridSearch(store, q, { ...scopeOptions, ...filters, limit, sort })
        results = hybrid.results
        meta = hybrid.meta
      } else if (mode === 'semantic') {
        results = sortHits(
          semanticSearch(store, q, { ...scopeOptions, limit: Math.max(limit * 3, 40) })
            .filter((hit) => matchesFilters(hit, filters))
            .map((hit) => ({ ...hit, sources: ['semantic'], reasons: [] })),
          sort,
        ).slice(0, limit)
        meta = { mode, timingMs: Date.now() - started }
      } else {
        results = sortHits(
          store.searchRanked(q, { ...scopeOptions, limit: Math.max(limit * 3, 40) })
            .filter((hit) => matchesFilters(hit, filters))
            .map((hit) => ({ ...hit, sources: ['lexical'], reasons: [] })),
          sort,
        ).slice(0, limit)
        meta = { mode, timingMs: Date.now() - started }
      }
      const summaryResults = (scope === 'summaries' || scope === 'both')
        ? store.searchSummariesRanked(q, {
          ...(volumeId !== undefined ? { volumeId } : {}),
          ...(project.length > 0 ? { project } : {}),
          limit,
        })
        : []
      return {
        status: 200,
        json: {
          project,
          mode: meta.mode,
          timingMs: meta.timingMs,
          total: results.length,
          results: results.map(({ entry, score, matched, sources, reasons }) => ({
            entryId: entry.entryId,
            headword: entry.headword,
            kind: entry.kind,
            status: entry.status,
            gloss: entry.gloss,
            module: entry.module,
            volumeId: entry.volumeId,
            lastSeenAt: entry.lastSeenAt,
            score,
            matched,
            sources,
            reasons,
          })),
          summaries: summaryResults,
          text: searchText(results, q),
        },
      }
    }
    if (route === '/api/export') {
      const volumeIds = store.listVolumes({ ...(project.length > 0 ? { project } : {}), limit: 1000 }).map((volume) => volume.volumeId)
      return {
        status: 200,
        json: {
          format: 'flow-tower.export.v1',
          exportedAt: Date.now(),
          project,
          volumes: volumeIds.map((id) => store.exportVolume(id)).filter(Boolean),
          relations: exportGraph(store),
        },
      }
    }
    if (route === '/api/timeline') {
      const limit = Number(query.get('limit') ?? 50) || 50
      return {
        status: 200,
        json: {
          project,
          entries: store.timelineEntries({
            ...(volumeId !== undefined ? { volumeId } : {}),
            ...(project.length > 0 ? { project } : {}),
            limit,
          }).map((entry) => ({
            entryId: entry.entryId,
            headword: entry.headword,
            kind: entry.kind,
            status: entry.status,
            module: entry.module,
            lastSeenAt: entry.lastSeenAt,
            volumeId: entry.volumeId,
          })),
          text: timelineText(store, {
            volumeId: volumeId ?? null,
            ...(project.length > 0 ? { project } : {}),
            limit,
          }),
        },
      }
    }
    if (route === '/api/tasks') {
      const volumeIds = volumeId !== undefined
        ? [volumeId]
        : store.listVolumes({ ...(project.length > 0 ? { project } : {}), limit: 200 }).map((item) => item.volumeId)
      const tasks = volumeIds
        .flatMap((id) => store.openTasks(id, 100))
        .map((entry) => ({
          entryId: entry.entryId,
          headword: entry.headword,
          kind: entry.kind,
          status: entry.status,
          module: entry.module,
          lastSeenAt: entry.lastSeenAt,
          volumeId: entry.volumeId,
          contextCount: taskContextCount(store, entry),
        }))
        .sort((left, right) => (taskQuality(right) - taskQuality(left)) || (right.lastSeenAt - left.lastSeenAt))
      return { status: 200, json: { project, tasks, focus: tasks[0] ?? null } }
    }
    if (route === '/api/graph') {
      const format = text('format') || 'json'
      const volume = volumeId ?? ''
      if (volume.length > 0) {
        const hasEdges = store.db.prepare(
          'SELECT 1 FROM relations WHERE from_volume = ? OR to_volume = ? LIMIT 1',
        ).get(volume, volume)
        if (hasEdges === undefined) {
          try {
            syncRelations(store, volume, {})
          } catch {
            // Fail-soft: graph building must not break the panel.
          }
        }
      }
      const baseGraph = query.get('scope') === 'all'
        ? (() => {
          const nodes = new Map()
          const edges = new Map()
          for (const item of manager.openStores()) {
            const part = exportGraph(item.store)
            for (const node of part.nodes) nodes.set(node.id, node)
            for (const edge of part.edges) edges.set(`${edge.fromId}|${edge.toId}|${edge.type}`, edge)
          }
          return {
            version: 'relations.v1',
            exportedAt: Date.now(),
            nodes: [...nodes.values()],
            edges: [...edges.values()],
          }
        })()
        : exportGraph(store, volume.length > 0 ? { volumeId: volume } : {})
      const minConfidence = Number(query.get('minConfidence') ?? 0) || 0
      const graph = minConfidence > 0
        ? { ...baseGraph, edges: baseGraph.edges.filter((edge) => Number(edge.confidence ?? 0) >= minConfidence) }
        : baseGraph
      if (format === 'dot') return { status: 200, json: { format, text: toDot(graph) } }
      if (format === 'mermaid') return { status: 200, json: { format, text: toMermaid(graph) } }
      return { status: 200, json: { format: 'json', graph } }
    }
    if (route === '/api/relate') {
      const explicitNode = text('node')
      const term = text('term')
      let nodeId = explicitNode.length > 0 ? explicitNode : undefined
      if (nodeId === undefined && term.length > 0) {
        const entry = store.findEntryByWord(volumeId ?? '', term.toLowerCase())
          ?? store.searchRanked(term, { volumeId: volumeId ?? undefined, limit: 1 })[0]?.entry
        if (entry !== null && entry !== undefined) nodeId = nodeIdForEntry(entry.entryId)
      }
      if (nodeId === undefined && volumeId !== undefined) nodeId = nodeIdForVolume(volumeId)
      if (nodeId === undefined) return { status: 400, json: { error: 'node or term is required' } }
      return {
        status: 200,
        json: { project, text: relateText(store, nodeId, { direction: text('direction') || 'both', limit: 30, minConfidence: Number(query.get('minConfidence') ?? 0) || 0 }), node: resolveNode(store, nodeId) },
      }
    }
    if (route === '/api/settings') {
      const project = query.get('project') ?? ''
      const effective = resolvePolicy(manager.config, project ?? '')
      const layers = readPolicyLayers(project)
      return {
        status: 200,
        json: {
          effective,
          file: layers.global,
          projectFile: layers.project,
          path: settingsPath(),
          projectPath: project.length > 0 ? projectSettingsPath(project) : null,
          project,
          editable: EDITABLE_KEYS,
          storage: storageSnapshot(effective, project),
          resources: hardwareProfile(),
          note: 'Bundle defaults → global settings → project settings. Saved changes apply immediately where possible; storage changes migrate the current project database.',
        },
      }
    }
    if (route === '/api/tree') {
      const volume = volumeId ?? ''
      const text = store.listSummaryNodes(volume).length > 0 ? summaryTreeText(store, volume) : treeText(store, volume, { limit: 8 })
      return { status: 200, json: { project, text } }
    }
    if (route === '/api/status') {
      const volumes = store.listVolumes({ limit: 500 })
      const relationRow = store.db.prepare(
        'SELECT COUNT(1) AS n FROM relations WHERE status = \'active\'',
      ).get()
      const injected = volumes.length > 0 ? store.getInjectedState(volumes[0].volumeId) : { injections: 0 }
      const config = resolvePolicy(manager.config, project)
      let lastInjection = null
      try {
        const metric = store.recentMetrics({ kind: 'digest-injection', limit: 1 })[0]
        if (metric !== undefined) lastInjection = { ...metric.data, at: metric.createdAt }
      } catch {
        // Optional metrics table on older databases.
      }
      let vectorCount = 0
      let aliasCount = 0
      try {
        vectorCount = Number(store.db.prepare('SELECT COUNT(1) AS n FROM entry_vectors').get()?.n ?? 0)
        aliasCount = Number(store.db.prepare("SELECT COUNT(1) AS n FROM entries WHERE aliases != '[]'").get()?.n ?? 0)
      } catch {
        // Optional vector table may be absent on a very old database.
      }
      const openTasks = volumes
        .flatMap((volume) => store.openTasks(volume.volumeId, 10))
        .filter((entry) => taskQuality(entry) >= 4)
        .sort((left, right) => (taskQuality(right) - taskQuality(left)) || (right.lastSeenAt - left.lastSeenAt))
      return {
        status: 200,
        json: {
          project,
          version: PLUGIN_VERSION,
          contextRole: config.contextRole,
          projectMode: config.projectMode,
          maxEntries: config.maxEntries,
          digestStrategy: config.digestStrategy,
          digestBudgetTokens: config.digestBudgetTokens,
          injectionMode: config.injectionMode,
          lastInjection,
          summaryMemoryChars: config.summaryMemoryChars,
          volumes: volumes.length,
          entries: volumes.reduce((sum, item) => sum + item.entryCount, 0),
          relations: Number(relationRow?.n ?? 0),
          injections: injected.injections ?? 0,
          openTaskCount: openTasks.length,
          focusTask: openTasks[0] === undefined ? null : {
            headword: openTasks[0].headword,
            module: openTasks[0].module,
            status: openTasks[0].status,
            lastSeenAt: openTasks[0].lastSeenAt,
            contextCount: taskContextCount(store, openTasks[0]),
          },
          semantic: {
            embeddingConfigured: typeof config.embeddingEndpoint === 'string' && config.embeddingEndpoint.length > 0,
            embeddingModel: config.embeddingModel ?? null,
            vectorCount,
            entriesWithAliases: aliasCount,
            llmCompiler: config.llmCompiler,
          },
          storage: storageSnapshot(config, project),
          lastSummarize: lastSummarizeRun(config, project),
          legend: buildLegend(),
        },
      }
    }
    return { status: 404, json: { error: `unknown route ${route}` } }
  } catch (error) {
    return { status: 500, json: { error: error instanceof Error ? error.message : String(error) } }
  }
}

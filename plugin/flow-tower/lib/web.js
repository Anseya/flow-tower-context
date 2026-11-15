/**
 * --- module contract ---
 * purpose: Host web-panel adapter: route prefix, static assets and request dispatch.
 * dependsOn: [generated] lib/catalog.js, lib/llm-search.js, lib/manager.js, lib/resource-guard.js, lib/session-read.js, lib/settings.js, lib/storage.js, lib/web-common.js, lib/web-page.js, lib/web-read.js, lib/web-write.js
 * externalDeps: [generated] node:fs, node:path
 * usedBy: [generated] index.js, test/compaction-storage.test.js, test/flow-tower.test.js
 * publicApi: [generated] ROUTE, buildApiPayload, closeTask, createWebHandler, handleWritePayload, routeOf
 * risk: Medium: the prefix must register exactly once per process; response shape is the panel contract.
 * --- end module contract ---
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAGE } from './web-page.js'
import { buildApiPayload } from './web-read.js'
import { handleWritePayload } from './web-write.js'
import { readJsonBody, resolveStore, ROUTE, routeOf } from './web-common.js'
import { readSessionEvents } from './session-read.js'
import { memoryState } from './resource-guard.js'
import { resolvePolicy } from './settings.js'
import { dshHome } from './storage.js'
import { searchText } from './catalog.js'
import { smartSearch } from './llm-search.js'

export { ROUTE, routeOf }
export { buildApiPayload, handleWritePayload }
export { closeTask } from './web-write.js'

/** Whitelisted static assets (mascot/onboarding images). */
const ASSETS = {
  'ok.jpg': new URL('../assets/ok.jpg', import.meta.url),
  'peek.jpg': new URL('../assets/peek.jpg', import.meta.url),
  'curious.jpg': new URL('../assets/curious.jpg', import.meta.url),
}

/** Smart-search memoization: one host-LLM query is expensive; the panel may repeat it. */
const SMART_CACHE = new Map()
const SMART_CACHE_TTL = 10 * 60 * 1000

/**
 * Create the HTTP handler registered on the host web server.
 * @param {{ manager: import('./manager.js').StoreManager, log?: any }} options
 * @returns {(req: any, res: any) => void}
 */
export function createWebHandler(options) {
  const { manager, ctx, modelCaller, onSettingsSaved } = options
  return (req, res) => {
    void (async () => {
      try {
        const url = new URL(req?.url ?? req?.originalUrl ?? '/', 'http://flow-tower.local')
        const route = routeOf(url.pathname)
        if (route === null) {
          res.statusCode = 404
          res.end('not found')
          return
        }
        if (route !== null && route.startsWith('/assets/')) {      const name = route.slice('/assets/'.length)
      const asset = ASSETS[name]
      if (asset === undefined) {
        res.statusCode = 404
        res.end('asset not found')
        return
      }
      try {
        const data = readFileSync(asset)
        res.statusCode = 200
        res.setHeader?.('content-type', 'image/jpeg')
        res.setHeader?.('cache-control', 'public, max-age=86400')
        res.end(data)
      } catch {
        res.statusCode = 404
        res.end('asset unreadable')
      }
      return
    }
    if (route === '/api/projects') {
      const projects = new Map()
      const add = (path, title, source, active) => {
        const root = normalizeProjectPath(path)
        if (root.length === 0) return
        const current = projects.get(root)
        if (current === undefined) {
          projects.set(root, { path: root, title: title || root.split(/[\\/]/).pop() || root, sources: [source], active: active === true })
        } else {
          if (!current.sources.includes(source)) current.sources.push(source)
          if (active === true) current.active = true
          if (!current.title && title) current.title = title
        }
      }
      try {
        const registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : ctx?.workspaceRegistry
        for (const workspace of registry?.list?.() ?? []) add(workspace.path, workspace.title, 'workspace', false)
      } catch { /* workspace service optional */ }
      try {
        const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : ctx?.agents
        for (const agent of agents?.list?.() ?? []) {
          const session = agent?.session
          add(session?.header?.cwd ?? session?.cwd, session?.header?.title, 'session', true)
        }
      } catch { /* agents service optional */ }
      for (const item of manager.openStores()) add(item.project, '', 'dictionary', true)
      const list = [...projects.values()]
      const current = list.find((item) => item.active)?.path ?? list[0]?.path ?? ''
      res.statusCode = 200
      res.setHeader?.('content-type', 'application/json; charset=utf-8')
      res.setHeader?.('cache-control', 'no-store')
      res.end(JSON.stringify({ projects: list, current }))
      return
    }
    if (route === '/api/smart-search') {
      const q = url.searchParams.get('q') ?? ''
      if (q.trim().length === 0) {
        res.statusCode = 400
        res.setHeader?.('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'q is required' }))
        return
      }
      if (typeof modelCaller !== 'function') {
        res.statusCode = 503
        res.setHeader?.('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'host LLM unavailable; use lexical search' }))
        return
      }
      const project = url.searchParams.get('project') ?? ''
      const resolved = resolveStore(manager, project)
      if (resolved.store === null) {
        res.statusCode = 503
        res.setHeader?.('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'no dictionary store is available yet' }))
        return
      }
      const volumeId = url.searchParams.get('volume') ?? resolved.store.listVolumes({ limit: 1 })[0]?.volumeId
      const kind = url.searchParams.get('kind') ?? undefined
      const limit = Math.max(1, Math.min(30, Number(url.searchParams.get('limit') ?? 15) || 15))
      try {
        const started = Date.now()
        const cacheKey = [project, volumeId ?? '', kind ?? '', q, limit].join('|')
        let smart
        let cached = false
        const cachedEntry = SMART_CACHE.get(cacheKey)
        if (cachedEntry !== undefined && Date.now() - cachedEntry.at < SMART_CACHE_TTL) {
          smart = cachedEntry.value
          cached = true
        } else {
          smart = await smartSearch(resolved.store, q, {
            callModel: modelCaller,
            ...(volumeId === undefined ? {} : { volumeId }),
            ...(project.length > 0 ? { project } : {}),
            ...(kind === undefined ? {} : { kind }),
            limit,
          })
          SMART_CACHE.set(cacheKey, { at: Date.now(), value: smart })
          if (SMART_CACHE.size > 50) SMART_CACHE.delete(SMART_CACHE.keys().next().value)
        }
        res.statusCode = 200
        res.setHeader?.('content-type', 'application/json; charset=utf-8')
        res.setHeader?.('cache-control', 'no-store')
        res.end(JSON.stringify({
          project,
          mode: 'smart',
          cached,
          timingMs: Date.now() - started,
          total: smart.results.length,
          smart: { expandedQueries: smart.expandedQueries, reranked: smart.reranked },
          results: smart.results.map(({ entry, score, matched }) => ({
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
            sources: ['smart'],
            reasons: [],
          })),
          summaries: [],
          text: searchText(smart.results, q),
        }))
      } catch (error) {
        res.statusCode = 502
        res.setHeader?.('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: `smart search failed: ${error instanceof Error ? error.message : String(error)}` }))
      }
      return
    }
    if (route === '/api/cite') {
      const citeId = url.searchParams.get('cite_id') ?? ''
      if (citeId.length === 0) {
        res.statusCode = 400
        res.setHeader?.('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'cite_id is required' }))
        return
      }
      const found = manager.findCitation(citeId)
      if (found === null) {
        res.statusCode = 404
        res.setHeader?.('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'citation not found' }))
        return
      }
      let text = ''
      try {
        if (ctx !== undefined && ctx !== null) {
          const events = await readSessionEvents(ctx, found.citation.sessionId, null)
          if (Array.isArray(events)) {
            text = renderEvents(events, [found.citation.seqStart], { maxTokens: 4000 })
          }
        }
      } catch (error) {
        text = ''
      }
      if (typeof text !== 'string' || text.trim().length === 0) {
        text = `[citation ${citeId}] ${found.citation.excerpt || '(source session not available; stored excerpt is empty)'}`
      }
      res.statusCode = 200
      res.setHeader?.('content-type', 'application/json; charset=utf-8')
      res.setHeader?.('cache-control', 'no-store')
      res.end(JSON.stringify({ citeId, citation: found.citation, text }))
      return
    }
    if (route === '/' || route === '') {
          res.statusCode = 200
          res.setHeader?.('content-type', 'text/html; charset=utf-8')
          res.setHeader?.('cache-control', 'no-store, no-cache, must-revalidate')
          res.end(PAGE)
          return
        }
        if (route.startsWith('/api/') && req?.method === 'POST') {
          const payload = await readJsonBody(req)
          const result = handleWritePayload(manager, url.pathname, payload, { onSettingsSaved })
          res.statusCode = result.status
          res.setHeader?.('content-type', 'application/json; charset=utf-8')
          res.setHeader?.('cache-control', 'no-store')
          res.end(JSON.stringify(result.json))
          return
        }
        if (route.startsWith('/api/')) {
          if (req?.method !== undefined && req.method !== 'GET') {
            res.statusCode = 405
            res.end('method not allowed')
            return
          }
          const payload = buildApiPayload(manager, url.pathname, url.searchParams)
          if (url.pathname === '/flow-tower/api/status' && payload.json !== null && typeof payload.json === 'object') {
            try {
              const service = ctx?.get?.('compaction')
              payload.json.compactionBackend = service === undefined || service === null
                ? 'missing'
                : (service.constructor?.name || typeof service)
              const policy = service?.config
              payload.json.compactionPolicy = policy === undefined || policy === null
                ? null
                : {
                    thresholdRatio: policy.thresholdRatio,
                    retainRatio: policy.retainRatio,
                    headroomTokens: policy.headroomTokens,
                    maxTokens: policy.maxTokens,
                    compactionRetries: policy.compactionRetries,
                    maxOverflowRetries: policy.maxOverflowRetries,
                    auto: policy.auto,
                  }
              const summarizeSource = typeof service?.summarize === 'function' ? String(service.summarize) : ''
              const runLogPath = typeof payload.json.storage?.dir === 'string'
                ? join(payload.json.storage.dir, 'compaction-runs.jsonl')
                : null
              const engineDebugLog = join(dshHome(), 'flow-tower', 'compaction-engine-debug.log')
              // The compaction service visible from this Context is a host-plane
              // wrapper: protected subclass hooks are hidden behind bindings, so
              // `summarizeSource` proves nothing either way. The session-scoped
              // provider leaves two files behind instead: the engine debug log and
              // the run log. Surface both so a reader can verify the engine really
              // ran inside the session instead of trusting the host-plane probe.
              let engineDebug = null
              try {
                if (existsSync(engineDebugLog)) {
                  const lines = readFileSync(engineDebugLog, 'utf8')
                    .split('\n')
                    .filter((line) => line.trim().length > 0)
                  const lastStart = [...lines].reverse().find((line) => line.includes('summarize start')) ?? null
                  const lastRecord = [...lines].reverse().find((line) => line.includes('run recorded')) ?? null
                  engineDebug = {
                    lines: lines.length,
                    lastStart: lastStart === null ? null : lastStart.slice(0, 240),
                    lastRecord: lastRecord === null ? null : lastRecord.slice(0, 240),
                  }
                }
              } catch { engineDebug = null }
              const lastSummarize = payload.json.lastSummarize
              payload.json.compactionDiagnostics = {
                service: service === undefined || service === null ? 'missing' : (service.constructor?.name ?? typeof service),
                // The provider mounted on this Context may differ from the one a
                // preset-scoped session uses; treat this as host-plane evidence only.
                hostPlaneOnly: true,
                // `undefined` means the Host service surface hides protected
                // subclass hooks; it does not prove the hook is absent at runtime.
                summarizeType: typeof service?.summarize,
                summarizeHasFlowMemory: summarizeSource.includes('FlowTower project memory'),
                summarizeMentionsBasic: summarizeSource.includes('summarizeWithLlm'),
                runLogPath,
                runLogExists: runLogPath === null ? false : existsSync(runLogPath),
                engineDebugLog,
                engineDebugExists: existsSync(engineDebugLog),
                engineDebug,
                // True only when both session-plane proofs line up: the engine wrote
                // a summarize start line and the run log recorded project memory.
                sessionEngineVerified: engineDebug?.lastStart !== null
                  && engineDebug?.lastStart !== undefined
                  && Number(lastSummarize?.memoryChars ?? 0) > 0,
                lastEngineMemoryChars: lastSummarize?.memoryChars ?? null,
                lastEngineSource: lastSummarize?.engine ?? lastSummarize?.source ?? null,
              }
            } catch (error) {
              payload.json.compactionBackend = `error:${error instanceof Error ? error.message : String(error)}`
            }
            try {
              const currentProject = payload.json.project ?? manager.openStores()[0]?.project ?? ''
              payload.json.memoryGuard = memoryState(resolvePolicy(manager.config, currentProject))
              payload.json.deferredSeqs = manager.openStores().reduce((sum, item) => (
                sum + (typeof item.store.countAllDeferredSeqs === 'function' ? item.store.countAllDeferredSeqs() : 0)
              ), 0)
            } catch { /* diagnostics are best-effort */ }
          }
          res.statusCode = payload.status
          res.setHeader?.('content-type', 'application/json; charset=utf-8')
          res.setHeader?.('cache-control', 'no-store')
          res.end(JSON.stringify(payload.json))
          return
        }
        res.statusCode = 404
        res.end('not found')
      } catch (error) {
        try {
          res.statusCode = 500
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        } catch {
          // Response already closed.
        }
      }
    })()
  }
}

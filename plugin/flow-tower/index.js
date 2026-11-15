/**
 * --- module contract ---
 * purpose: Plugin composition root: registers events, tools, digest injection, compaction integration and the web panel on the Host context.
 * dependsOn: [generated] lib/adaptive-budget.js, lib/catalog.js, lib/compaction-context.js, lib/compaction-evidence.js, lib/compaction-wrapper.js, lib/compiler.js, lib/config.js, lib/host-utils.js, lib/injection-policy.js, lib/llm.js, lib/maintenance.js, lib/manager.js, lib/project-policy.js, lib/resource-guard.js, lib/resources.js, lib/session-read.js, lib/settings.js, lib/tools.js, lib/util.js, lib/web.js
 * externalDeps: [generated] node:crypto
 * usedBy: [generated] test/apply.test.js
 * publicApi: [generated] LEGEND_SECTION, apply, inject, name
 * risk: High: owns Host lifecycle/event ordering; keep orchestration here, delegate behavior to lib modules, and protect with apply tests.
 * --- end module contract ---
 */

import { createHash, randomUUID } from 'node:crypto'
import { resolveConfig } from './lib/config.js'
import { makeLogger, effectOf } from './lib/host-utils.js'
import { StoreManager } from './lib/manager.js'
import { Compiler } from './lib/compiler.js'
import { buildToolDefinitions } from './lib/tools.js'
import { buildDigest, buildLegend, buildSharedDigest } from './lib/catalog.js'
import { augmentCompactionRequest } from './lib/compaction-context.js'
import { recordCompactionRun } from './lib/compaction-evidence.js'
import { wrapCompactionService } from './lib/compaction-wrapper.js'
import { readSessionEvents } from './lib/session-read.js'
import { contentToText, estimateTokens, normalizeProjectPath } from './lib/util.js'
import { runMaintenance } from './lib/maintenance.js'
import { adaptDigestBudget } from './lib/adaptive-budget.js'
import { classifyTask, detectCheckpoint, resolveInjectionPlan } from './lib/injection-policy.js'
import { createWebHandler, ROUTE as WEB_ROUTE } from './lib/web.js'
import { createHostModelCaller } from './lib/llm.js'
import { mergeSettings, resolvePolicy } from './lib/settings.js'
import { projectEnabled } from './lib/project-policy.js'
import { memoryUnderPressure } from './lib/resource-guard.js'
import { hardwareProfile } from './lib/resources.js'

/** Plugin name used by the loader and by injected message sources. */
export const name = 'flow-tower'

/** Host services required before activation; `systemPrompt` is optional. */
export const inject = ['tools']

/** System-prompt section id for the stable usage legend. */
export const LEGEND_SECTION = 'flow-tower:legend'

/** Assembly order for the legend: after team policy (600), before PTC (800). */
const LEGEND_ORDER = 700

/**
 * Upper bound on durable digest messages per compaction cycle. Injected user
 * messages are durable and never replaced by the host, so the live transcript
 * needs a cap; a compaction replaces that transcript, so the budget restarts
 * there (see `resetInjectionBudget`). Without the reset a long marathon session
 * would silently stop injecting project memory once the lifetime counter hit
 * the cap - the failure mode is invisible in status.
 */
const MAX_DIGEST_INJECTIONS = 40

/**
 * Activate the plugin.
 * @param {any} ctx Cordis context
 * @param {Record<string, unknown>} [rawConfig] row config from `cordis.patch.yml`
 */
export function apply(ctx, rawConfig) {
  const log = makeLogger(ctx)
  const buildConfig = () => resolveConfig(mergeSettings(resolveConfig(rawConfig)))
  let config
  try {
    config = buildConfig()
  } catch (error) {
    log.error('invalid configuration; plugin inactive', error)
    return
  }

  const manager = new StoreManager({ config, log })
  const configFor = (project) => resolvePolicy(config, project)
  effectOf(ctx, () => () => manager.closeAll(), 'flow-tower:stores')

  // One-time migration of the legacy global database into project folders.
  // It only applies to the legacy single-db layout, not to user-selected
  // global/custom storage.
  if ((config.storageMode ?? 'project') === 'project'
    && (typeof config.dbPath !== 'string' || config.dbPath.length === 0)) {
    try {
      const migration = manager.migrateLegacy()
      if (migration.migrated > 0 || migration.failed > 0) {
        log.info(`legacy storage migration: migrated=${migration.migrated} failed=${migration.failed}`)
      }
    } catch (error) {
      log.warn('legacy storage migration skipped', error)
    }
  }

  // ---------------------------------------------------------------- observe
  // Always create the host model caller when the host LLM service exists:
  // DeepSeek-only smart search/rerank does not require llmCompiler to be on.
  const modelCaller = createHostModelCaller(ctx, {
    provider: config.llmProvider,
    model: config.llmModel,
    maxTokens: config.llmMaxTokens,
    timeoutMs: config.llmTimeoutMs,
  })
  if (config.llmCompiler !== 'off' && modelCaller === null) {
    log.warn('llmCompiler is enabled but the host LLM service is unavailable; falling back to deterministic compilation')
  }
  const compiler = new Compiler({
    storeFor: (session) => manager.projectStore(session).store,
    config,
    configFor,
    log,
    modelCaller,
    readEvents: (sessionId, live) => readSessionEvents(ctx, sessionId, live),
  })
  /** Start time per session so the summary event can record real duration. */
  const compactionStarts = new Map()
  /**
   * Restart the per-volume injection budget. A compaction replaces the live
   * transcript, so previously injected durable messages are gone and the cap
   * must not keep counting them: otherwise a session that compacts often hits
   * MAX_DIGEST_INJECTIONS and silently stops receiving project memory.
   * @param {any} session
   */
  const resetInjectionBudget = (session) => {
    try {
      const volumeId = typeof session?.id === 'string' ? session.id : ''
      if (volumeId.length === 0) return
      const store = manager.projectStore(session).store
      if (store === null || store === undefined) return
      const state = store.getInjectedState(volumeId)
      if (state === null || state === undefined || Number(state.version) < 0 || Number(state.injections) <= 0) return
      store.setInjectedState(volumeId, { ...state, injections: 0 })
    } catch {
      // Budget bookkeeping must never break compaction handling.
    }
  }
  effectOf(
    ctx,
    () => ctx.on('session/event', (session, event) => {
      try {
        if (event?.type === 'compaction/start') {
          compactionStarts.set(session?.id, {
            time: Number(event.time) || Date.now(),
            compactionId: String(event.data?.compactionId ?? ''),
          })
          return
        }
        if (event?.type === 'compaction/summary') {
          compiler.ingest(session, event)
          resetInjectionBudget(session)
          const started = compactionStarts.get(session?.id)
          compactionStarts.delete(session?.id)
          const data = event.data ?? {}
          recordCompactionRun({
            config,
            project: normalizeProjectPath(session?.header?.cwd ?? ''),
            entry: {
              source: 'event',
              ok: true,
              ms: started === undefined ? null : Math.max(0, Number(event.time) - started.time),
              compactionId: String(data.compactionId ?? started?.compactionId ?? ''),
              summaryChars: contentToText(data.summary).length,
              compactedSeqs: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : null,
              backend: (() => {
                try {
                  return ctx.get?.('compaction')?.constructor?.name ?? null
                } catch {
                  return null
                }
              })(),
            },
          })
          return
        }
        if (event?.type === 'compaction/end') {
          compactionStarts.delete(session?.id)
          return
        }
        if (config.cacheTelemetry && event?.type === 'assistant/message') {
          const usage = event.data?.usage
          if (usage !== null && typeof usage === 'object') {
            const store = manager.projectStore(session).store
            store?.recordMetric({
              volumeId: session?.id ?? null,
              kind: 'usage',
              data: {
                inputTokens: Number(usage.inputTokens ?? 0),
                outputTokens: Number(usage.outputTokens ?? 0),
                cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
                cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
                totalTokens: usage.totalTokens === undefined ? null : Number(usage.totalTokens),
              },
            })
          }
        }
      } catch (error) {
        log.warn('session event handling failed', error)
      }
    }),
    'flow-tower:events',
  )

  // Settings saved from the panel apply without a plugin reload where possible:
  // rebuild the layered config, swap the manager's storage view and refresh the
  // compiler's config. LLM route changes still need a reload.
  const refreshConfig = () => {
    try {
      const next = buildConfig()
      config = next
      manager.setConfig(next)
      compiler.config = next
      return next
    } catch (error) {
      log.error('settings reload failed; keeping previous configuration', error)
      return config
    }
  }

  // ---------------------------------------------------------------- tools
  try {
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
    if (tools !== null && typeof tools?.register === 'function') {
      // Project-aware config view: each tool execution resolves the policy for
      // its target project (bundle → global → project settings).
      let activeProject = ''
      const configProxy = new Proxy({}, {
        get: (_target, key) => (configFor(activeProject) ?? config)[key],
      })
      for (const definition of buildToolDefinitions({ ctx, manager, config: configProxy, log, modelCaller })) {
        const originalExecute = definition.execute
        const wrapped = {
          ...definition,
          execute: async (args, exec) => {
            const explicit = typeof args?.project === 'string' ? args.project : ''
            const session = exec?.agent?.session
            activeProject = explicit.length > 0
              ? normalizeProjectPath(explicit)
              : normalizeProjectPath(session?.header?.cwd ?? session?.cwd)
            const currentProject = normalizeProjectPath(session?.header?.cwd ?? session?.cwd)
            if (!projectEnabled(configFor(activeProject), activeProject, currentProject)) {
              return { text: 'flow-tower is disabled for this project; DSH default context is in use.' }
            }
            return originalExecute(args, exec)
          },
        }
        effectOf(ctx, () => tools.register(wrapped), `flow-tower:tool:${definition.name}`)
      }
    } else {
      log.warn('tools service unavailable; dictionary tools were not registered')
    }
  } catch (error) {
    log.warn('tool registration failed', error)
  }

  // ------------------------------------------------------------ web panel
  // Register the HTTP route once per process and swap the handler on reload.
  // Re-registering a prefix route on every HMR apply leaves the old handler in
  // place (and can 404 after startup when webServer is not ready yet).
  try {
    const webStateKey = Symbol.for('flow-tower.web.state')
    const webState = globalThis[webStateKey] ?? (globalThis[webStateKey] = { current: null, installed: false, retry: null })
      const handler = createWebHandler({ manager, log, ctx, modelCaller, onSettingsSaved: refreshConfig })
      webState.current = handler
    const installWeb = (attempt = 0) => {
      const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer
      if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') {
        if (attempt < 60) {
          webState.retry = setTimeout(() => installWeb(attempt + 1), 250)
        } else {
          log.info('webServer service unavailable; read-only web panel not registered')
        }
        return
      }
      try {
        effectOf(ctx, () => webServer.register({
          kind: 'prefix',
          path: WEB_ROUTE,
          handler: (req, res) => {
            const current = webState.current
            if (typeof current !== 'function') {
              res.statusCode = 503
              res.setHeader?.('content-type', 'text/plain; charset=utf-8')
              res.end('flow-tower is reloading')
              return
            }
            current(req, res)
          },
        }), 'flow-tower:web:dispatcher')
        webState.installed = true
        log.info(`read-only web panel: ${WEB_ROUTE}`)
      } catch (error) {
        // A duplicate prefix route means an older handler still owns the path;
        // let the next process restart replace it. Keep retrying is useless.
        webState.installed = true
        log.warn(`web panel route already registered: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    installWeb()
    // Clear the live handler when this plugin fiber disposes; the route itself
    // is removed by the registered effect disposer when available.
    effectOf(ctx, () => () => { webState.current = null }, 'flow-tower:web:state')
  } catch (error) {
    log.warn('web panel registration failed', error)
  }

  // ------------------------------------------------- summary prompt bridge
  // Phase 1 compaction integration: keep the host backend, but give the
  // compaction summarizer the project memory digest. This is an observation-
  // side prompt enrichment, not a replacement backend.
  try {
    effectOf(ctx, () => typeof ctx.on === 'function' && ctx.on('llm/stream', (options, next) => {
      try {
        if (options?.purpose === 'compaction' && config.compactionSummaryContext !== false) {
          // The dedicated backend injects memory in summarize(); if its marker
          // is already in the request, this bridge must not duplicate it. When
          // the marker is absent we fall back to the digest so an engine hook
          // regression cannot silently disable all project memory.
          let backendName = ''
          try {
            backendName = ctx.get?.('compaction')?.constructor?.name ?? ''
          } catch { /* service optional */ }
          const hasFlowMemory = (Array.isArray(options.messages) ? options.messages : []).some((message) => {
            try {
              return contentToText(message?.content).includes('Flow Tower project memory')
            } catch {
              return false
            }
          })
          if (!hasFlowMemory) {
            const sessionId = typeof options.sessionId === 'string' ? options.sessionId : ''
            if (sessionId.length > 0) {
              for (const item of manager.openStores()) {
                const volume = item.store.getVolume(sessionId)
                if (volume === null) continue
                const policy = configFor(item.project)
                const digest = buildDigest(item.store, sessionId, policy)
                augmentCompactionRequest(options, { digest })
                recordCompactionRun({
                  config,
                  project: item.project,
                  entry: {
                    source: 'llm-stream',
                    ok: true,
                    memoryChars: digest.length,
                    injectedMessages: 1,
                    backend: backendName || null,
                  },
                })
                break
              }
            }
          }
        }
      } catch (error) {
        log.warn(`compaction summary context skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    }, 'flow-tower:compaction-summary-context'), 'flow-tower:compaction-summary-context')
  } catch (error) {
    log.warn('compaction summary bridge unavailable', error)
  }

  // --------------------------------------------- compaction backend wrapper
  // Phase 1b-lite: delegate to the host's BasicCompactionEngine and record
  // trigger/latency metrics. Full backend replacement needs a separate TS
  // package with @deepseek-ai dependencies; this wrapper is the runnable step.
  try {
    const compactionService = typeof ctx.get === 'function' ? ctx.get('compaction') : ctx.compaction
    const handle = wrapCompactionService(compactionService, {
      log,
      onEvent: (event) => {
        try {
          log.info(`compaction wrapped: method=${event.method} ok=${event.ok} ms=${event.ms}${event.error ? ` error=${event.error}` : ''}`)
        } catch { /* ignore */ }
      },
    })
    if (handle !== null) {
      log.info(`compaction backend wrapped (delegating): ${handle.methods.join(',')}`)
      effectOf(ctx, () => () => handle.restore(), 'flow-tower:compaction-wrapper')
    }
  } catch (error) {
    log.info(`compaction wrapper unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // --------------------------------------------------------------- legend
  let legendMounted = false
  /** @param {any} scoped */
  const mountLegend = (scoped) => {
    if (legendMounted) return
    try {
      const prompt = scoped?.systemPrompt
        ?? (typeof scoped?.get === 'function' ? scoped.get('systemPrompt') : undefined)
      if (prompt === null || typeof prompt?.section !== 'function') return
      legendMounted = true
      effectOf(ctx, () => prompt.section({
        name: LEGEND_SECTION,
        order: LEGEND_ORDER,
        text: () => (manager.openStores().some((item) => item.store.hasVolumes()) ? buildLegend() : ''),
      }), 'flow-tower:legend')
    } catch (error) {
      log.warn('legend section registration failed', error)
    }
  }
  const directPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : ctx.systemPrompt
  if (directPrompt !== null && typeof directPrompt?.section === 'function') mountLegend(ctx)
  else if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['systemPrompt'], mountLegend)
    } catch (error) {
      log.warn('systemPrompt injection failed', error)
    }
  }

  // Digest injection is version-gated, but a plugin upgrade can change the
  // digest format without moving the dictionary version. Recompute once per
  // volume per process so a new brief/map format is delivered after restart,
  // then fall back to the cheap version gate.
  const digestChecked = new Set()
  /** Injection plans already recorded as skipped, keyed by volume+version+mode. */
  const skippedPlans = new Set()
  /** Projects repaired once per process (historical noise + module attribution). */
  const maintained = new Set()

  /**
   * Record one skipped injection plan (metrics only, no prompt change).
   * @param {any} store
   * @param {{ volumeId: string, version: number, plan: any, pressure: any, sessionConfig: any, scope?: string }} input
   */
  const recordInjectionSkip = (store, { volumeId, version, plan, pressure, sessionConfig, scope = 'volume' }) => {
    const skipKey = `${volumeId}:${version}:${plan.mode}:${scope}`
    if (skippedPlans.has(skipKey)) return
    skippedPlans.add(skipKey)
    try {
      store.recordMetric({
        volumeId,
        kind: 'digest-injection',
        data: {
          skipped: true,
          mode: plan.mode,
          taskKind: plan.taskKind,
          checkpointAgeTurns: plan.checkpointAgeTurns,
          reason: plan.reason,
          pressureTokens: pressure?.pressureTokens ?? null,
          contextWindow: pressure?.contextWindow ?? null,
          strategy: sessionConfig.digestStrategy,
          scope,
        },
        now: Date.now(),
      })
    } catch { /* metrics are best-effort */ }
  }

  /**
   * Persist one digest injection cursor and return the user message to append.
   * Returns null when the version/hash says the digest is already present or the
   * per-volume injection cap is reached.
   * @param {any} store
   * @param {{ volumeId: string, stateKey: string, version: number, text: string, budget: number,
   *   plan: any, pressure: any, sessionConfig: any, scope?: string, sessions?: number | null }} input
   * @returns {any | null}
   */
  const commitDigest = (store, {
    volumeId, stateKey, version, text, budget, plan, pressure, sessionConfig, scope = 'volume', sessions = null,
  }) => {
    const state = store.getInjectedState(stateKey)
    const firstCheck = !digestChecked.has(stateKey)
    digestChecked.add(stateKey)
    if (!firstCheck && state.version >= version) return null
    const digestHash = createHash('sha1').update(text).digest('hex').slice(0, 16)
    if (digestHash === state.digestHash || state.injections >= MAX_DIGEST_INJECTIONS) {
      store.setInjectedState(stateKey, { ...state, version, digestHash })
      return null
    }
    store.setInjectedState(stateKey, { version, digestHash, injections: state.injections + 1 })
    try {
      store.recordMetric({
        volumeId,
        kind: 'digest-injection',
        data: {
          tokens: estimateTokens(text),
          chars: text.length,
          budget,
          pressureTokens: pressure?.pressureTokens ?? null,
          contextWindow: pressure?.contextWindow ?? null,
          strategy: sessionConfig.digestStrategy,
          mode: plan?.mode ?? 'legacy',
          taskKind: plan?.taskKind ?? null,
          checkpointAgeTurns: plan?.checkpointAgeTurns ?? null,
          budgetScale: plan?.budgetScale ?? 1,
          reason: plan?.reason ?? null,
          scope,
          sessions,
        },
        now: Date.now(),
      })
    } catch { /* metrics are best-effort */ }
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
    }
  }

  // ---------------------------------------------------------------- digest
  // Injected user messages are durable and never replaced or deduplicated by the
  // host, so injection is bounded: first step of a turn, content-hash deduped,
  // and at most MAX_DIGEST_INJECTIONS per volume.
  effectOf(
    ctx,
    () => typeof ctx.on === 'function' && ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
      const decision = await next()
      try {
        if (config.digestMode === 'off') return decision
        if (decision === null || decision === undefined || decision.kind === 'reject') return decision
        if (step !== 1) return decision
        if (signal !== undefined && signal.aborted) return decision
        const session = agent?.session
        if (session === null || session === undefined || typeof session.id !== 'string') return decision
        const stored = manager.projectStore(session)
        const store = stored.store
        if (store === null) return decision
        const sessionConfig = configFor(stored.project)
        if (!projectEnabled(sessionConfig, stored.project)) return decision
        if (memoryUnderPressure(sessionConfig)) return decision
        const volumeId = session.id
        const volume = store.getVolume(volumeId)
        const ownVolume = volume !== null && volume.entryCount > 0 ? volume : null

        // Pressure and the task plan are computed before the volume check so a
        // shared project digest (subagent/new session) follows the same policy.
        let pressure = null
        let budget = sessionConfig.digestBudgetTokens
        if (sessionConfig.adaptiveDigestBudget !== false) {
          try {
            pressure = ctx.get?.('tokenMeter')?.contextPressure?.(session) ?? null
            budget = adaptDigestBudget(budget, pressure?.pressureTokens, pressure?.contextWindow)
          } catch { /* keep the configured budget */ }
        }
        // Classify the current work phase, detect whether the native DSH
        // checkpoint is still fresh, then decide whether the long-range digest
        // adds information or just duplicates the checkpoint. A policy failure
        // must degrade to the previous full-digest behavior.
        let plan = null
        try {
          const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
          const checkpoint = detectCheckpoint(messages)
          const taskKind = classifyTask(messages)
          const ratio = pressure !== null
            && Number.isFinite(pressure.contextWindow)
            && Number(pressure.contextWindow) > 0
            ? Number(pressure.pressureTokens) / Number(pressure.contextWindow)
            : null
          plan = resolveInjectionPlan({ config: sessionConfig, checkpoint, taskKind, pressureRatio: ratio })
        } catch { plan = null }
        const effectiveBudget = plan !== null
          ? Math.max(400, Math.round(budget * (Number(plan.budgetScale) || 1)))
          : budget

        // Agent sessions (subagents, forks, brand-new sessions) share the project
        // store but own no volume until their first compaction. Without this
        // fallback a child agent would see no project memory at all.
        if (ownVolume === null) {
          if (plan !== null && plan.inject !== true) {
            recordInjectionSkip(store, { volumeId, version: 0, plan, pressure, sessionConfig, scope: 'shared' })
            return decision
          }
          let projectVersion = 0
          let sessions = 0
          try {
            const volumes = store.listVolumes({ limit: 200 })
              .filter((item) => normalizeProjectPath(item.project) === stored.project)
            sessions = volumes.length
            projectVersion = volumes.reduce((max, item) => Math.max(max, Number(item.updatedAt) || 0), 0)
          } catch { /* hash dedupe still protects */ }
          const shared = buildSharedDigest(store, stored.project, {
            ...sessionConfig,
            digestBudgetTokens: effectiveBudget,
            injectionPlan: plan,
          })
          if (shared.length === 0) return decision
          const message = commitDigest(store, {
            volumeId,
            stateKey: `${volumeId}#project`,
            version: projectVersion,
            text: shared,
            budget: effectiveBudget,
            plan,
            pressure,
            sessionConfig,
            scope: 'shared',
            sessions,
          })
          if (message === null) return decision
          const messages = Array.isArray(decision.messages) ? decision.messages : []
          return { ...decision, messages: [...messages, message] }
        }

        // One non-blocking repair pass per project per process: archive cited
        // digest/tool noise and attribute modules to previously module-less work
        // items. A version bump from the repair re-injects on the next turn.
        if (!maintained.has(stored.project)) {
          maintained.add(stored.project)
          void Promise.resolve().then(() => {
            const report = runMaintenance(store, volumeId, { project: stored.project })
            if (report.archived.length > 0 || report.attributed > 0) {
              log.info(`maintenance: archived=${report.archived.length} modules=${report.attributed}`)
            }
          }).catch((error) => {
            log.warn(`maintenance failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        }
        if (plan !== null && plan.inject !== true) {
          recordInjectionSkip(store, { volumeId, version: ownVolume.version, plan, pressure, sessionConfig })
          return decision
        }
        const text = buildDigest(store, volumeId, {
          ...sessionConfig,
          digestBudgetTokens: effectiveBudget,
          injectionPlan: plan,
        })
        if (text.length === 0) return decision
        const message = commitDigest(store, {
          volumeId,
          stateKey: volumeId,
          version: ownVolume.version,
          text,
          budget: effectiveBudget,
          plan,
          pressure,
          sessionConfig,
          scope: 'volume',
        })
        if (message === null) return decision
        const messages = Array.isArray(decision.messages) ? decision.messages : []
        return { ...decision, messages: [...messages, message] }
      } catch (error) {
        log.warn('digest injection failed', error)
        return decision
      }
    }, { prepend: true }),
    'flow-tower:digest',
  )

  log.info(`ready: storageMode=${config.storageMode}${config.storagePath ? ` storagePath=${config.storagePath}` : config.dbPath ? ` dbPath=${config.dbPath}` : ' project=<cwd>/.flow-tower/flow_tower.db'} · digest=${config.digestStrategy}/${config.digestBudgetTokens}t · injection=${config.injectionMode} · summaryMemory=${config.summaryMemoryChars}c · profile=${hardwareProfile().profile} maxEntries=${config.maxEntries}`)
}

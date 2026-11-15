/**
 * --- module contract ---
 * purpose: Ingest compaction summaries and compile their shadowed raw events into dictionary candidates.
 * dependsOn: [generated] lib/compiler-samples.js, lib/extract.js, lib/llm.js, lib/lock.js, lib/project-policy.js, lib/proposals.js, lib/relations.js, lib/resource-guard.js, lib/summary.js, lib/topics.js, lib/util.js, lib/vocabulary.js
 * externalDeps: [generated] node:crypto
 * usedBy: [generated] eval/long-session-eval.mjs, eval/offline-eval.mjs, eval/real-session-eval.mjs, eval/search-recall.mjs, eval/stress-long-session.mjs, eval/txt-corpus-eval.mjs, index.js, test/flow-tower.test.js
 * publicApi: [generated] Compiler
 * risk: Medium: idempotent delta compilation and memory-pressure deferral; must never break the conversation.
 * --- end module contract ---
 */

import { createHash } from 'node:crypto'
import { extractCandidates } from './extract.js'
import { ingestCandidates } from './vocabulary.js'
import { samplesForDelta } from './compiler-samples.js'
import { extractTopics } from './topics.js'
import { projectEnabled } from './project-policy.js'
import { memoryUnderPressure } from './resource-guard.js'
import { processProposals, commitProposalEntries } from './proposals.js'
import { generateHostProposals } from './llm.js'
import { syncRelations } from './relations.js'
import { withLock } from './lock.js'
import { rebuildSummaryTree } from './summary.js'
import { clampChars, contentToText, normalizeProjectPath, normalizeWhitespace } from './util.js'

const SKIPPED_SOURCE_KINDS = new Set([
  'flow-tower',
  'time-context',
  'runtime-context',
  'system-prompt',
])

const ABSTRACT_MAX_CHARS = 1200
const TITLE_MAX_CHARS = 80

/** @param {any} content @returns {string} */
function summaryText(content) {
  return contentToText(content)
}

export class Compiler {
  /**
   * @param {{
   *   store?: any,
   *   storeFor?: (session: any) => any | null,
   *   config: Readonly<Record<string, any>>,
   *   log: { info: (message: string) => void, warn: (message: string) => void },
   *   readEvents?: (sessionId: string, liveSession: any) => Promise<any[] | null>,
   * }} options
   */
  constructor(options) {
    this.fixedStore = options.store ?? null
    this.storeFor = options.storeFor ?? (() => this.fixedStore)
    this.config = options.config
    this.configFor = options.configFor ?? null
    this.log = options.log
    this.readEvents = options.readEvents
    /** Optional host-LLM caller: async (prompt) => text. Only used when llmCompiler != off. */
    this.modelCaller = options.modelCaller ?? null
    /** @type {Map<string, Promise<void>>} */
    this.queues = new Map()
    /** @type {Map<string, Set<number>>} seqs deferred while Host memory is high */
    this.deferred = new Map()
  }

  /**
   * Keep only messages the dictionary should index (skip harness context
   * snapshots and this plugin's own injected digests).
   * @param {any} message
   * @returns {boolean}
   */
  #shouldSample(message) {
    const sourceKind = message?.source?.kind
    if (typeof sourceKind === 'string' && SKIPPED_SOURCE_KINDS.has(sourceKind)) return false
    if (message?.source?.form === 'snapshot') return false
    return true
  }

  /**
   * Queue one observed compaction summary for compilation. Never throws.
   * @param {{ id: string, header?: { cwd?: string }, cwd?: string }} session
   * @param {{ type?: string, data?: any, time?: number }} event
   */
  ingest(session, event) {
    try {
      if (event?.type !== 'compaction/summary') return
      const data = event.data
      if (data === null || typeof data !== 'object' || !Array.isArray(data.shadowedSeqs)) return
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      const previous = this.queues.get(sessionId) ?? Promise.resolve()
      const next = previous
        .then(() => this.#compile(session, event))
        .catch((error) => {
          this.log.warn(`compile failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        })
      this.queues.set(sessionId, next)
      void next.finally(() => {
        if (this.queues.get(sessionId) === next) this.queues.delete(sessionId)
      })
    } catch (error) {
      this.log.warn(`ingest failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Wait until all queued compilations settle. Used by tests and diagnostics;
   * a normal plugin run never awaits this.
   * @returns {Promise<void>}
   */
  async drain() {
    for (let round = 0; round < 50; round += 1) {
      const pending = [...this.queues.values()]
      if (pending.length === 0) return
      await Promise.allSettled(pending)
    }
  }

  /**
   * Compile one compaction's delta into the vocabulary.
   * @param {any} session
   * @param {{ data?: any, time?: number }} event
   */
  async #compile(session, event) {
    const store = this.storeFor(session)
    if (store === null || store === undefined) {
      this.log.warn(`no dictionary store for session ${session?.id ?? '?'}; skipping compile`)
      return
    }
    const data = event.data
    const sessionId = session.id
    const volumeId = sessionId
    const now = typeof event.time === 'number' ? event.time : Date.now()
    const cwd = session.header?.cwd ?? session.cwd ?? ''
    const project = normalizeProjectPath(cwd)
    const config = typeof this.configFor === 'function' ? this.configFor(project) : this.config
    if (!projectEnabled(config, project)) {
      this.log.info(`flow-tower disabled for project ${project}; using DSH default context`)
      return
    }
    store.ensureVolume({ volumeId, scope: project.length > 0 ? `project:${project}` : 'global', project, now })

    const abstractText = clampChars(normalizeWhitespace(summaryText(data.summary)), ABSTRACT_MAX_CHARS)
    const title = clampChars(abstractText.split(/[。！？.!?\n]/)[0] ?? '', TITLE_MAX_CHARS)
    const volumeBefore = store.getVolume(volumeId)

    const allSeqs = data.shadowedSeqs
      .map((seq) => Number(seq))
      .filter((seq) => Number.isSafeInteger(seq) && seq >= 0)
    const seqs = [...new Set(allSeqs)].sort((a, b) => a - b)
    const covered = store.coveredSeqs(sessionId)
    let delta = seqs.filter((seq) => !covered.has(seq))
    const deferred = typeof store.listDeferredSeqs === 'function'
      ? store.listDeferredSeqs(volumeId)
      : [...(this.deferred.get(volumeId) ?? [])]
    if (deferred.length > 0) {
      delta = [...new Set([...delta, ...deferred])]
        .filter((seq) => !covered.has(seq))
        .sort((a, b) => a - b)
    }

    if (memoryUnderPressure(config)) {
      let queued = 0
      if (typeof store.addDeferredSeqs === 'function') {
        queued = store.addDeferredSeqs(volumeId, delta, now)
      } else {
        const pending = this.deferred.get(volumeId) ?? new Set()
        for (const seq of delta) pending.add(seq)
        while (pending.size > 2000) pending.delete(pending.values().next().value)
        this.deferred.set(volumeId, pending)
        queued = pending.size
      }
      this.log.warn(`flow-tower compile deferred for ${project}: host memory above ${config.maxRssBytes} bytes; ${queued} seqs queued`)
      return
    }

    // Read the raw evidence before taking the write lock (reads are harmless and
    // can be slow for very large deltas).
    let samples = []
    if (delta.length > 0) {
      try {
        samples = await this.#samplesForDelta(session, delta)
      } catch (error) {
        this.log.warn(`delta sampling failed for ${volumeId}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }

    // Optional host-LLM shadow compilation: bounded, validated, never replaces
    // the deterministic path. Generated before the write lock (pure I/O).
    let llmProposal = null
    if (config.llmCompiler !== 'off' && typeof this.modelCaller === 'function' && samples.length > 0) {
      try {
        llmProposal = await generateHostProposals({
          callModel: this.modelCaller,
          samples,
          config: config,
        })
      } catch (error) {
        this.log.warn(`host LLM proposal failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const deltaHash = createHash('sha1')
      .update(`${String(data.compactionId ?? '')}\u0000${delta.join(',')}`)
      .digest('hex')
      .slice(0, 16)
    const runId = `r_${createHash('sha1').update(`${volumeId}\u0000${deltaHash}`).digest('hex').slice(0, 12)}`

    const apply = () => {
      const runStarted = store.beginRun({
        runId,
        volumeId,
        compactionId: String(data.compactionId ?? ''),
        deltaHash,
        now,
      })
      if (!runStarted) {
        this.#updateVolumeAbstract(store, volumeId, title, abstractText, now)
        return
      }

      let stats = { created: 0, updated: 0, skipped: 0, citations: 0, tasksOpened: 0, tasksDone: 0 }
      try {
        if (samples.length > 0) {
          const maxCandidates = Math.min(config.maxEntries, Math.max(400, samples.length * 6))
          const candidates = extractCandidates(samples, { maxGlossChars: 200, project, maxCandidates })
          stats = ingestCandidates(store, {
            volumeId,
            sessionId,
            candidates,
            now,
            config: config,
          })
          const topics = extractTopics(samples, {
            maxTopics: config.maxTopicsPerRound ?? 20,
          })
          if (topics.length > 0) {
            const topicStats = ingestCandidates(store, {
              volumeId,
              sessionId,
              candidates: topics,
              now,
              config: config,
            })
            stats.created += topicStats.created
            stats.updated += topicStats.updated
            stats.citations += topicStats.citations
            stats.evicted += topicStats.evicted
            stats.skipped += topicStats.skipped
            stats.entryIds = [...(stats.entryIds ?? []), ...(topicStats.entryIds ?? [])]
          }
        }

        this.#updateVolumeAbstract(store, volumeId, title, abstractText, now)
        // Optional LLM proposals: shadow records audit only; on commits through
        // the same validated store path before rebuilds.
        let llmCommitted = 0
        if (llmProposal !== null) {
          try {
            if (config.llmCompiler === 'on' && llmProposal.entries.length > 0) {
              const committed = commitProposalEntries(store, volumeId, llmProposal.entries, {
                now,
                maxCiteExcerptChars: config.maxCiteExcerptChars,
              })
              llmCommitted = committed.created + committed.updated
            }
            store.recordMetric({
              volumeId,
              kind: 'llm-proposals',
              data: {
                mode: config.llmCompiler,
                accepted: llmProposal.entries.length,
                rejected: llmProposal.rejected.length,
                committed: llmCommitted,
                ms: llmProposal.ms,
              },
              now,
            })
          } catch (error) {
            this.log.warn(`LLM proposal commit failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        // Only new/updated entries change the dictionary; an abstract-only change
        // must not trigger a full group/summary/relation rebuild.
        const changed = stats.created + stats.updated + stats.citations > 0 || llmCommitted > 0
        if (changed) {
          store.bumpVersion(volumeId, now)
          store.rebuildGroups(volumeId)
          try {
            rebuildSummaryTree(store, volumeId)
          } catch (error) {
            this.log.warn(`summary tree rebuild failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          if (config.relationsMode !== 'off') {
            try {
              const relationStats = syncRelations(store, volumeId, {
                log: this.log,
                entryIds: [...new Set(stats.entryIds ?? [])],
              })
              if (relationStats.edges > 0) {
                this.log.info(`relations synced: edges=${relationStats.edges} entries=${relationStats.entries}`)
              }
            } catch (error) {
              this.log.warn(`relation sync failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          try {
            const proposalStats = processProposals(store, volumeId, project, {
              mode: config.proposalMode ?? 'off',
              config: config,
              log: this.log,
              now,
            })
            if (proposalStats.files > 0) {
              store.recordMetric({ volumeId, kind: 'proposals', data: proposalStats, now })
            }
          } catch (error) {
            this.log.warn(`proposal processing failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        store.commitRun(runId)
        store.recordMetric({
          volumeId,
          kind: 'compile',
          data: {
            compactionId: String(data.compactionId ?? ''),
            deltaSeqs: delta.length,
            created: stats.created,
            updated: stats.updated,
            citations: stats.citations,
            skipped: stats.skipped,
            tasksOpened: stats.tasksOpened,
            tasksDone: stats.tasksDone,
            tasksClosed: stats.tasksClosed,
            evicted: stats.evicted,
            emptyRound: !changed,
            llmCommitted,
            project,
          },
          now,
        })
      } catch (error) {
        store.discardRun(runId)
        this.log.warn(`compile transaction failed for ${volumeId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Serialize the write phase across processes (multi-instance safety); reads
    // and sampling above stay concurrent.
    if (store.path === ':memory:') {
      apply()
      return
    }
    try {
      withLock(`${store.path}.write.lock`, apply, { timeoutMs: 15000 })
      if (typeof store.clearDeferredSeqs === 'function') store.clearDeferredSeqs(volumeId)
      this.deferred.delete(volumeId)
    } catch (error) {
      this.log.warn(`compile skipped (store busy): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * @param {any} store
   * @param {string} volumeId
   * @param {string} title
   * @param {string} abstractText
   * @param {number} now
   */
  #updateVolumeAbstract(store, volumeId, title, abstractText, now) {
    const volume = store.getVolume(volumeId)
    if (volume === null) return
    store.updateVolume(volumeId, {
      title: title.length > 0 ? title : volume.title,
      abstract: abstractText,
    }, now)
  }

  /**
   * Build extraction samples for one delta; sampling strategy lives in
   * `compiler-samples.js`.
   * @param {any} session
   * @param {readonly number[]} delta
   * @returns {Promise<{ seq: number, role: string, text: string, time: number }[]>}
   */
  async #samplesForDelta(session, delta) {
    return samplesForDelta({
      readEvents: this.readEvents,
      log: this.log,
      shouldSample: (message) => this.#shouldSample(message),
    }, session, delta)
  }
}

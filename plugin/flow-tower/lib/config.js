/**
 * --- module contract ---
 * purpose: Configuration defaults, normalization and validation for the plugin bundle.
 * dependsOn: [generated] lib/resource-guard.js, lib/resources.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] eval/context-cost.mjs, eval/long-session-eval.mjs, eval/offline-eval.mjs, eval/real-session-eval.mjs, eval/search-recall.mjs, eval/stress-long-session.mjs, eval/txt-corpus-eval.mjs, index.js, lib/web-write.js, test/compaction-storage.test.js, test/flow-tower.test.js, test/manager.test.js, tools/propose-agent.mjs
 * publicApi: [generated] DEFAULTS, resolveConfig
 * risk: Medium: defaults are durable behavior; invalid config must fail loudly without starting the plugin.
 * --- end module contract ---
 */

import { applyResourceProfile } from './resources.js'
import { DEFAULT_MAX_RSS_BYTES } from './resource-guard.js'

/** All supported configuration keys and their defaults. */
export const DEFAULTS = Object.freeze({
  /** Inject project dictionary digest into compaction summary prompt. */
  compactionSummaryContext: true,
  /** Primary context memory layer for DSH (not a compaction backend). */
  contextRole: 'primary',
  /** Which projects use the memory layer: current | all | allowlist | denylist. */
  projectMode: 'current',
  projectAllowlist: [],
  projectDenylist: [],
  /** Hard token budget for one entry gloss and one sense. */
  nodeBudgetTokens: 2400,
  /** Maximum entries per volume; cold low-priority entries are evicted to make room. */
  maxEntries: 6000,
  /** Token budget for an entry gloss. */
  glossTokens: 480,
  /** Token budget for the per-session digest injected before a step. */
  digestBudgetTokens: 2000,
  /**
   * Scale the digest budget from live context pressure: near a full context
   * window the map shrinks instead of pushing the session into compaction.
   */
  adaptiveDigestBudget: true,
  /**
   * Digest shape: 'brief' (default) injects a whole-project overview + current
   * progress + recent change log (the dictionary is the drill-down index);
   * 'focus'/'balanced'/'full' are the previous dictionary-index shapes.
   */
  digestStrategy: 'brief',
  /** 'on-change' injects a digest when the volume version moved; 'off' disables it. */
  digestMode: 'on-change',
  /**
   * Injection plan: 'auto' chooses dual / dual-lite / long-only / short-only per
   * task type, native-checkpoint freshness and context pressure; 'dual' always
   * injects the full digest (previous behavior); 'off' never injects.
   */
  injectionMode: 'auto',
  /** Token budget for one dict_cite raw replay. */
  rawBudgetTokens: 48000,
  /** Maximum characters of one citation excerpt kept in the store. */
  maxCiteExcerptChars: 800,
  /** Maximum citations attached to one entry. */
  maxCitationsPerEntry: 48,
  /** Entries touched within this many days are tier 'hot'. */
  tierHotDays: 14,
  /** Entries touched within this many days are tier 'warm'; older entries are 'cold'. */
  tierWarmDays: 60,
  /** Record per-request cache/token facts in the metrics table. */
  cacheTelemetry: true,
  /**
   * Where dictionary data lives: 'project' stores it next to the user's
   * project (`<project>/.flow-tower/`), 'global' keeps the legacy
   * `$DSH_HOME/flow-tower/` layout. An explicit `dbPath` overrides both.
   */
  storageMode: 'project',
  /**
   * Directory for `storageMode: 'custom'`; absolute or `~`-prefixed paths are
   * used as-is, relative paths resolve under the project root. Ignored by the
   * other modes. The SQLite file `flow_tower.db` is created inside it.
   */
  storagePath: null,
  /** Override the SQLite path (forces one shared database). */
  dbPath: null,
  /** Character budget for project memory injected into a compaction summary. */
  summaryMemoryChars: 1800,
  /**
   * At or above this entry count the brief becomes a module map (goal + one
   * tower line per module: tip, upper floors, completion, evidence link).
   */
  mapThresholdEntries: 200,
  /** Max deterministic topic entries (TF-IDF) produced per compile round. */
  maxTopicsPerRound: 100,
  /**
   * Agent/human proposal pipeline: 'off' ignores `<project>/.flow-tower/proposals/*.json`,
   * 'shadow' validates and audits without committing, 'on' validates then commits.
   */
  proposalMode: 'off',
  /**
   * Host-LLM compiler: 'off' never calls a model; 'shadow' generates + validates
   * + audits proposals without committing; 'on' commits validated proposals
   * (citations checked) after the deterministic ingest. Never replaces the
   * deterministic path and never uses an embedding API (none exists here).
   */
  llmCompiler: 'off',
  /** Optional explicit host LLM route; null = use agentDefaultModel selection. */
  llmProvider: null,
  llmModel: null,
  llmMaxTokens: 32000,
  llmTimeoutMs: 90000,
  /** 'auto' caps maxEntries from installed RAM; 'off' disables the cap. */
  resourceProfile: 'auto',
  /** Shed optional memory-layer work when the Host RSS is already high. */
  memoryGuard: true,
  maxRssBytes: DEFAULT_MAX_RSS_BYTES,
  /** UI language: 'zh' | 'en'. */
  uiLocale: 'zh',
  /** Optional OpenAI-compatible embedding endpoint; null = lexical only. */
  embeddingEndpoint: null,
  embeddingModel: null,
  embeddingTimeoutMs: 15000,
  /**
   * Typed relation graph: 'off' disables it, 'shadow' builds + exposes read-only
   * queries, 'on' also validates and logs relation changes. Never injects into
   * the digest in v1 (keeps cache behavior unchanged).
   */
  relationsMode: 'on',
})

const INTEGER_KEYS = [
  'nodeBudgetTokens',
  'maxEntries',
  'glossTokens',
  'digestBudgetTokens',
  'rawBudgetTokens',
  'maxCiteExcerptChars',
  'maxCitationsPerEntry',
  'tierHotDays',
  'tierWarmDays',
  'maxTopicsPerRound',
  'llmMaxTokens',
  'llmTimeoutMs',
  'summaryMemoryChars',
  'mapThresholdEntries',
]

const DIGEST_MODES = new Set(['on-change', 'off'])
const DIGEST_STRATEGIES = new Set(['brief', 'focus', 'balanced', 'full'])
const INJECTION_MODES = new Set(['auto', 'dual', 'off'])

/**
 * Merge raw row config with defaults and reject invalid values loudly.
 * @param {Record<string, unknown>} [raw]
 * @returns {Readonly<typeof DEFAULTS>}
 */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const out = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (source[key] === undefined || source[key] === null) continue
    out[key] = source[key]
  }
  for (const key of INTEGER_KEYS) {
    const value = out[key]
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`flow-tower: config.${key} must be a positive safe integer, got ${String(value)}`)
    }
  }
  if (typeof out.cacheTelemetry !== 'boolean') {
    throw new TypeError(`flow-tower: config.cacheTelemetry must be a boolean`)
  }
  if (typeof out.adaptiveDigestBudget !== 'boolean') {
    throw new TypeError(`flow-tower: config.adaptiveDigestBudget must be a boolean`)
  }
  if (!DIGEST_MODES.has(out.digestMode)) {
    throw new TypeError(`flow-tower: config.digestMode must be one of ${[...DIGEST_MODES].join(', ')}`)
  }
  if (!DIGEST_STRATEGIES.has(out.digestStrategy)) {
    throw new TypeError(`flow-tower: config.digestStrategy must be one of ${[...DIGEST_STRATEGIES].join(', ')}`)
  }
  if (!INJECTION_MODES.has(out.injectionMode)) {
    throw new TypeError(`flow-tower: config.injectionMode must be one of ${[...INJECTION_MODES].join(', ')}`)
  }
  if (out.dbPath !== null && typeof out.dbPath !== 'string') {
    throw new TypeError('flow-tower: config.dbPath must be a string or null')
  }
  if (out.storageMode !== 'project' && out.storageMode !== 'global' && out.storageMode !== 'custom') {
    throw new TypeError("flow-tower: config.storageMode must be 'project', 'global' or 'custom'")
  }
  if (out.storagePath !== null && typeof out.storagePath !== 'string') {
    throw new TypeError('flow-tower: config.storagePath must be a string or null')
  }
  if (out.storageMode === 'custom' && (typeof out.storagePath !== 'string' || out.storagePath.trim().length === 0)) {
    throw new TypeError('flow-tower: config.storagePath is required when storageMode is custom')
  }
  if (out.summaryMemoryChars < 600 || out.summaryMemoryChars > 8000) {
    throw new TypeError('flow-tower: config.summaryMemoryChars must be between 600 and 8000')
  }
  if (out.proposalMode !== 'off' && out.proposalMode !== 'shadow' && out.proposalMode !== 'on') {
    throw new TypeError("flow-tower: config.proposalMode must be 'off', 'shadow' or 'on'")
  }
  if (out.relationsMode !== 'off' && out.relationsMode !== 'shadow' && out.relationsMode !== 'on') {
    throw new TypeError("flow-tower: config.relationsMode must be 'off', 'shadow' or 'on'")
  }
  if (out.llmCompiler !== 'off' && out.llmCompiler !== 'shadow' && out.llmCompiler !== 'on') {
    throw new TypeError("flow-tower: config.llmCompiler must be 'off', 'shadow' or 'on'")
  }
  if (out.llmProvider !== null && typeof out.llmProvider !== 'string') {
    throw new TypeError('flow-tower: config.llmProvider must be a string or null')
  }
  if (out.llmModel !== null && typeof out.llmModel !== 'string') {
    throw new TypeError('flow-tower: config.llmModel must be a string or null')
  }
  if (out.embeddingEndpoint !== null && typeof out.embeddingEndpoint !== 'string') {
    throw new TypeError('flow-tower: config.embeddingEndpoint must be a string or null')
  }
  if (out.embeddingModel !== null && typeof out.embeddingModel !== 'string') {
    throw new TypeError('flow-tower: config.embeddingModel must be a string or null')
  }
  if (out.uiLocale !== 'zh' && out.uiLocale !== 'en') {
    throw new TypeError("flow-tower: config.uiLocale must be 'zh' or 'en'")
  }
  if (out.resourceProfile !== 'auto' && out.resourceProfile !== 'off') {
    throw new TypeError("flow-tower: config.resourceProfile must be 'auto' or 'off'")
  }
  if (!Number.isSafeInteger(out.maxRssBytes) || out.maxRssBytes <= 0) {
    throw new TypeError('flow-tower: config.maxRssBytes must be a positive safe integer')
  }
  if (out.contextRole !== 'primary' && out.contextRole !== 'companion') {
    throw new TypeError("flow-tower: config.contextRole must be 'primary' or 'companion'")
  }
  if (out.projectMode !== 'current' && out.projectMode !== 'all' && out.projectMode !== 'allowlist' && out.projectMode !== 'denylist') {
    throw new TypeError("flow-tower: config.projectMode must be 'current', 'all', 'allowlist' or 'denylist'")
  }
  for (const key of ['projectAllowlist', 'projectDenylist']) {
    if (!Array.isArray(out[key]) || out[key].some((item) => typeof item !== 'string')) {
      throw new TypeError(`flow-tower: config.${key} must be an array of strings`)
    }
  }
  if (out.glossTokens > out.nodeBudgetTokens) {
    throw new TypeError('flow-tower: config.glossTokens must not exceed config.nodeBudgetTokens')
  }
  return Object.freeze(applyResourceProfile(out))
}

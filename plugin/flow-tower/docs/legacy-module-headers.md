# Legacy module headers (archived)

These original module-level doc blocks were superseded by the generated contract block at the top of each file. Kept here so architecture notes are not lost.

## compaction/index.js

```
/**
 * Flow Tower compaction backend.
 *
 * Phase 1b (real provider): subclass BasicCompactionEngine and delegate every
 * policy/replay decision to it, but enrich the summarization hook with the
 * project's Flow Tower dictionary. The row replaces `compaction-basic` via this
 * bundle's patch, so `ctx.compaction` is this engine rather than the default.
 *
 * All token pressure, range selection, replay, checkpoint and recovery behavior
 * remains the shipped Basic backend; only `summarize()` adds a bounded memory
 * block and writes one operational evidence line per summarize call.
 *
 * @module @local/flow-tower-compaction
 */
```

## compaction/lib/memory.js

```
/**
 * Read-only project-memory summary for the compaction summarizer.
 *
 * The backend runs in the Host process and reads the same SQLite dictionary
 * the flow-tower plugin maintains, using the user's storage setting
 * (`project` / `global` / `custom`). No writes, no network.
 *
 * Task headwords are ranked and filtered: extracted fragments from harness
 * output, list headings and conditional prose are not useful "open tasks" and
 * used to crowd out real work items in the summarizer prompt.
 *
 * This file is mirrored into the standalone `@local/flow-tower-compaction`
 * package; keep both copies in sync.
 *
 * @module flow-tower-compaction/memory
 */
```

## compaction/lib/policy.js

```
/**
 * The compaction backend also respects the same project opt-out as the memory
 * layer: a project outside `projectMode` never gets Flow Tower memory injected.
 *
 * Reads only the global settings document; project-local overrides are applied
 * by the flow-tower memory layer itself.
 *
 * @module flow-tower-compaction/policy
 */
```

## compaction/lib/storage.js

```
/**
 * Re-export the package-level storage resolver for the compaction backend.
 *
 * The standalone `@local/flow-tower-compaction` package carries its own full
 * copy; this integrated backend shares the plugin's single source of truth.
 *
 * @module flow-tower-compaction/storage
 */
```

## index.js

```
/**
 * Flow Tower — dictionary-style context memory for DeepSeek Harness.
 *
 * The plugin is an observation-only Host-plane bundle:
 * - it watches `compaction/summary` session events and compiles the newly
 *   shadowed raw messages into a cited vocabulary (files, features, symbols,
 *   decisions, tasks, commands, errors);
 * - it never writes to the session surface and never replaces the host
 *   compaction backend;
 * - it exposes `dict_browse` / `dict_lookup` / `dict_cite` / `dict_timeline`
 *   and injects a narrow per-session digest before a step when the dictionary
 *   moved;
 * - dictionary data lives next to the user's project
 *   (`<project>/.flow-tower/flow_tower.db`) and is shared by every session on
 *   that project; `storageMode: 'global'` or an explicit `dbPath` keeps the
 *   legacy single-database layout.
 *
 * @module flow-tower
 */
```

## lib/catalog.js

```
/**
 * Model-facing catalog rendering: the stable legend, the per-session digest
 * (project / module / feature / task / time layers), the browse/lookup text
 * bodies and the chronological timeline view.
 *
 * All rendering is deterministic: order by `kind` then normalized headword (or
 * by time for the timeline) — never by activity — so an unchanged dictionary
 * produces byte-identical text (prefix-cache friendly).
 *
 * @module flow-tower/catalog
 */
```

## lib/compaction-context.js

```
/**
 * Phase 1 of compaction integration: inject the project's dictionary digest into
 * DSH's compaction summarization request without replacing the backend.
 *
 * The basic compaction backend issues one `llm.stream({ purpose: 'compaction' })`
 * call. We intercept that request (llm/stream waterfall) and append a bounded
 * memory block to the final user message, so the summary preserves decisions,
 * tasks and the project map instead of only the raw conversation.
 *
 * Safe by construction: if the request is frozen or has an unexpected shape we
 * leave it untouched; failures never affect compaction.
 *
 * @module flow-tower/compaction-context
 */
```

## lib/compaction-wrapper.js

```
/**
 * Phase 1b-lite: wrap the host's existing compaction backend instance without
 * importing `@deepseek-ai/*` (the plugin is a dependency-free pure-JS bundle).
 *
 * The wrapper delegates to `BasicCompactionEngine` and records trigger/latency
 * metrics; the summary prompt itself is enriched by the separate `llm/stream`
 * bridge in lib/compaction-context.js. It is NOT a replacement backend.
 *
 * @module flow-tower/compaction-wrapper
 */
```

## lib/compiler-samples.js

```
/**
 * Session-event sampling for dictionary compilation.
 *
 * Purpose: project raw session events into the text samples extraction consumes,
 * preferring the `sessionQuery` seam and falling back to the live session.
 * sampleForSeq(session, seq, shouldSample).
 * with the extraction budget.
 */
```

## lib/compiler.js

```
/**
 * Dictionary compiler: observe `compaction/summary` events and turn the newly
 * shadowed raw messages into vocabulary entries with seq citations.
 *
 * The compiler resolves the project-scoped store per session through
 * `storeFor(session)`, so one project folder keeps a shared dictionary across
 * all of its sessions. Work is serialized per session, idempotent per
 * `compactionId + delta hash`, and failures are logged without affecting the
 * conversation.
 *
 * @module flow-tower/compiler
 */
```

## lib/config.js

```
/**
 * Configuration defaults and validation for the flow-tower plugin.
 * Pure module: no host imports.
 * @module flow-tower/config
 */
```

## lib/digest.js

```
/**
 * Per-session digest rendering (the bounded, model-facing project snapshot).
 *
 * Purpose: turn one dictionary volume into a token-bounded digest injected
 * before a step, with a strategy that spends the budget on actionable context.
 * stability and the token bound. Pure rendering: no writes, no host access.
 */
```

## lib/embeddings.js

```
/**
 * Optional embedding provider. Two modes:
 *
 * 1. `embeddingEndpoint: "local"` — a dependency-free, deterministic hashing
 *    vectorizer (token → fixed-dim vector, L2-normalized). It proves/backfills
 *    the full vector path offline, but it is NOT a neural model: use it as a
 *    bootstrap or for air-gapped setups, not as a semantic-quality claim.
 * 2. Any OpenAI-compatible URL — real embeddings via POST {model,input}.
 *
 * API key is read from FLOW_TOWER_EMBEDDING_KEY or OPENAI_API_KEY (host process
 * environment); it is never stored in settings.
 *
 * @module flow-tower/embeddings
 */
```

## lib/extract.js

```
/**
 * Deterministic headword extraction from conversation messages.
 *
 * v1 is LLM-free: file paths, commands, error strings/codes, explicit
 * decisions, capability/feature phrases, task markers (with an open/done
 * status) and backticked symbols are mined with fixed rules.
 *
 * Each candidate carries the dimensions the store persists:
 * `kind`, `headword`, `gloss`, `seq`, `time`, plus `module` for code units and
 * `status` for tasks.
 *
 * @module flow-tower/extract
 */
```

## lib/kinds.js

```
/**
 * Shared kind ordering/labels for catalog and digest rendering.
 *
 * Purpose: keep the display order of dictionary kinds in one place.
 */
```

## lib/llm-filter.js

```
/**
 * Reject "process noise" from LLM proposals: file-edit logs, test results,
 * command/tool output, install/link/patch summaries. These are covered by the
 * raw evidence and citations; they should not become dictionary entries.
 *
 * @module flow-tower/llm-filter
 */
```

## lib/llm-prompt.js

```
/**
 * Prompt + parsing helpers for LLM-assisted compilation. Kept free of I/O so
 * both the in-process host-LLM compiler and the external CLI proposer share it.
 *
 * @module flow-tower/llm-prompt
 */
```

## lib/llm-search.js

```
/**
 * DeepSeek-only semantic search: no embedding model required.
 *
 * Pipeline:
 * 1. ask the host LLM to rewrite the query into a few paraphrases / keywords;
 * 2. run BM25 for original + rewritten queries and merge by entry id;
 * 3. ask the host LLM to rerank the merged candidates;
 * 4. return the reordered results (fallback to lexical if either call fails).
 *
 * This improves recall/precision over pure word matching, while keeping the
 * "no extra model" constraint. It costs one or two chat calls per smart search.
 *
 * @module flow-tower/llm-search
 */
```

## lib/llm.js

```
/**
 * Host-LLM bridge for optional shadow compilation.
 *
 * Uses the DSH Host `llm` Service (`ctx.get('llm').stream(GenerateOptions)`) with
 * the default model from `agentDefaultModel.currentSelection()` (or explicit
 * config). Every call is bounded by maxTokens/timeout, and its output is only a
 * *proposal*: the caller must validate it (JSON schema + citation seqs) before
 * any write. The host LLM service exposes chat streaming only — no embeddings.
 *
 * @module flow-tower/llm
 */
```

## lib/lock.js

```
/**
 * Cross-process advisory lock for operations that must not run concurrently
 * (relation sync, project merge). Best effort: stale locks older than
 * `staleMs` are broken; lock loss never corrupts data (writes stay idempotent).
 *
 * @module flow-tower/lock
 */
```

## lib/manager.js

```
/**
 * Project-scoped store manager.
 *
 * The dictionary location follows the user's storage setting:
 *   - `project` (default): `<project>/.flow-tower/flow_tower.db`
 *   - `global`:            `$DSH_HOME/flow-tower/flow_tower.db`
 *   - `custom`:            `<storagePath>/flow_tower.db`
 * An explicit `dbPath` still forces one shared database (advanced/tests).
 *
 * Each location keeps one SQLite connection per Host process; a session
 * resolves to exactly one store through `projectStore()`. Switching storage
 * closes cached handles and can migrate the current project's volumes.
 *
 * @module flow-tower/manager
 */
```

## lib/project-policy.js

```
/**
 * Project-level opt-in/opt-out for the primary context-memory layer.
 *
 * - `all`: every project uses flow-tower.
 * - `allowlist`: only listed project roots use it; others fall back to DSH default.
 * - `denylist`: listed project roots fall back to DSH default.
 *
 * Matching is prefix-aware on normalized roots (`E:/work/foo` also covers
 * children), case-insensitive on Windows.
 *
 * @module flow-tower/project-policy
 */
```

## lib/proposals.js

```
/**
 * Proposal pipeline: an agent (or a human) drops validated JSON proposals into
 * `<project>/.flow-tower/proposals/*.json`; the plugin validates them and, in
 * `on` mode, commits them through the same store path as deterministic
 * compilation. This is the "validated fold" pattern from CarryOn: proposals are
 * staged, checked, and only then committed; in `shadow` mode nothing is
 * committed but an audit row records what would have happened.
 *
 * Proposal schema (one file):
 * {
 *   "entries": [{
 *     "kind": "topic|feature|person|decision|task|file|...",
 *     "headword": "…",
 *     "gloss": "…",
 *     "citations": [12, 13],       // required, ≥1 seq reference
 *     "status": "open|done",       // task only
 *     "module": "src/compiler",    // optional
 *     "related": ["entry id…"]     // optional
 *   }]
 * }
 *
 * @module flow-tower/proposals
 */
```

## lib/raw.js

```
/**
 * Raw replay helpers: turn citation seq ranges back into readable transcript
 * text.
 *
 * Primary path: `session-read.renderEvents` over a queried event log (works for
 * persisted, non-live sessions). This module keeps the live-Session fallback
 * used when the query seam is unavailable.
 *
 * @module flow-tower/raw
 */
```

## lib/relations.js

```
/**
 * Typed, directional relation graph for the dictionary ("多向关系标记").
 *
 * Design decisions (see design/flow-tower/11-关系标记方案.md):
 * - one canonical edge row per relation: (from, to, type, source, confidence,
 *   evidence, status, batch); incoming/outgoing are queries, never duplicated;
 * - inverse types are normalized on write (B `derivedTo` A becomes A `derivedFrom`
 *   B) and inverted on read, so both views stay consistent without double writes;
 * - symmetric types are stored once with lexicographic endpoint order;
 * - non-cyclic families (derivedFrom/replaces/mergedFrom/parent/relatedTo) are
 *   cycle-checked; cites/sibling may be cyclic;
 * - unknown relation types are preserved on import with status `unknown` instead
 *   of being dropped (forward compatibility);
 * - relation failures must never break compilation: callers wrap in try/catch.
 *
 * Node ids are opaque strings: `e_…` (entry), `v:<volumeId>`, `h:<sessionId>:<seq>`
 * (host message pointer), `grp_…` (group), `sum_…` (summary node).
 *
 * @module flow-tower/relations
 */
```

## lib/resource-guard.js

```
/**
 * Host-memory backpressure for long sessions.
 *
 * Compaction controls model tokens, not process RSS. Flow Tower therefore sheds
 * its optional work when the host is already heavy: no digest injection and no
 * new compile. The check is cheap and fail-open.
 *
 * @module flow-tower/resource-guard
 */
```

## lib/resources.js

```
/**
 * Hardware-aware resource limits. Cheap to compute (no external services) and
 * used to cap dictionary size and SQLite caches on smaller machines.
 *
 * @module flow-tower/resources
 */
```

## lib/semantic.js

```
/**
 * Semantic-lite retrieval: sparse TF-IDF vectors + cosine similarity, with
 * co-occurrence query expansion (terms that share entries are treated as
 * related). No neural embeddings required; if a host embedding provider exists
 * later, it can be plugged in behind `semanticSearch`.
 *
 * @module flow-tower/semantic
 */
```

## lib/session-read.js

```
/**
 * Session log reading: prefer the `sessionQuery` seam (works for persisted,
 * non-live sessions), fall back to the live Session object.
 *
 * The host marks `Session.eventAt` / `snapshotEvents` as deprecated for new
 * call sites, so the plugin treats them as a compatibility fallback only.
 *
 * @module flow-tower/session-read
 */
```

## lib/settings.js

```
/**
 * Editable local settings file (global, no schema required):
 * `$DSH_HOME/flow-tower/settings.json`. The web panel writes it and the runtime
 * overlay applies immediately; on next plugin load it is merged over the bundle
 * defaults.
 *
 * @module flow-tower/settings
 */
```

## lib/storage.js

```
/**
 * Storage location resolution for the Flow Tower dictionary.
 *
 * One database is stored per location; the location is selected by the user
 * settings and applies to:
 *   - the plugin's Runtime store manager,
 *   - the compaction backend's read-only project memory,
 *   - the compaction run log used as operational evidence.
 *
 * Modes (persisted in `$DSH_HOME/flow-tower/settings.json`):
 *   - `project` (default): `<project>/.flow-tower/flow_tower.db`
 *   - `global`:            `$DSH_HOME/flow-tower/flow_tower.db`
 *   - `custom`:            `<storagePath>/flow_tower.db` (absolute or `~`,
 *                          relative paths resolve under the project root)
 * A legacy `dbPath` still wins when set explicitly (advanced/tests).
 *
 * This module is pure apart from reading the settings file; it is mirrored
 * into the standalone compaction backend, so keep both copies in sync.
 *
 * @module flow-tower/storage
 */
```

## lib/store-schema.js

```
/**
 * SQLite schema, migrations and row projections for the dictionary store.
 *
 * Purpose: keep DDL/migration/row-mapping data out of the transactional
 * FlowStore class.
 * volumeFromRow, entryFromRow, citationFromRow, migrateStore(db).
 * databases readable and preserve the append-only migration style.
 */
```

## lib/store.js

```
/**
 * SQLite-backed transactional store for volumes, entries, citations, relations,
 * vectors, groups, proposal runs, summary nodes, metrics and KV state.
 *
 * Purpose: one connection + transaction boundary over the dictionary schema;
 * search/eviction/summary methods stay together because they share private
 * prepared-statement/index state and must remain transactionally consistent.
 * lib/synonyms.js, lib/store-schema.js.
 * (not split across files) because every method shares `this.db`, the
 * statement cache and index/eviction invariants; splitting the class would risk
 * behavioral drift with little decoupling benefit. Pure schema/row/migration
 * concerns are extracted to lib/store-schema.js.
 */
```

## lib/summary.js

```
/**
 * Recursive summary tree over a volume's groups: volume -> category ->
 * group -> entries. Summaries are deterministic (top headwords) by default and
 * can be replaced by an LLM-generated summary via `summaryGenerator`.
 *
 * The tree is stored in `summary_nodes` so it can be rendered by tools and the
 * web panel without recomputing per request.
 *
 * @module flow-tower/summary
 */
```

## lib/synonyms.js

```
/**
 * Small, dependency-free bilingual engineering synonym map used for query
 * expansion. This is intentionally NOT a general thesaurus: it covers the
 * recurring engineering vocabulary of this project so a Chinese query can match
 * English headwords/glosses (and vice versa) without an embedding endpoint.
 *
 * @module flow-tower/synonyms
 */
```

## lib/text-index.js

```
/**
 * Lightweight lexical indexing for the dictionary: CJK bigrams + ASCII words.
 * Powers `dict_search` (BM25-lite scoring) without embeddings or external
 * services, and the deterministic topic extractor.
 *
 * @module flow-tower/text-index
 */
```

## lib/tools/browse.js

```
/**
 * `dict_browse`: list/explore the compiled dictionary.
 *
 * Purpose: render headwords by kind/project/module/status/time, the union
 * catalog, or the volume tree without a full text lookup.
 */
```

## lib/tools/cite.js

```
/**
 * `dict_cite`: replay the original messages behind one citation id.
 *
 * Purpose: expose the lossless evidence path for dictionary lookups.
 * the stored excerpt when the original session is unavailable.
 */
```

## lib/tools/common.js

```
/**
 * Shared helpers and runtime context for the model-facing dictionary tools.
 *
 * Purpose: one place for option coercion, store targeting and the tool output
 * envelope shared by every `dict_*` tool.
 * optionalTime, resolveSession, sessionProject, isEntryText, firstJsonObject,
 * createToolRuntime.
 * This module never reads the store itself — it only resolves targets.
 */
```

## lib/tools/dev.js

```
/**
 * Dev-only dictionary tools: shadow proposal probe and alias backfill.
 *
 * Purpose: expose host-LLM evaluation/maintenance operations without polluting
 * the normal tool list; both are registered only when `llmCompiler != off`.
 * lib/tools/common.js, node:fs, node:path.
 * explicitly scoped and fail-soft. Never part of the default tool surface.
 */
```

## lib/tools/index.js

```
/**
 * Tool registry: compose the `dict_*` tool definitions from their modules.
 *
 * Purpose: build the model-facing tool list in one place while each tool keeps
 * its own schema/implementation file.
 * search.js, relate.js, dev.js.
 * contract, so tests pin the set. Dev tools are opt-in via llmCompiler.
 */
```

## lib/tools/lookup.js

```
/**
 * `dict_lookup`: definition + citations for one headword.
 *
 * Purpose: look up an entry in the target project dictionary, falling back to
 * other open project stores, and append a relation summary when enabled.
 */
```

## lib/tools/relate.js

```
/**
 * `dict_relate`: typed, directional relations for one node.
 *
 * Purpose: read the relation graph around an entry/volume and opportunistically
 * build edges for a volume that has entries but no edges yet.
 */
```

## lib/tools/search.js

```
/**
 * `dict_search`: ranked lexical/semantic/smart search.
 *
 * Purpose: retrieve entries when the exact headword is unknown; supports
 * BM25-lite, sparse semantic-lite, optional embedding and optional DeepSeek
 * query rewrite/rerank plus summary-tree scope.
 * lib/llm-search.js, lib/tools/common.js.
 * deterministic lexical results on failure.
 */
```

## lib/tools/timeline.js

```
/**
 * `dict_timeline`: chronological view of the dictionary.
 *
 * Purpose: render entries ordered by last-seen time, optionally filtered by
 * project/module/kind/time window.
 */
```

## lib/tools.js

```
/**
 * Compatibility entry for the model-facing dictionary tools.
 *
 * Purpose: keep the stable `lib/tools.js` import path while the tool set lives
 * in focused modules under `lib/tools/`.
 * existing host registration and tests do not need to change.
 */
```

## lib/topics.js

```
/**
 * Deterministic topic extraction (TF-IDF over CJK bigrams + ASCII words).
 * No LLM: repeated, corpus-specific terms become `topic` entries with citations,
 * filling part of the gap that embedding/topic models normally cover.
 *
 * @module flow-tower/topics
 */
```

## lib/util.js

```
/**
 * Small pure helpers shared by the flow-tower plugin modules.
 * No host imports: this file must stay usable from plain `node --test`.
 * @module flow-tower/util
 */
```

## lib/vocabulary.js

```
/**
 * Vocabulary compilation: normalize headwords and merge extracted candidates
 * into append-only entries with citations, carrying the six context dimensions
 * (project via the volume, module, time, feature links, task status).
 *
 * Invariants:
 * - entries never store raw message text; they cite seq ranges plus event times;
 * - one normalized headword maps to one entry per volume;
 * - citations are append-only and deduplicated by (entry, session, span);
 * - task status is monotone by seq: a later candidate wins.
 *
 * @module flow-tower/vocabulary
 */
```

## lib/web-common.js

```
/**
 * Shared panel helpers: store selection, task quality/context, storage
 * snapshots, compaction run-log tail, JSON body reading and plugin version.
 *
 * Purpose: one home for the small read-only helpers shared by the panel API.
 * lastSummarizeRun, storageSnapshot, readJsonBody.
 */
```

## lib/web-page.js

```
/**
 * Legacy single-page browser markup served at /flow-tower/.
 *
 * Purpose: keep the no-build HTML page as data, separate from the HTTP handler.
 */
```

## lib/web-read.js

```
/**
 * Read-only panel API: every GET route under /flow-tower/api/.
 *
 * Purpose: build the JSON payload for catalog/browse/tree/timeline/tasks/
 * graph/relate/settings/status/search/cite requests.
 * lib/relations.js, lib/resource-guard.js, lib/settings.js, lib/resources.js,
 * lib/web-common.js.
 * tests pin the payload keys.
 */
```

## lib/web-write.js

```
/**
 * Write panel API: closing one task and saving settings/storage choices.
 *
 * Purpose: validate and persist panel writes, migrate storage when the location
 * changes, and notify the runtime settings callback.
 * pathname, payload, options).
 * failed migration returns 400 without persisting the settings.
 */
```

## lib/web.js

```
/**
 * HTTP panel host adapter: route prefix, static assets, request dispatch.
 *
 * Purpose: register the /flow-tower panel handler, serve whitelisted assets and
 * dispatch reads/writes to the focused API modules.
 * lib/web-common.js, lib/session-read.js, lib/resource-guard.js,
 * lib/settings.js.
 * handleWritePayload (compatibility re-exports).
 * response shape is the panel contract.
 */
```


# Context Flow Tower

> Version **0.66.3** · DeepSeek Harness **>=0.2.2-rc.3 <0.3.0** · public package **`flow-tower-context`** · **MIT**
>
> English · [中文](README.md) · [Install](docs/INSTALL.md) · [Compatibility](docs/COMPATIBILITY.md) · [Publishing](docs/PUBLISHING.md) · [Project overview](../../README.md) · [Paper (Word)](../../paper/FlowTower-压缩驱动的项目级上下文记忆系统.docx) · [Design notes](../../design/flow-tower/)

## 1. What it is

An **observational, automatic, project-local** context-memory plugin for DeepSeek Harness (DSH). It watches DSH `compaction/summary` events and **deterministically compiles** each compaction delta into a searchable, verbatim-traceable project dictionary, then injects the long-range project picture back into the model context on demand. It does not re-implement the host's compaction transaction; it adds a searchable long-term memory layer on top of it.

- **Compaction-driven compilation** — the compaction event is the only write anchor; zero extra LLM calls, no write amplification;
- **Ten entry kinds** — file / api-symbol / feature / decision / task / command / error / topic / chapter / person;
- **Verbatim replay** — every entry carries `seq` citations; `dict_cite` replays the original messages, not a rewrite;
- **Typed relations** — parent / derivedFrom / cites / replaces / mergedFrom / sibling / relatedTo / taskContext;
- **Dual injection** — `auto` selects dual / dual-lite / long-only / short-only from task type, checkpoint freshness and context pressure;
- **Multi-agent sharing** — subagents and fresh sessions without their own dictionary volume read a shared project digest with cross-volume open tasks;
- **Project-local storage** — a single SQLite file (WAL + project write lock), default `<project>/.flow-tower/flow_tower.db`.

## 2. Quick start

### 2.1 Requirements

- DeepSeek Harness **0.2.2-rc.3** (Desktop or web profile);
- No external service is required; optional embedding and DeepSeek smart rerank are off by default.

### 2.2 Install

After release (npm / plugin market):

```powershell
# A. Plugin market (recommended)
#   Plugins → Experimental plugins → enable Custom plugin indexes
#   Plugins → Discover → Add index source:
#   https://cdn.jsdelivr.net/npm/flow-tower-context/market/index.json
#   Search "Flow Tower Context" → install → restart DSH

# B. Install the npm package directly
plugin_manager install_bundle target=flow-tower-context@0.66.3
```

Local development / before release:

```powershell
# A. DSH UI → Settings → Plugins → Add plugin, choose plugin/flow-tower
# B. Build the release directory first, then install it
npm run build:publish        # writes dist/flow-tower-context
plugin_manager install_bundle target=<repo>\dist\flow-tower-context
```

Requires DSH `>=0.2.2-rc.3 <0.3.0`; restart DSH after installation so the new JS module generation is loaded. See
[docs/INSTALL.md](docs/INSTALL.md) for verification and uninstall, and [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)
for the compatibility statement.

### 2.3 Taking over compaction at the session-preset level (optional, recommended)

DSH plugin patches only affect the host plane, while a session's compaction service is assembled inside the preset
isolate group. The published bundle registers an agent preset **Flow Tower (compaction memory)**: it mirrors the
shipped `cordis` preset and replaces only the `compaction-basic` row inside its compaction group with
`flow-tower-context/compaction` (`FlowTowerCompactionEngine` extends the host `BasicCompactionEngine` and overrides only
`summarize()`; triggering, range selection, transactions and pruning stay unchanged).

Select that preset when creating a new session to inject project memory into the compaction request; without it the
plugin works in observer/injection mode. The preset plugin list is a snapshot of the shipped `cordis` preset and must be
regenerated after a DSH upgrade — see [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

### 2.4 Verify the installation

```powershell
# Status route (port from the GUI URL; note the /flow-tower prefix)
Invoke-RestMethod http://127.0.0.1:<port>/flow-tower/api/status | ConvertTo-Json -Depth 5
```

Key fields: `version`, `compactionBackend`, `lastSummarize.memoryChars`, `lastInjection.mode`, `compactionDiagnostics.sessionEngineVerified`. A successful takeover shows `memoryChars > 0` and `sessionEngineVerified = true`. Panel: Plugins → Flow Tower (dictionary / timeline / graph / tasks / settings).

## 3. Core mechanisms

### 3.1 Compaction-driven compilation

The plugin observes `compaction/start|summary|end` on `session/event`, reads the original messages and summary for the `shadowedSeqs` range of `compaction/summary`, and extracts entries, relations and citations. Updates are incremental, deduplicated and archived, with a maintenance pass (archive cited summary noise, attribute modules). Compilation is deterministic and linear in the delta size.

### 3.2 Dual injection

After compaction two information sources coexist: the short-range `<compacted-summary>` checkpoint (authoritative, precise) and the long-range digest/project map (overview, index). Three signals select the mode:

| Mode | Injected | Trigger (`injectionMode: auto`) | Budget factor |
| --- | --- | --- | --- |
| `long-only` | full digest / map | no checkpoint in context | 1.0 |
| `dual-lite` | goals / open tasks / modules / traversal only, recent sections dropped | fresh checkpoint (≤2 turns) and coding/research/history task | 0.6 |
| `dual` | full digest | planning task; or stale checkpoint (>2 turns) | 1.0 |
| `short-only` | nothing; native checkpoint only | general chat with a fresh checkpoint; or pressure ≥0.85 | 0 |

The budget adapts to pressure (base 2000 tokens, scaled at 0.55/0.7/0.85, floor 400), and the header carries a machine-readable marker, e.g.:
`[flow-tower] Project map · project · 10 open / 20 done · inject: dual · short: checkpoint 1t ago · task: coding`

**The injection budget is per compaction cycle** (v0.66.3): a compaction replaces the durable injected messages, so the per-volume counter is reset on `compaction/summary`; a long session never silently stops injecting after 40 injections.

### 3.3 Retrieval

- Default `hybrid`: lexical-first (CJK bigrams + ASCII tokens + path segments, headword ×2, alias ×3, bilingual synonym expansion) with sparse-semantic fill, avoiding pure rank fusion pushing correct hits down;
- `/api/search` and `dict_search` support `mode` (hybrid/lexical/semantic), `kind`, `module`, `status`, `since/until`, `sort`;
- The panel's "smart rerank" optionally calls DeepSeek for query rewriting + candidate reranking (results cached for 10 minutes); embedding is optional and off by default.

### 3.4 Storage and evidence

- Project-local SQLite: entries, relations, citations, summary tree, groups, metrics, injection cursor;
- Run log `compaction-runs.jsonl` (engine line with `memoryChars/injectedMessages`, event line with `compactionId`) and engine debug log `$DSH_HOME/flow-tower/compaction-engine-debug.log`;
- The status route merges both lines and exposes `compactionDiagnostics` (engine log summary, `sessionEngineVerified`).

## 4. Configuration defaults (excerpt)

| Key | Default | Meaning |
| --- | --- | --- |
| `storageMode` | `project` | `global` / `custom` also supported |
| `maxEntries` | `6000` | entries per volume, rolling eviction |
| `digestMode` | `on-change` | inject only when the dictionary version changes |
| `digestStrategy` | `brief` | large projects switch to the project map |
| `injectionMode` | `auto` | `dual` / `off` also supported |
| `digestBudgetTokens` | `2000` | further scaled by pressure |
| `summaryMemoryChars` | `1800` | project-memory cap inside the compaction request |
| `mapThresholdEntries` | `200` | switch brief → module map above this size |
| `relationsMode` | `on` | typed relations |
| `llmCompiler` | `off` | `shadow` / `on` (proposals need seq-citation validation) |
| `proposalMode` | `off` | LLM proposal pipeline |

Three layers: bundle defaults → `$DSH_HOME/flow-tower/settings.json` → `<project>/.flow-tower/settings.json`. See [docs/injection-policy.md](docs/injection-policy.md) and the panel settings page.

## 5. Tools and panel

Six model-facing tools: `dict_browse`, `dict_lookup`, `dict_cite`, `dict_timeline`, `dict_search`, `dict_relate` (plus `dict_shadow_probe` when `llmCompiler != off`). The read-only panel has Browse / Tree / Timeline / Tasks / Graph / Settings; the HTTP API under `/flow-tower/api/*` is read-only; an optional stdio JSON-RPC MCP server lives in `tools/mcp-server.mjs`.

## 6. Evaluation and tests

```powershell
cd plugin/flow-tower
npm test                  # 84/84 tests + module-graph --check (68 modules / 0 cycles)
npm run eval:search       # recall: lexical/hybrid Recall@5 = 0.94, sparse semantic 0.66
npm run eval:cost         # context cost: 5.26M chars of tool output, pruner bound ≈315k tokens, avg injection 767 tokens
node eval/txt-corpus-eval.mjs --file=<corpus.txt>   # long-text stress (8.44M-char novel → 2,846 entries, 100% fidelity)
```

Other scripts: `eval/offline-eval.mjs`, `eval/real-session-eval.mjs`, `eval/long-session-eval.mjs`, `eval/relations-bench.mjs`, `eval/ci.mjs`. Paper numbers come from a real development session (8 compactions, 3,881 entries, 23,676 active relations) and the evaluations above.

Release tooling:

```powershell
npm run build:publish          # build dist/flow-tower-context (public manifest, LICENSE, bundle patch, index, DETAIL)
npm run publish:check          # pre-release checklist (name/engines/locale/market index/absolute paths)
npm run publish:check:strict   # also fail on the Anseya placeholder
```

## 7. Known limits

- Weak semantic recall: lexical + synonyms + sparse semantics only; cross-language/paraphrase recall is limited without optional smart rerank or embeddings;
- No compaction, no compilation: short sessions without compaction produce no memory;
- Heuristic task/decision extraction may produce long or fragmented entries; mitigated by quality gates, maintenance and cite replay;
- Single-writer storage (file lock + WAL), no multi-master merge;
- The preset-level override is a static snapshot and must be regenerated after a DSH upgrade;
- Engineering debt: LOC exemptions for `store.js`, `client.js`, `web-page-script.js`; no browser automation tests yet.

## 8. Links, paper and license

- Project overview (bilingual): [../../README.md](../../README.md)
- Paper (Word, anonymous): [../../paper/FlowTower-压缩驱动的项目级上下文记忆系统.docx](../../paper/FlowTower-压缩驱动的项目级上下文记忆系统.docx)
- Design notes (21 documents): [../../design/flow-tower/](../../design/flow-tower/)
- Public package name: **`flow-tower-context`**; code repository (public address, placeholder before release):
  `https://github.com/Anseya/flow-tower-context`
- Plugin-market index (after release): `https://cdn.jsdelivr.net/npm/flow-tower-context/market/index.json`
- Install / compatibility / publishing: [docs/INSTALL.md](docs/INSTALL.md) · [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) · [docs/PUBLISHING.md](docs/PUBLISHING.md)
- Official DSH site: <https://www.deepseek.com/harness/>
- License: **MIT** (see [LICENSE](../../LICENSE) at the repository root)

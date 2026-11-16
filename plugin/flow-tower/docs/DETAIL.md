# Flow Tower Context

Compaction-driven project-level context memory for DeepSeek Harness (DSH).

Flow Tower watches the harness's `compaction/summary` events and deterministically compiles each compaction delta into a
project-local dictionary: ten entry kinds, typed relations, seq-referenced citations for verbatim replay, and a
three-layer summary tree. A dual-injection policy then combines the short-range native `<compacted-summary>` checkpoint
with a long-range digest, selecting one of four modes (dual / dual-lite / long-only / short-only) from the task type,
checkpoint freshness and measured context pressure.

## What it does

- **Compiles on compaction** — the compaction event is the only write anchor; compilation is deterministic and makes no
  extra LLM calls.
- **Searchable memory** — six `dict_*` tools and a read-only panel; default hybrid retrieval with kind/module/status/time
  filters and optional DeepSeek smart rerank.
- **Verbatim evidence** — every entry carries seq citations; `dict_cite` replays the original messages.
- **Adaptive injection** — a machine-readable header (`inject: dual-lite · short: checkpoint 1t ago · task: coding`)
  tells the model what was injected and why.
- **Multi-agent sharing** — subagents and fresh sessions without their own dictionary read a shared project digest with
  cross-volume open tasks.
- **Project-local storage** — one SQLite file per project (WAL + project write lock), configurable to a global or custom
  path.

## Compaction takeover (optional preset)

Installing the bundle registers an agent preset named **Flow Tower (compaction memory)**. It mirrors the shipped
`cordis` preset and replaces the compaction provider with Flow Tower, so the project memory is injected into the
compaction request itself. Select the preset for a new session to use it. Without the preset the plugin still works in
observer/injection mode.

Because a preset declaration is a snapshot of the shipped preset's plugin list, a DSH upgrade may require regenerating
it; see `docs/COMPATIBILITY.md`.

## Install

See `docs/INSTALL.md` in the package (or the repository README) for the Discover-index, npm, and local-development
install paths, verification steps and uninstall.

## Configuration highlights

| Key | Default | Meaning |
| --- | --- | --- |
| `storageMode` | `project` | `global` or `custom` also supported |
| `maxEntries` | `6000` | entries per volume, rolling eviction |
| `injectionMode` | `auto` | `dual` / `off` also supported |
| `digestBudgetTokens` | `2000` | adaptive base budget, scaled by pressure |
| `summaryMemoryChars` | `1800` | project-memory cap inside the compaction request |
| `llmCompiler` | `off` | optional `shadow` / `on` proposal pipeline |

## Evaluation (repository)

85/85 unit/integration tests, 68 modules with zero cycles, recall@5 0.94 on the offline search set, single long-range
injection 694–829 tokens, and a real `/compact` takeover injecting 1,799 characters of project memory. The paper in the
repository documents the design, the eight engineering problems found, and the long-text corpus stress test.

## Known limits

- Semantic recall is lexical-first; optional smart rerank or embeddings are needed for paraphrase/cross-language cases.
- No compaction, no compilation: sessions that never compact produce no dictionary entries.
- Task/decision extraction is heuristic; citations and search are the fallback for precision.
- Single-writer storage; no multi-master merge.
- The compaction preset is a static snapshot of the DSH cordis preset.

## Links

- Repository: https://github.com/Anseya/flow-tower-context
- Paper (Word): `paper/FlowTower-压缩驱动的项目级上下文记忆系统.docx` in the repository
- License: MIT

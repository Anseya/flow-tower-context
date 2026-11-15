# Context optimization: next steps

This note records the decision and the remaining work after P2 (native
tool-result pruner + adaptive digest budget).

## Implemented now

- **Prompt layer**: `buildLegend()` now carries a stable retrieval protocol
  (`lib/catalog.js`): use the dictionary for history/progress, read the live
  file before editing, treat the Project map as orientation, search → lookup →
  cite, prefer citations over re-reading large files, and keep results bounded.
  It is a `systemPrompt` section, so it activates on the next plugin load.
- **Adaptive digest budget** (`lib/adaptive-budget.js`): shrinks from the
  configured 2000 tokens to 1400/1000/600 as measured pressure crosses
  0.55/0.7/0.85 of the routed context window; floor 400. Every injection writes
  a `digest-injection` metric (`tokens`, `chars`, `budget`, `pressureTokens`,
  `contextWindow`, `strategy`).
- **Native tool-result pruner**: enabled in `cordis.patch.yml`; it trims
  oversized tool outputs before compaction and can remove the need to summarize.
- **Cost report**: `node eval/context-cost.mjs` (or `npm run eval:cost`) prints
  tool-result volume, pruner upper bound, digest cost and recorded injections.

## Injection policy (v0.66)

- `lib/injection-policy.js` decides per step between `dual`, `dual-lite`,
  `long-only` and `short-only` from the task type, native checkpoint freshness
  and context pressure. `dual-lite` drops the recency sections the native
  `<compacted-summary>` already carries and spends 60% of the budget on map
  orientation.
- The digest header carries `inject:` / `short: checkpoint Nt ago` / `task:`
  markers; `digest-injection` metrics include `mode/taskKind/checkpointAgeTurns`,
  and `/api/status` exposes `lastInjection`.
- `injectionMode: dual` keeps the previous full-digest behavior as an escape
  hatch; `off` disables injection. Details: `docs/injection-policy.md`.
- **Multi-agent**: sessions without their own volume (subagents, fresh sessions)
  receive a `Shared project map/brief` sourced from the best-covered project
  volume; open tasks are aggregated across project volumes. Fork checkpoints are
  deduped by the same policy, and the shared cursor re-injects when any project
  volume updates. No parent↔child live sync (DSH fork semantics).
- **Injection budget (v0.66.3)**: the 40-injection cap is per compaction cycle,
  not per session lifetime. `compaction/summary` resets the per-volume counter,
  because a compaction replaces the durable messages the cap was protecting;
  without the reset a marathon session silently stops injecting.
- **Verified in a real session (2026-11-15, runtime 0.66.2)**: the preset-level
  provider took over (`engine debug: summarize start`; run log
  `memoryChars=1799, injectedMessages=1, inputMessages=692`; status
  `lastSummarize.memoryChars=1799`), the checkpoint fix reports
  `checkpointAgeTurns=0` after compaction (so the first post-compaction turn is
  `short-only`, not a false `long-only`), and a probe subagent received
  `Shared project map … inject: long-only` (`scope=shared`). Modes observed in
  production: `short-only` (fresh checkpoint + general task) and `long-only`
  (no checkpoint / shared orientation); `dual`/`dual-lite` are covered by the
  unit-test matrix and their live triggers are described in
  `docs/injection-policy.md`.

## Baseline (one real session, 2026-11-15)

```
session events: 20,014
tool results: 3,782 items / 4,899,537 chars
  oversize > 8000 chars: 110
  pruner upper bound: 1,038,259 chars ≈ 288,405 tokens
compaction summaries: 8, average 11,701 chars
flow-tower: digest ≈ 700 tokens; recorded injections 7; average injected 665 tokens
  budget 2000; pressure 405,278 / 1,048,576 (adaptive scale 1.0)
usage: 2,273 calls, input 12,989,182, cacheRead 878,491,904, output 2,357,568
```

The pruner upper bound is two orders of magnitude larger than the digest cost, so
the next win is on the tool-output side, not on shrinking the map further. The
average injection (665 tokens) stays under the 900-token target even at the
configured 2000-token budget because `dual-lite` scales it down and the digest is
bounded by the brief strategy.

## Decisions

- **Do not embed skills into the plugin.** Skills are on-demand documents; embedding
  their text would increase the context we are trying to reduce, and the skill
  catalog changes between DSH versions.
- **Plugin provides capabilities, skills provide policy.** Skills may call
  `dict_*`; the plugin must not hard-depend on a skill package.
- **Prefer DSH-native mechanisms over prompt tricks**: tool-result pruner,
  token-meter-driven budgets, session projections, and compaction evidence.

## Next steps (ordered)

1. **Measure** (done 2026-11-15): injection average is 665 tokens (max 829) at
   budget 2000, measured by `npm run eval:cost`; the pruner upper bound
   (288,405 tokens) dwarfs the digest cost. Still open: compare request input
   tokens before/after enabling the pruner once compaction has re-run a few
   times.
2. **Office documents**: an office skill extracts structure; Flow Tower should
   ingest only the extracted structure + paragraph anchors as `file`/`topic`
   entries with citations pointing at the source document, never the full text.
3. **DSH facts**: do not cache `dsh-doc` prose in the dictionary. Store only
   durable decisions/errors (with citations) and let the skill load authoritative
   docs on demand.
4. **Error playbooks**: when an error entry exists, the agent should
   `dict_lookup(error-code)` before loading a diagnostic skill; no hard
   dependency on `diagnose-windows-sandbox-acl`.
5. **Optional**: a small `flow-tower-usage` skill that only documents when to
   search vs read a file. It is policy, not data, so it stays out of the plugin.

## Open questions

- Should the compacted summary itself become a dictionary entry with a
  `compaction` kind (currently only its shadowed events are compiled)?
- Should `summaryMemoryChars` follow the same pressure tiers as the digest?
- When the pruner is active, does the compaction threshold change in practice?
  Measure before changing `0.72/0.12/32768` policy.

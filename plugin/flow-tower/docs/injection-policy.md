# Injection policy: native short-range + Flow Tower long-range

This note documents the task-type-aware injection added in v0.66 and the
operation/verification contract. Design rationale and the closure plan live in
`design/flow-tower/22-双注入与结案规划.md`.

## Why

Two context sources coexist after a DSH compaction:

- **native short-range**: the `<compacted-summary>` checkpoint (8 sections:
  request/intent, concepts, files, errors, pending, current work, next step,
  critical context). Authoritative for "what happened just now".
- **Flow Tower long-range**: the dictionary digest / Project map (goal, open
  tasks, modules, tips, citations, relations). Authoritative for "what this
  project is and why".

Injecting both without de-duplication repeats the latest progress and can show
two slightly different "current states". Injecting neither loses cross-session
continuity. The policy keeps both only when they add different information.

## Modes

| Mode | Injected | When (auto) |
| --- | --- | --- |
| `dual` | full digest (Goal/Open/Modules/Latest/Progress/Change log) | planning; stale checkpoint (>2 turns) |
| `dual-lite` | orientation only (Goal/Open/Modules/Traverse); drops Latest/Progress/Change log; budget ×0.6 | coding/research/history with a fresh checkpoint |
| `long-only` | full digest | no checkpoint in the derived history |
| `short-only` | nothing (native checkpoint alone) | general chat with a fresh checkpoint; context pressure ≥0.85 |
| `off` | nothing | `injectionMode: off` or `digestMode: off` |

`injectionMode`:

- `auto` (default): the table above;
- `dual`: always full digest (previous behavior; escape hatch);
- `off`: never inject.

If task classification or `session.deriveMessages()` fails, the plugin falls
back to the previous full-digest behavior — the policy must never disable
memory because of its own bug.

## Multi-agent and shared project memory

Subagents (`subagent`, `subagent_fork`) and brand-new sessions share one
project store but have no dictionary volume until their first compaction. When
the own volume is missing, the plugin renders a **shared project digest** from
the best-covered volume of the same project:

```
[flow-tower] Shared project map · <project> · 3 project sessions · inject: long-only · ...
Shared: this session has no dictionary yet; orientation comes from other sessions in this project.
```

- `inject:` policy applies exactly as for an own volume (checkpoint / task /
  pressure); a forked checkpoint is detected and deduped.
- Open tasks are aggregated across all project volumes
  (`store.openTasksForProject`) so agents see each other's work.
- The shared cursor is stored under `<volumeId>#project`; its version proxy is
  the newest volume `updatedAt`, so a parent compaction after the fork causes a
  re-injection on the child's next first step.
- Writes still go through the project write lock; the plugin does not add
  parent↔child live sync (DSH fork semantics).

## Markers

Digest headers carry a machine-readable suffix so the model knows the roles:

```
[flow-tower] Project map · <project> · 6 open / 21 done · inject: dual-lite · short: checkpoint 0t ago · task: coding
```

- `inject: dual | dual-lite | long-only` — mode actually used;
- `short: checkpoint Nt ago` — freshness of the native checkpoint (turns);
- `task: coding | planning | research | history` — classification (omitted for
  `general`).

The stable legend (system prompt) explains that a `<compacted-summary>`
checkpoint is the authoritative recent state and the map is orientation only.

## Detection

- **Checkpoint**: scan `session.deriveMessages()` from **the head** (first 50
  messages) for a user message containing `<compacted-summary>` or the
  dsh-compaction-basic preamble ("automatically generated checkpoint condensing
  an earlier span"); the replacement node sits at the start of the retained
  region, and a long post-compaction tool tail (hundreds of messages) hides it
  from a tail-only scan. A tail scan (last 50) remains as a fork fallback. Age is
  counted in user/assistant messages after it, divided by two; a long tail makes
  the checkpoint stale, which selects `dual` rather than `long-only`.
- **Task**: recent tool names (edit/write → coding) + the last real user request
  (skipping the checkpoint and this plugin's own digest messages). Planning words
  ("规划/方案/设计/决定") win only when there is no explicit edit verb, so
  "决定…修改…" stays coding.
- **Pressure**: `tokenMeter.contextPressure()`; ratio ≥0.85 forces `short-only`
  when a fresh checkpoint exists.

## Observability

`digest-injection` metric data:

```json
{
  "tokens": 410, "chars": 1640, "budget": 1200,
  "pressureTokens": 405278, "contextWindow": 1048576,
  "strategy": "brief",
  "mode": "dual-lite", "taskKind": "coding",
  "checkpointAgeTurns": 0, "budgetScale": 0.6,
  "reason": "fresh checkpoint already carries recent details..."
}
```

Skipped injections record `{ "skipped": true, "mode": "short-only", "reason": ... }`
once per volume version. `/api/status` exposes `injectionMode` and
`lastInjection` (latest metric payload + timestamp), plus
`compactionDiagnostics` (`engineDebug.lastStart` / `lastRecord`,
`sessionEngineVerified`, `lastEngineMemoryChars`) proving the compaction
provider actually ran inside the session.

## Injection budget

Injected user messages are durable, so injection is bounded: first step of a
turn only, content-hash dedupe, and at most `MAX_DIGEST_INJECTIONS` per volume
**per compaction cycle**. Since `compaction/summary` replaces those durable
messages, the plugin resets the counter there (v0.66.3); otherwise a long
marathon session would silently stop injecting once the lifetime cap was hit.

## Verification

```powershell
cd plugin\flow-tower
npm test                                  # 84 tests + module graph
Invoke-RestMethod http://127.0.0.1:12425/flow-tower/api/status | ConvertTo-Json -Depth 6
# expect:
#   injectionMode=auto
#   lastInjection.mode in {dual, dual-lite, long-only, short-only}
#   lastSummarize.memoryChars > 0
#   compactionDiagnostics.sessionEngineVerified = true
```

Verified 2026-11-15 on a real session: first post-compaction turn was
`short-only` with `checkpointAgeTurns=0` (fresh checkpoint + general task), a
probe subagent received `long-only` with `scope=shared`, and the engine took over
compaction (`memoryChars=1799`, 33.7 s, 9,998-char summary). `dual-lite` appears
on coding/research/history turns while the checkpoint is ≤2 turns old, `dual` on
planning turns or a checkpoint older than 2 turns.

## Tuning

- More long-range detail on coding turns: set `injectionMode: dual`.
- Fewer tokens: keep `auto`; `dual-lite` already drops recency and scales budget.
- Disable entirely: `injectionMode: off` (legend and tools stay available).
- Change the freshness threshold: currently `>2 turns` means stale; edit
  `resolveInjectionPlan()` in `lib/injection-policy.js`.

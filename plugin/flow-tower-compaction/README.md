# Flow Tower compaction backend

A real DSH compaction provider, installed as a bundle:

- disables the shipped `compaction-basic` Loader row;
- mounts `@local/flow-tower-compaction` as `ctx.compaction`;
- extends `BasicCompactionEngine` and delegates all token-pressure, range
  selection, replay, checkpoint and recovery behavior to the shipped backend;
- overrides `summarize()` to add a bounded project-memory block immediately
  before the backend's compaction instruction.

The memory is read read-only from the database location selected in the flow-tower
settings (`project` / `global` / `custom`), scoped to the session's project; task
headwords are filtered and ranked so harness noise does not crowd out real work.
If the database is missing or unreadable, summarization is exactly the Basic
backend.

## Why the absolute asar import

Profile-installed bundles do not resolve `@deepseek-ai/*` by bare specifier.
The Desktop runtime exposes `app.asar` through Electron's asar-aware loader, so
`index.js` imports the shipped Basic backend by absolute asar URL. This is
Desktop-specific; a CLI install needs a vendored copy or a matching module
resolution change.

## Install / rollback

Install this directory with Plugin Manager / `plugin_manager`:

```text
E:\Programming-related Engineering Project\超级上下文\plugin\flow-tower-compaction
```

Rollback: remove the `@local/flow-tower-compaction` bundle. Its patch disappears,
`compaction-basic` becomes active again, and the default backend resumes.

## Verification

`GET /flow-tower/api/status` exposes `compactionBackend`; it must report
`FlowTowerCompactionEngine` while this bundle is mounted. Each summarize attempt
also appends one line to `compaction-runs.jsonl` next to the database
(`ok`, `ms`, `memoryChars`, `injectedMessages`, `project`); `/api/status` exposes
the latest entry as `lastSummarize`.

## Limits

- Phase 1: policy and persistence are still the shipped Basic backend.
- Real long-session `/compact` verified on the integrated bundle (659 items /
  334,883 tokens); context overflow and crash recovery are still pending.
- Project opt-out is enforced by the flow-tower memory layer (compile/digest/tools);
  the backend skips memory for disallowed projects via `policy.js`.

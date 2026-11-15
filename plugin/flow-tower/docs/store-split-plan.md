# `lib/store.js` split plan

Status: design only. `lib/store.js` is 1357 lines and is the only remaining
non-client exemption above the hard 700-line gate. It stays cohesive today
because every write path shares one SQLite connection, one schema version and
the same transaction helpers. Splitting it is a **refactor of ownership, not a
line-count exercise**.

## Current responsibilities

| Area | Representative methods |
|---|---|
| Open / schema / migrations | `FlowStore.open`, schema bootstrap, pragmas |
| Volume bookkeeping | `ensureVolume`, `getVolume`, `updateVolume`, `listVolumes`, `bumpVersion`, entry counts |
| Entry CRUD + mapping | `insertEntry`, `getEntry`, `updateEntry`, `deleteEntry`, `findEntryByWord`, `recentEntries`, `countEntries` |
| Task views | `openTasks`, `closeTask`, status transitions |
| Compile transaction | `beginRun`, `commitRun`, `discardRun`, `coveredSeqs`, `deferred` seqs |
| Groups / summary / injected state | `rebuildGroups`, `listGroups`, `getInjectedState`, `setInjectedState` |
| Archive / eviction | `archiveEntry`, `restoreArchived`, `listArchived`, `evictOne` |
| Search index | `ensureSearchIndex`, `#indexEntryRecord` |
| Metrics / KV / relation batches | `recordMetric`, `recentMetrics`, `getKv`, `setKv`, `recordRelationBatch` |

## Target layout (facade keeps every public method name)

```
lib/store.js              # FlowStore facade: connection, schema, transaction, delegation
lib/store-entries.js      # entry row mapping, insert/update/delete/find/recent
lib/store-compile.js      # runs, deferred seqs, coverage, injected state, groups
lib/store-maintenance.js  # archive/restore/evict, KV, metrics, relation-batch records
lib/store-search.js       # search_terms indexing helpers (already partially separate)
```

- `FlowStore` keeps `db`, `path`, `transaction` and the public method names;
  collaborators are plain functions that receive the store (`read(store, ...)`),
  then the facade exposes thin wrappers. This avoids prototype mixins and keeps
  every existing call site and test signature unchanged.
- Row mapping (`rowToEntry`, `rowToVolume`, ...) moves to `store-entries.js` and
  becomes the single place that knows snake_case ↔ camelCase.

## Phases (each phase must keep 73 tests green and graph check clean)

1. **Extract pure row mapping + SQL constants** (lowest risk, no behavior).
2. **Extract archive/evict + KV/metrics** (`store-maintenance.js`, ~120 lines).
3. **Extract compile bookkeeping** (runs, deferred, coverage, injected state, groups).
4. **Extract entry CRUD** once mapping is already out of `store.js`.
5. Leave connection/schema/transaction in the facade; aim for `store.js < 400`.

## Invariants to preserve

- One connection per store; no nested `DatabaseSync` instances.
- `transaction()` remains the only write bracket; extracted functions must never
  open their own transactions.
- `bumpVersion` and `entry_count` updates stay atomic with the write that
  changes entries.
- Archive/evict ordering (`archive` before delete) and citations JSON shape.
- `recentEntries` / `openTasks` result fields are public API; tests assert them.

## Exit criteria

- `store.js` under 400 lines, both remaining exemptions removed from
  `module-graph.exemptions.json`.
- All 73 unit tests, graph check, and a live compaction/compile smoke test pass.
- A DB migration/backup path is reviewed before phase 3 lands.

## Risks

- `#indexEntryRecord` is a private method used by every CRUD path; move it with
  the mapping helpers, not with search.
- `updateEntry` currently reindexes and returns void; keep that contract when
  splitting.
- Tests use `FlowStore.open({ dbPath: ':memory:' })`; the facade must keep that
  static factory working for in-memory stores (no lock file paths).

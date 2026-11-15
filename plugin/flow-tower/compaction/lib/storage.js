/**
 * --- module contract ---
 * purpose: Compatibility re-export of the package-level storage resolver for the compaction backend.
 * dependsOn: [generated] lib/storage.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] compaction/index.js, compaction/lib/memory.js
 * publicApi: [generated] *
 * risk: Low: one-line re-export; standalone mirror carries the full implementation.
 * --- end module contract ---
 */

export * from '../../lib/storage.js'

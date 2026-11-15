/**
 * --- module contract ---
 * purpose: Compatibility facade exporting the model-facing tool registry.
 * dependsOn: [generated] lib/tools/index.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] eval/offline-eval.mjs, eval/real-session-eval.mjs, eval/txt-corpus-eval.mjs, index.js, test/flow-tower.test.js
 * publicApi: [generated] buildToolDefinitions
 * risk: Low: thin re-export; existing callers keep this path.
 * --- end module contract ---
 */

export { buildToolDefinitions } from './tools/index.js'

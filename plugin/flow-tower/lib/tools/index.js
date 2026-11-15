/**
 * --- module contract ---
 * purpose: Compose the dict_* tool modules into the model-facing tool list.
 * dependsOn: [generated] lib/tools/browse.js, lib/tools/cite.js, lib/tools/common.js, lib/tools/dev.js, lib/tools/lookup.js, lib/tools/relate.js, lib/tools/search.js, lib/tools/timeline.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/tools.js
 * publicApi: [generated] buildToolDefinitions
 * risk: Low-medium: tool set/order is a public contract; dev tools stay opt-in.
 * --- end module contract ---
 */

import { createToolRuntime } from './common.js'
import { createBrowseTool } from './browse.js'
import { createLookupTool } from './lookup.js'
import { createCiteTool } from './cite.js'
import { createTimelineTool } from './timeline.js'
import { createSearchTool } from './search.js'
import { createRelateTool } from './relate.js'
import { createDevTools } from './dev.js'

/**
 * @param {{
 *   ctx: any,
 *   store?: any,
 *   manager?: any,
 *   config: Readonly<Record<string, any>>,
 *   log: { warn: (message: string) => void },
 *   modelCaller?: any,
 * }} context
 * @returns {any[]}
 */
export function buildToolDefinitions(context) {
  const runtime = createToolRuntime(context)
  const tools = [
    createBrowseTool(runtime),
    createLookupTool(runtime),
    createCiteTool(runtime),
    createTimelineTool(runtime),
    createSearchTool(runtime),
    createRelateTool(runtime),
  ]
  if (context.config.llmCompiler !== 'off' && typeof runtime.modelCaller === 'function') {
    tools.push(...createDevTools(runtime))
  }
  return tools
}

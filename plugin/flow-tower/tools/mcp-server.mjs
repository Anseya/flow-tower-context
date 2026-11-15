#!/usr/bin/env node
/**
 * Read-only MCP server (stdio JSON-RPC) over the project dictionary.
 *
 * Wire it in a DSH MCP client as:
 *   command: node
 *   args: ["<plugin>/tools/mcp-server.mjs", "--project=<project root>"]
 *
 * The server never writes memory; tools mirror the read-only /api/* surface.
 */

import { FlowStore } from '../lib/store.js'
import { dbPathForProject } from '../lib/manager.js'
import { normalizeProjectPath } from '../lib/util.js'
import { browseText, lookupText, searchText, timelineText } from '../lib/catalog.js'
import { nodeIdForEntry, relateText } from '../lib/relations.js'

const args = process.argv.slice(2)
const project = normalizeProjectPath(args.find((arg) => arg.startsWith('--project='))?.slice('--project='.length) ?? process.cwd())
let store = null
function getStore() {
  if (store !== null) return store
  store = FlowStore.open({ dbPath: dbPathForProject(project) })
  return store
}
function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}
const tools = [
  {
    name: 'dict_search',
    description: 'Ranked lexical search over the project dictionary entries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'integer' },
      },
      required: ['query'],
    },
  },
  {
    name: 'dict_lookup',
    description: 'Look up one entry by headword, with citations and see-also links.',
    inputSchema: { type: 'object', properties: { term: { type: 'string' }, volume: { type: 'string' } }, required: ['term'] },
  },
  {
    name: 'dict_browse',
    description: 'Browse the dictionary by kind/module/status/time or as a volume tree.',
    inputSchema: {
      type: 'object',
      properties: {
        tree: { type: 'boolean' }, kind: { type: 'string' }, module: { type: 'string' },
        status: { type: 'string' }, limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'dict_timeline',
    description: 'Entries ordered by last-seen time (newest first).',
    inputSchema: { type: 'object', properties: { kind: { type: 'string' }, limit: { type: 'integer' } } },
  },
  {
    name: 'dict_relate',
    description: 'Typed outgoing/incoming relations for an entry or volume.',
    inputSchema: {
      type: 'object',
      properties: { term: { type: 'string' }, direction: { type: 'string' }, limit: { type: 'integer' } },
      required: ['term'],
    },
  },
  { name: 'dict_status', description: 'Project dictionary counts and latest compile summary.', inputSchema: { type: 'object', properties: {} } },
]
function callTool(name, input = {}) {
  const s = getStore()
  const volumes = s.listVolumes({ limit: 1 })
  const volumeId = volumes[0]?.volumeId ?? ''
  if (name === 'dict_search') {
    const results = s.searchRanked(String(input.query ?? ''), { volumeId, kind: input.kind, limit: Number(input.limit ?? 20) })
    return text(searchText(results, String(input.query ?? '')))
  }
  if (name === 'dict_lookup') {
    return text(lookupText(s, { term: String(input.term ?? ''), volumeId: input.volume ?? volumeId }))
  }
  if (name === 'dict_browse') {
    if (input.tree === true) return text(browseText(s, { volumeId, tree: true, limit: Number(input.limit ?? 40) }))
    return text(browseText(s, { volumeId, kind: input.kind, module: input.module, status: input.status, limit: Number(input.limit ?? 100) }))
  }
  if (name === 'dict_timeline') {
    return text(timelineText(s, { volumeId, kind: input.kind, limit: Number(input.limit ?? 60) }))
  }
  if (name === 'dict_relate') {
    const entry = s.findEntryByWord(volumeId, String(input.term ?? '').toLowerCase())
      ?? s.searchRanked(String(input.term ?? ''), { volumeId, limit: 1 })[0]?.entry
    if (entry === null || entry === undefined) return text(`no entry found for "${input.term}"`)
    return text(relateText(s, nodeIdForEntry(entry.entryId), { direction: input.direction ?? 'both', limit: Number(input.limit ?? 30) }))
  }
  if (name === 'dict_status') {
    const volumes = s.listVolumes({ limit: 500 })
    const relationRow = s.db.prepare("SELECT COUNT(1) AS n FROM relations WHERE status = 'active'").get()
    return text({ project, volumes: volumes.length, entries: volumes.reduce((sum, volume) => sum + volume.entryCount, 0), relations: Number(relationRow?.n ?? 0) })
  }
  throw new Error(`unknown tool ${name}`)
}
function respond(id, result, error) {
  const payload = error !== undefined
    ? { jsonrpc: '2.0', id, error: { code: -32603, message: String(error) } }
    : { jsonrpc: '2.0', id, result }
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line.length === 0) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.method === 'initialize') {
      respond(message.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'context-flow-tower', version: '0.29.0' },
      })
    } else if (message.method === 'notifications/initialized') {
      // no response
    } else if (message.method === 'tools/list') {
      respond(message.id, { tools })
    } else if (message.method === 'tools/call') {
      try { respond(message.id, callTool(message.params?.name, message.params?.arguments ?? {})) }
      catch (error) { respond(message.id, undefined, error instanceof Error ? error.message : String(error)) }
    } else if (message.id !== undefined) {
      respond(message.id, undefined, `unknown method ${message.method}`)
    }
  }
})
process.stdin.on('end', () => {
  try { store?.close() } catch { /* ignore */ }
})

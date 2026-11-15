#!/usr/bin/env node
/**
 * Context-cost report: what Flow Tower injects versus what the native
 * tool-result pruner can save. Read-only: never writes dictionaries or logs.
 *
 * Run: node eval/context-cost.mjs [--file=<session.v4.jsonl.zstd>]
 *        [--db=<flow_tower.db>] [--json]
 */
import { zstdDecompressSync } from 'node:zlib'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { FlowStore } from '../lib/store.js'
import { buildDigest } from '../lib/catalog.js'
import { resolveConfig } from '../lib/config.js'
import { contentToText, estimateTokens } from '../lib/util.js'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const PRUNE_CAP_CHARS = 8000

/** @param {string} file */
function loadSessionLog(file) {
  const raw = readFileSync(file)
  const offsets = []
  let index = raw.indexOf(MAGIC, 0)
  while (index >= 0) {
    offsets.push(index)
    index = raw.indexOf(MAGIC, index + 4)
  }
  if (offsets.length === 0) throw new Error('not a zstd session log')
  let text = offsets[0] > 0 ? raw.subarray(0, offsets[0]).toString('utf8') : ''
  for (let frame = 0; frame < offsets.length; frame += 1) {
    const end = frame + 1 < offsets.length ? offsets[frame + 1] : raw.length
    text += zstdDecompressSync(raw.subarray(offsets[frame], end)).toString('utf8')
  }
  const lines = text.split('\n').filter((line) => line.length > 0)
  const header = JSON.parse(lines[0])
  const events = []
  for (const line of lines.slice(1)) {
    try {
      const event = JSON.parse(line)
      if (Number.isSafeInteger(event?.seq)) events.push(event)
    } catch {
      // Truncated tail.
    }
  }
  return { header, events }
}

/** @returns {string} */
function findDefaultSession() {
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
  const found = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'session.v4.jsonl.zstd') {
        const stat = statSync(full)
        if (stat.size > 100_000) found.push({ file: full, mtime: stat.mtimeMs })
      }
    }
  }
  walk(root)
  found.sort((left, right) => right.mtime - left.mtime)
  if (found.length === 0) throw new Error(`no session log found under ${root}`)
  return found[0].file
}

/** @param {any} event @returns {string} */
function eventText(event) {
  const message = event?.data?.message
  if (message === undefined) {
    const summary = event?.data?.summary
    return summary === undefined ? '' : contentToText(summary)
  }
  return contentToText(message.content)
}

/** @param {string} project @returns {string | null} */
function findDatabase(project) {
  const candidates = []
  if (typeof project === 'string' && project.length > 0) candidates.push(join(project, '.flow-tower', 'flow_tower.db'))
  candidates.push(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'flow-tower', 'flow_tower.db'))
  candidates.push(join(process.cwd(), '.flow-tower', 'flow_tower.db'))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function main() {
  const args = process.argv.slice(2)
  const fileArg = args.find((arg) => arg.startsWith('--file='))
  const dbArg = args.find((arg) => arg.startsWith('--db='))
  const json = args.includes('--json')
  const file = fileArg === undefined ? findDefaultSession() : fileArg.slice('--file='.length)

  const { header, events } = loadSessionLog(file)
  const dbPath = dbArg === undefined ? findDatabase(header?.cwd) : dbArg.slice('--db='.length)
  const toolResults = events
    .filter((event) => event.type === 'tool/result')
    .map((event) => {
      const text = eventText(event)
      return { seq: event.seq, chars: text.length, tokens: estimateTokens(text) }
    })
    .sort((left, right) => right.chars - left.chars)
  const toolChars = toolResults.reduce((sum, item) => sum + item.chars, 0)
  const toolTokens = toolResults.reduce((sum, item) => sum + item.tokens, 0)
  const oversize = toolResults.filter((item) => item.chars > PRUNE_CAP_CHARS)
  const prunableChars = oversize.reduce((sum, item) => sum + Math.max(0, item.chars - PRUNE_CAP_CHARS), 0)

  let usage = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0 }
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const value = event.data?.usage
    if (value === undefined || value === null) continue
    usage.calls += 1
    usage.inputTokens += Number(value.inputTokens ?? 0)
    usage.cacheReadTokens += Number(value.cacheReadTokens ?? 0)
    usage.outputTokens += Number(value.outputTokens ?? 0)
  }
  const compactions = events
    .filter((event) => event.type === 'compaction/summary')
    .map((event) => eventText(event).length)
  const compactionChars = compactions.reduce((sum, item) => sum + item, 0)

  let flow = null
  if (existsSync(dbPath)) {
    const store = new FlowStore(dbPath)
    try {
      const volume = store.listVolumes({ limit: 1 })[0]
      if (volume !== undefined) {
        const config = resolveConfig()
        const digest = buildDigest(store, volume.volumeId, config)
        const metrics = store.recentMetrics({ kind: 'digest-injection', limit: 200 })
        const injected = metrics
          .map((metric) => (metric.data !== null && typeof metric.data === 'object' ? metric.data : null))
          .filter((item) => item !== null)
        const tokens = injected.map((item) => Number(item.tokens ?? 0))
        flow = {
          volume: volume.volumeId,
          entries: volume.entryCount,
          digestTokens: estimateTokens(digest),
          digestChars: digest.length,
          recordedInjections: injected.length,
          averageInjectedTokens: tokens.length === 0 ? null : Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length),
          lastPressureTokens: injected.at(-1)?.pressureTokens ?? null,
          lastContextWindow: injected.at(-1)?.contextWindow ?? null,
          lastBudget: injected.at(-1)?.budget ?? null,
        }
      }
    } finally {
      store.close?.()
    }
  }

  const report = {
    session: { file, project: header?.cwd ?? null, events: events.length },
    toolResults: {
      count: toolResults.length,
      chars: toolChars,
      estimatedTokens: toolTokens,
      largest: toolResults.slice(0, 10),
      oversizeCount: oversize.length,
      prunableChars,
      prunableTokens: Math.round(prunableChars / 3.6),
    },
    usage,
    compaction: {
      count: compactions.length,
      summaryChars: compactionChars,
      averageSummaryChars: compactions.length === 0 ? 0 : Math.round(compactionChars / compactions.length),
    },
    flowTower: flow,
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  process.stdout.write([
    `session: ${file}`,
    `  project=${report.session.project} events=${report.session.events}`,
    `tool results: ${report.toolResults.count} (${report.toolResults.chars} chars)`,
    `  oversize > ${PRUNE_CAP_CHARS} chars: ${report.toolResults.oversizeCount}`,
    `  pruner potential: ${report.toolResults.prunableChars} chars ≈ ${report.toolResults.prunableTokens} tokens`,
    `  largest: ${report.toolResults.largest.slice(0, 5).map((item) => `seq ${item.seq}:${item.chars}`).join(', ')}`,
    `usage: calls=${usage.calls} input=${usage.inputTokens} cacheRead=${usage.cacheReadTokens} output=${usage.outputTokens}`,
    `compaction summaries: ${report.compaction.count} (avg ${report.compaction.averageSummaryChars} chars)`,
    flow === null
      ? 'flow-tower: no database at this path'
      : `flow-tower: digest=${flow.digestTokens} tokens, entries=${flow.entries}, recorded injections=${flow.recordedInjections}, avg injected=${flow.averageInjectedTokens ?? 'n/a'} tokens, budget=${flow.lastBudget ?? 'n/a'}, pressure=${flow.lastPressureTokens ?? 'n/a'}/${flow.lastContextWindow ?? 'n/a'}`,
    '',
    'Interpretation: pruner potential is the upper bound of context the native',
    'tool-result pruner can remove; digest tokens are Flow Tower’s per-injection',
    'overhead. Compare them before tuning either budget.',
    '',
  ].join('\n'))
}

main()

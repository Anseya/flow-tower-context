#!/usr/bin/env node
/**
 * Shadow precision report: scans persisted shadow samples
 * (`<project>/.flow-tower/shadow/*.json`) and summarizes proposal counts,
 * latency and a **heuristic precision proxy** (not human ground truth):
 *
 *  - meta       → matched process-noise patterns (filtered by llm-filter)
 *  - durable    → decision/task/feature/error/topic/chapter/person, gloss ≥ 12 chars
 *  - weak       → file/command/api-symbol/other or very short gloss
 *  - precision  = durable / accepted
 *
 * Run: node eval/shadow-report.mjs --project=<abs project root> [--json]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeProjectPath } from '../lib/util.js'
import { isMetaProposal } from '../lib/llm-filter.js'

const DURABLE_KINDS = new Set(['decision', 'task', 'feature', 'error', 'topic', 'chapter', 'person'])
const args = process.argv.slice(2)
const project = normalizeProjectPath(args.find((arg) => arg.startsWith('--project='))?.slice('--project='.length) ?? process.cwd())
const json = args.includes('--json')
const dir = join(project, '.flow-tower', 'shadow')
let files = []
try {
  files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
} catch {
  files = []
}
function classify(entry) {
  if (isMetaProposal(entry)) return 'meta'
  const gloss = String(entry?.gloss ?? '').trim()
  if (DURABLE_KINDS.has(entry?.kind) && gloss.length >= 12) return 'durable'
  return 'weak'
}
const rows = []
for (const name of files) {
  try {
    const data = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    const entries = Array.isArray(data.entries) ? data.entries : []
    const classes = entries.map(classify)
    const meta = classes.filter((item) => item === 'meta').length
    const durable = classes.filter((item) => item === 'durable').length
    const weak = classes.filter((item) => item === 'weak').length
    rows.push({
      file: name,
      at: data.at ?? null,
      samples: data.samples ?? null,
      accepted: entries.length,
      rejected: Array.isArray(data.rejected) ? data.rejected.length : 0,
      meta, durable, weak,
      precision: entries.length === 0 ? null : Number((durable / entries.length).toFixed(2)),
      ms: data.ms ?? null,
      model: data.diagnostics?.model ?? null,
    })
  } catch {
    // Skip malformed sample.
  }
}
const totals = rows.reduce((acc, row) => {
  acc.accepted += row.accepted
  acc.rejected += row.rejected
  acc.meta += row.meta
  acc.durable += row.durable
  acc.weak += row.weak
  return acc
}, { accepted: 0, rejected: 0, meta: 0, durable: 0, weak: 0 })
const report = {
  project,
  dir,
  batches: rows.length,
  totals: { ...totals, precision: totals.accepted === 0 ? null : Number((totals.durable / totals.accepted).toFixed(2)) },
  rows,
  pass: rows.length === 0 ? null : totals.durable / Math.max(1, totals.accepted) >= 0.8,
}
if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
else {
  process.stdout.write('flow-tower shadow precision report (heuristic proxy)\n')
  for (const row of rows) {
    process.stdout.write(`  ${row.file}: accepted=${row.accepted} rejected=${row.rejected} durable=${row.durable} weak=${row.weak} meta=${row.meta} precision=${row.precision} ms=${row.ms} model=${row.model}\n`)
  }
  process.stdout.write(`  batches=${report.batches} totals=${JSON.stringify(report.totals)} pass(≥0.8)=${report.pass}\n`)
  if (rows.length === 0) process.stdout.write('  (run dict_shadow_probe with llmCompiler=shadow first)\n')
}

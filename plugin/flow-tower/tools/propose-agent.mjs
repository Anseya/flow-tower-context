#!/usr/bin/env node
/**
 * LLM proposal generator ("who writes the proposals"): asks an OpenAI-compatible
 * chat model to turn a compaction delta into validated dictionary entries, then
 * writes a proposal JSON into `<project>/.flow-tower/proposals/`.
 *
 * The plugin never calls a model by itself; this tool is the optional producer
 * side of the validated-fold pipeline (`proposalMode: 'shadow' | 'on'`).
 *
 * Run:
 *   FLOW_TOWER_LLM_API_KEY=... FLOW_TOWER_LLM_BASE_URL=https://api.deepseek.com/v1 \
 *   node tools/propose-agent.mjs --file=delta.json --project=<abs project root>
 *
 * Env: FLOW_TOWER_LLM_API_KEY, FLOW_TOWER_LLM_BASE_URL, FLOW_TOWER_LLM_MODEL.
 * Offline-testable: `buildProposalPrompt`, `parseProposalJson`, `generateProposalsFromText`.
 */

import { readFileSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateProposal, proposalsDir } from '../lib/proposals.js'
import { buildProposalPrompt, parseProposalJson } from '../lib/llm-prompt.js'
export { buildProposalPrompt, parseProposalJson }
import { resolveConfig } from '../lib/config.js'

/**
 * @param {{ seq: number, text: string }[]} samples
 * @param {{ maxEntries?: number, existing?: string[] }} [options]
 * @returns {string}
 */
/**
 * Extract the first JSON object from model output (fenced or bare).
 * @param {string} text
 * @returns {any | null}
 */
/**
 * Generate + validate proposals from text samples using a caller.
 * @param {{ seq: number, text: string }[]} samples
 * @param {{ callModel: (prompt: string) => Promise<string>, maxEntries?: number,
 *   existing?: string[], config?: any }} options
 * @returns {Promise<{ entries: any[], rejected: any[], raw: string | null }>}
 */
export async function generateProposalsFromText(samples, options) {
  const config = options.config ?? resolveConfig()
  const prompt = buildProposalPrompt(samples, {
    maxEntries: options.maxEntries ?? 20,
    existing: options.existing,
  })
  const raw = await options.callModel(prompt)
  const parsed = parseProposalJson(raw)
  if (parsed === null) return { entries: [], rejected: [{ index: -1, reason: 'model output is not JSON' }], raw }
  const allowed = new Set(samples.map((sample) => sample.seq))
  const validated = validateProposal(parsed, config)
  const entries = []
  const rejected = [...validated.rejected]
  validated.entries.forEach((entry, index) => {
    const citations = entry.citations.filter((seq) => allowed.has(seq))
    if (citations.length === 0) {
      rejected.push({ index, reason: 'citations do not reference the provided seqs' })
      return
    }
    entries.push({ ...entry, citations })
  })
  return { entries, rejected, raw }
}

/**
 * Write a proposal file into the project's proposals directory.
 * @param {string} project
 * @param {readonly any[]} entries
 * @param {{ now?: number }} [options]
 * @returns {string} path written
 */
export function writeProposal(project, entries, options = {}) {
  const dir = proposalsDir(project)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `llm-${options.now ?? Date.now()}.json`)
  writeFileSync(file, JSON.stringify({ entries, source: 'llm-proposer' }, null, 2), 'utf8')
  return file
}

/**
 * Read samples from a JSON array or a text file (one line per sample).
 * @param {string} file
 */
export function readSamples(file) {
  const raw = readFileSync(file, 'utf8')
  if (raw.trimStart().startsWith('[')) {
    const parsed = JSON.parse(raw)
    return parsed.map((item, index) => ({ seq: Number.isSafeInteger(item.seq) ? item.seq : index, text: String(item.text ?? '') }))
  }
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
    .map((line, index) => ({ seq: index, text: line }))
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = process.argv.slice(2)
  const file = args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length)
  const project = args.find((arg) => arg.startsWith('--project='))?.slice('--project='.length) ?? process.cwd()
  if (file === undefined) {
    process.stderr.write('usage: node tools/propose-agent.mjs --file=<delta.json|txt> --project=<root> [--max-entries=20]\n')
    process.exitCode = 2
  } else {
    const baseUrl = process.env.FLOW_TOWER_LLM_BASE_URL ?? 'https://api.deepseek.com/v1'
    const apiKey = process.env.FLOW_TOWER_LLM_API_KEY
    const model = process.env.FLOW_TOWER_LLM_MODEL ?? 'deepseek-chat'
    const maxEntries = Number(args.find((arg) => arg.startsWith('--max-entries='))?.split('=')[1] ?? 20) || 20
    if (apiKey === undefined) {
      process.stderr.write('FLOW_TOWER_LLM_API_KEY is required (or use the exported functions with a custom caller).\n')
      process.exitCode = 2
    } else {
      const callModel = async (prompt) => {
        const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
              { role: 'system', content: 'Return JSON only.' },
              { role: 'user', content: prompt },
            ],
          }),
        })
        if (!response.ok) throw new Error(`LLM request failed: ${response.status}`)
        const data = await response.json()
        return String(data?.choices?.[0]?.message?.content ?? '')
      }
      generateProposalsFromText(readSamples(file), { callModel, maxEntries })
        .then((result) => {
          if (result.entries.length === 0) {
            process.stderr.write(`no valid proposals (rejected=${result.rejected.length})\n`)
            process.exitCode = 1
            return
          }
          const path = writeProposal(project, result.entries)
          process.stdout.write(`wrote ${result.entries.length} proposal(s) to ${path}\n`)
        })
        .catch((error) => {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
          process.exitCode = 1
        })
    }
  }
}

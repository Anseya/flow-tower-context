/**
 * --- module contract ---
 * purpose: Validate and commit host-LLM proposal files against deterministic evidence.
 * dependsOn: [generated] lib/extract.js, lib/store.js, lib/util.js, lib/vocabulary.js
 * externalDeps: [generated] node:crypto, node:fs, node:path
 * usedBy: [generated] lib/compiler.js, lib/llm.js, test/flow-tower.test.js, tools/propose-agent.mjs
 * publicApi: [generated] PROPOSALS_DIRNAME, commitProposalEntries, processProposals, proposalsDir, validateProposal
 * risk: Medium: writes entries only after citation validation; default is off.
 * --- end module contract ---
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { ENTRY_KINDS, deriveModule } from './extract.js'
import { citeIdFor, entryIdFor, normHeadword } from './vocabulary.js'
import { clampChars, clampTokens } from './util.js'

/** Directory holding proposal files for one project. */
export const PROPOSALS_DIRNAME = 'proposals'

/**
 * @param {string} project normalized project path
 * @returns {string}
 */
export function proposalsDir(project) {
  return join(project.replaceAll('/', process.platform === 'win32' ? '\\' : '/'), '.flow-tower', PROPOSALS_DIRNAME)
}

/**
 * Validate one parsed proposal document.
 * @param {any} raw
 * @param {{ maxEntries: number, glossTokens: number, maxCitationsPerEntry: number }} config
 * @returns {{ entries: any[], rejected: { index: number, reason: string }[] }}
 */
export function validateProposal(raw, config) {
  const entries = []
  const rejected = []
  const list = Array.isArray(raw?.entries) ? raw.entries : []
  if (list.length === 0) {
    return { entries, rejected: [{ index: -1, reason: 'proposal has no entries' }] }
  }
  list.slice(0, config.maxEntries).forEach((entry, index) => {
    const fail = (reason) => rejected.push({ index, reason })
    if (entry === null || typeof entry !== 'object') return fail('entry is not an object')
    const kind = typeof entry.kind === 'string' ? entry.kind : ''
    if (!ENTRY_KINDS.includes(kind)) return fail(`unsupported kind "${kind}"`)
    const headword = typeof entry.headword === 'string' ? entry.headword.trim() : ''
    if (headword.length < 2 || headword.length > 120) return fail('headword must be 2-120 chars')
    const gloss = typeof entry.gloss === 'string' ? entry.gloss.trim() : ''
    if (gloss.length < 2) return fail('gloss is empty')
    const citations = Array.isArray(entry.citations)
      ? entry.citations.filter((seq) => Number.isSafeInteger(seq) && seq >= 0)
      : []
    if (citations.length === 0) return fail('at least one citation seq is required')
    if (citations.length > config.maxCitationsPerEntry) return fail('too many citations')
    const aliases = Array.isArray(entry.aliases)
      ? entry.aliases
        .filter((alias) => typeof alias === 'string')
        .map((alias) => alias.trim())
        .filter((alias) => alias.length >= 2 && alias.length <= 60 && alias !== headword)
        .slice(0, 8)
      : []
    if (kind === 'task' && entry.status !== undefined && entry.status !== 'open' && entry.status !== 'done') {
      return fail('task status must be open|done')
    }
    entries.push({
      kind,
      headword,
      gloss: clampTokens(gloss, config.glossTokens),
      ...(aliases.length > 0 ? { aliases } : {}),
      citations: [...new Set(citations)],
      ...(kind === 'task' ? { status: entry.status ?? 'open' } : {}),
      ...(typeof entry.module === 'string' && entry.module.length > 0
        ? { module: entry.module }
        : kind === 'file' || kind === 'api-symbol' ? { module: deriveModule(headword) } : {}),
      ...(Array.isArray(entry.related) ? { related: entry.related.filter((id) => typeof id === 'string') } : {}),
    })
    return undefined
  })
  return { entries, rejected }
}

/**
 * Commit validated entries into one volume (same shape as deterministic
 * entries: entries + citations; no raw text copied).
 * @param {import('./store.js').FlowStore} store
 * @param {string} volumeId
 * @param {readonly any[]} entries
 * @param {{ now: number, maxCiteExcerptChars: number }} options
 * @returns {{ created: number, updated: number, citations: number }}
 */
export function commitProposalEntries(store, volumeId, entries, options) {
  const { now } = options
  const stats = { created: 0, updated: 0, citations: 0 }
  store.transaction(() => {
    for (const entry of entries) {
      const norm = normHeadword(entry.kind, entry.headword)
      if (norm.length < 2) continue
      let target = store.findEntryByWord(volumeId, norm)
      if (target === null) {
        target = {
          entryId: entryIdFor(volumeId, norm),
          volumeId,
          kind: entry.kind,
          headword: entry.headword,
          headwordNorm: norm,
          aliases: entry.aliases ?? [],
          gloss: entry.gloss,
          module: entry.module ?? '',
          status: entry.kind === 'task' ? (entry.status ?? 'open') : '',
          statusSeq: entry.kind === 'task' ? Math.max(...entry.citations) : -1,
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        }
        store.insertEntry(target)
        stats.created += 1
        store.addEntryCount(volumeId, 1, now)
      } else {
        store.updateEntry(target.entryId, {
          gloss: target.gloss.length >= entry.gloss.length ? target.gloss : entry.gloss,
          ...(Array.isArray(entry.aliases) && entry.aliases.length > 0
            ? { aliases: [...new Set([...(target.aliases ?? []), ...entry.aliases])].slice(0, 8) }
            : {}),
          ...(target.module === '' && entry.module ? { module: entry.module } : {}),
          ...(target.kind === 'task' && entry.status === 'done'
            ? { status: 'done', statusSeq: Math.max(...entry.citations) }
            : {}),
          lastSeenAt: now,
        }, now)
        stats.updated += 1
      }
      for (const seq of entry.citations) {
        const inserted = store.insertCitation({
          citeId: citeIdFor(target.entryId, volumeId, seq),
          entryId: target.entryId,
          sessionId: volumeId,
          seqStart: seq,
          seqEnd: seq,
          eventTime: 0,
          excerpt: clampChars(entry.gloss, options.maxCiteExcerptChars ?? 200),
          createdAt: now,
        })
        if (inserted) stats.citations += 1
      }
    }
  })
  return stats
}

/**
 * Process every pending proposal file of one project/volume.
 * @param {import('./store.js').FlowStore} store
 * @param {string} volumeId
 * @param {string} project normalized project path
 * @param {{ mode: 'off'|'shadow'|'on', config: any, log: any, now?: number }} options
 * @returns {{ files: number, accepted: number, rejected: number, committed: number, skipped: number }}
 */
export function processProposals(store, volumeId, project, options) {
  const stats = { files: 0, accepted: 0, rejected: 0, committed: 0, skipped: 0 }
  if (options.mode === 'off' || project.length === 0) return stats
  const dir = proposalsDir(project)
  if (!existsSync(dir)) return stats
  const now = options.now ?? Date.now()
  let names = []
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return stats
  }
  for (const name of names) {
    const file = join(dir, name)
    let raw
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      options.log?.warn?.(`proposal ${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const hash = createHash('sha1').update(JSON.stringify(raw)).digest('hex').slice(0, 16)
    const previous = store.getProposalRun(hash)
    if (previous !== null && previous.committed === 1) {
      stats.skipped += 1
      continue
    }
    const validated = validateProposal(raw, options.config)
    stats.files += 1
    stats.accepted += validated.entries.length
    stats.rejected += validated.rejected.length
    if (options.mode === 'shadow') {
      store.recordProposalRun({
        hash, fileName: name, mode: 'shadow', accepted: validated.entries.length,
        rejected: validated.rejected.length, committed: 0, now,
      })
      options.log?.info?.(`proposal ${name}: shadow accepted=${validated.entries.length} rejected=${validated.rejected.length}`)
      continue
    }
    try {
      const committed = commitProposalEntries(store, volumeId, validated.entries, {
        now,
        maxCiteExcerptChars: options.config.maxCiteExcerptChars,
      })
      store.recordProposalRun({
        hash, fileName: name, mode: 'on', accepted: validated.entries.length,
        rejected: validated.rejected.length, committed: 1, now,
      })
      store.bumpVersion(volumeId, now)
      store.rebuildGroups(volumeId)
      stats.committed += committed.created + committed.updated
      try {
        mkdirSync(join(dir, 'processed'), { recursive: true })
        renameSync(file, join(dir, 'processed', `${Date.now()}-${name}`))
      } catch {
        // File moves are best-effort; the audit row prevents double commit.
      }
      options.log?.info?.(`proposal ${name}: committed created=${committed.created} updated=${committed.updated}`)
    } catch (error) {
      options.log?.warn?.(`proposal ${name} commit failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return stats
}

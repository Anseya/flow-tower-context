/**
 * --- module contract ---
 * purpose: Recoverable maintenance for already-compiled dictionaries: archive noise and attribute modules from cited evidence.
 * dependsOn: [generated] lib/extract.js, lib/vocabulary.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] index.js, test/flow-tower.test.js
 * publicApi: [generated] attributeModules, cleanupNoise, runMaintenance
 * risk: Medium: mutates compiled entries; every removal is archived first and a report is returned.
 * --- end module contract ---
 */

import { deriveModule } from './extract.js'
import { taskQuality, TASK_NOISE_RE } from './vocabulary.js'

/** Text-only markers that prove an entry came from this plugin's own digest/tool dump. */
const SELF_RE = /(?:\[flow-tower\]|<\/?flow-tower-dictionary>|---\s*(?:digest|stats|memory)\s*---|Project memory \(decisions|Project map\b)/i
/** Source-line dumps such as `39: * "..."` or `177: 178: // Task`. */
const LINE_DUMP_RE = /(?:^|\s)\d+\s*[:：]\s|\b\d+\s+[+*]\s+["“']|\b\d+\s+[+*]\s/
/** Clipped digest excerpts are not usable entries. */
const CLIPPED_RE = /…/
/** Two or more numbered source markers in one headword = source-line dump. */
const STRING_DUMP_RE = /(?:^|\s)\d+\s*[:：][\s\S]*(?:^|\s)\d+\s*[:：]/
/** Fragments copied out of test/benchmark output. */
const TEST_OUT_RE = /^(?:\d+(?:\.\d+)?ms\)|[\s✔✖]|AssertionError|entries=\d+|Line\s+\d+\b)/
/** Advice/conditional prose, not a work item or decision. */
const ADVICE_RE = /^(?:建议|推荐|我建议|如果你|若你|假如你|要我做|可选|可以选|要不要|你如果)/u
/** External or generated paths are not project entries. */
const EXTERNAL_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|var|etc|opt|usr|Program)\b)/
const GENERATED_PATH_RE = /(?:node_modules|app\.asar|[\\/]\.dsh[\\/]|\\Temp\\|\\tmp\\)/i
/** File-ish token inside a citation excerpt. */
const CITED_FILE_RE = /(?<![\w:])(?:[A-Za-z]:[\\/])?(?:[\w.@~-]+[\\/])*[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|yml|yaml|toml|sql|css|html|sh|ps1|go|rs)\b/g

/**
 * @param {any} entry
 * @returns {string} the reason it is noise, or '' when usable
 */
function noiseReason(entry) {
  const head = String(entry?.headword ?? '').trim()
  const gloss = String(entry?.gloss ?? '').trim()
  const contentKind = entry.kind === 'task' || entry.kind === 'decision' || entry.kind === 'feature'
  if (head.length === 0) return 'empty'
  if (SELF_RE.test(head)) return 'self-digest'
  if (entry.kind === 'file') {
    // External files may still be useful evidence (DSH sources etc.); the map
    // already hides non-workspace paths, so only self-digest residue is removed.
    if (SELF_RE.test(gloss) || SELF_RE.test(head)) return 'self-digest'
    return ''
  }
  if (!contentKind) return ''
  if (entry.kind === 'task') {
    if (CLIPPED_RE.test(head)) return 'clipped'
    if (LINE_DUMP_RE.test(head) || LINE_DUMP_RE.test(gloss)) return 'line-dump'
    if (EXTERNAL_PATH_RE.test(head) || GENERATED_PATH_RE.test(head)) return 'external-path'
    if (TASK_NOISE_RE.test(head)) return 'task-noise'
    if (ADVICE_RE.test(head)) return 'advice'
    if (taskQuality(entry) < 4) return 'task-quality'
    return ''
  }
  // Decisions/features are conservative: only obvious dumps and test-output
  // fragments are archived, because a numbered list item can still be a real
  // design decision.
  if (SELF_RE.test(gloss)) return 'self-digest'
  if (STRING_DUMP_RE.test(head) || TEST_OUT_RE.test(head)) return 'line-dump'
  if (head.length > 140) return 'clipped'
  return ''
}

/**
 * Attribute empty module fields from the first project file cited by the entry.
 * @param {any} store
 * @param {string} volumeId
 * @param {string} [project]
 * @returns {{ scanned: number, attributed: number }}
 */
export function attributeModules(store, volumeId, project = '') {
  const volume = store.getVolume(volumeId)
  const root = project || volume?.project || ''
  const rows = store.db.prepare(
    `SELECT entry_id, kind, module FROM entries
     WHERE volume_id = ? AND kind IN ('task','feature','decision') AND (module IS NULL OR module = '')`,
  ).all(volumeId)
  let attributed = 0
  for (const row of rows) {
    let module = ''
    for (const citation of store.citationsFor(row.entry_id)) {
      const excerpt = String(citation.excerpt ?? '')
      CITED_FILE_RE.lastIndex = 0
      for (let match = CITED_FILE_RE.exec(excerpt); match !== null; match = CITED_FILE_RE.exec(excerpt)) {
        const candidate = match[0]
        if (EXTERNAL_PATH_RE.test(candidate)) continue
        const derived = deriveModule(candidate, root)
        if (derived.length > 0) { module = derived; break }
      }
      if (module.length > 0) break
    }
    if (module.length > 0) {
      store.updateEntry(row.entry_id, { module })
      attributed += 1
    }
  }
  return { scanned: rows.length, attributed }
}

/**
 * Archive entries that are demonstrably harness/tool noise. Entries stay
 * recoverable through the existing archive table.
 * @param {any} store
 * @param {string} volumeId
 * @param {{ kinds?: string[], dryRun?: boolean }} [options]
 * @returns {{ scanned: number, archived: { entryId: string, kind: string, headword: string, reason: string }[] }}
 */
export function cleanupNoise(store, volumeId, options = {}) {
  const kinds = Array.isArray(options.kinds) ? options.kinds : ['task', 'decision', 'feature', 'file', 'api-symbol', 'error']
  const placeholders = kinds.map(() => '?').join(',')
  const rows = store.db.prepare(
    `SELECT entry_id, kind, headword, gloss, module, status FROM entries
     WHERE volume_id = ? AND kind IN (${placeholders})`,
  ).all(volumeId, ...kinds)
  const archived = []
  for (const row of rows) {
    const reason = noiseReason(row)
    if (reason.length === 0) continue
    archived.push({ entryId: row.entry_id, kind: row.kind, headword: row.headword, reason })
    if (options.dryRun !== true) {
      store.archiveEntry(row.entry_id)
      store.deleteEntry(row.entry_id)
    }
  }
  return { scanned: rows.length, archived }
}

/**
 * Run the standard repair pass for one volume: archive noise, attribute
 * modules, bump the dictionary version so the next turn re-injects, and store
 * a bounded report for the web panel/status.
 * @param {any} store
 * @param {string} volumeId
 * @param {{ dryRun?: boolean, kinds?: string[], project?: string, now?: number }} [options]
 * @returns {{ volumeId: string, scanned: number, archived: any[], attributed: number, skipped: boolean }}
 */
export function runMaintenance(store, volumeId, options = {}) {
  const now = Number(options.now) || Date.now()
  const marker = `maintenance:v1:${volumeId}`
  const volume = store.getVolume(volumeId)
  if (volume === null) return { volumeId, scanned: 0, archived: [], attributed: 0, skipped: true }
  // The same dictionary version is repaired at most once; a new compile bumps
  // the version, so later noise still gets a chance to be swept.
  const seen = store.getKv?.(marker)
  if (seen === String(volume.version) && options.force !== true) {
    return { volumeId, scanned: 0, archived: [], attributed: 0, skipped: true }
  }
  const cleanup = cleanupNoise(store, volumeId, options)
  const attribution = options.dryRun === true ? { attributed: 0 } : attributeModules(store, volumeId, options.project)
  const report = { volumeId, scanned: cleanup.scanned, archived: cleanup.archived, attributed: attribution.attributed, skipped: false }
  if (options.dryRun !== true) {
    if (cleanup.archived.length > 0) store.bumpVersion(volumeId, now)
    try {
      store.setKv?.(marker, String(store.getVolume(volumeId)?.version ?? volume.version))
      store.recordMetric?.({
        volumeId,
        kind: 'maintenance',
        data: { archived: cleanup.archived.length, scanned: cleanup.scanned, attributed: attribution.attributed },
        now,
      })
    } catch {
      // Diagnostics only.
    }
  }
  return report
}

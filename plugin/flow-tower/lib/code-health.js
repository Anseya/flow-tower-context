/**
 * --- module contract ---
 * purpose: Bounded source-shape measurement for map "decoupling debt" hints (file counts, line totals, oversize files).
 * dependsOn: [generated] (none)
 * externalDeps: [generated] node:fs, node:path
 * usedBy: [generated] lib/brief.js, test/flow-tower.test.js
 * publicApi: [generated] WARN_LINES, moduleDebt
 * risk: Low: read-only bounded scan with a short cache; a missing/unreadable module simply yields no hint.
 * --- end module contract ---
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Files above this many lines are flagged as decoupling debt. */
export const WARN_LINES = 400

const SOURCE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.kt',
  '.cs', '.rb', '.php', '.swift', '.lua', '.vue', '.svelte', '.sh', '.ps1',
])
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'target', 'vendor',
  '.flow-tower', '.cache', 'out', 'bin', 'obj', 'test', 'tests', '__tests__', 'eval',
])
/** Reference/design trees are not our decoupling debt. */
const NON_CODE_ROOTS = new Set([
  'references', 'papers', 'docs', 'design', 'assets', 'vendor', 'third_party',
  'external', 'fixtures', 'data', 'downloads', 'media',
])
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i
const MAX_FILES = 400
const MAX_DEPTH = 6
const CACHE_TTL_MS = 30_000
/** @type {Map<string, { at: number, value: any }>} */
const cache = new Map()

/**
 * @param {string} dir
 * @param {string} root
 * @param {{ files: number, lines: number, oversize: number, largest: { path: string, lines: number } | null, truncated: boolean }} state
 * @param {number} depth
 */
function walk(dir, root, state, depth) {
  if (depth > MAX_DEPTH || state.truncated) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (state.files >= MAX_FILES) { state.truncated = true; return }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(join(dir, entry.name), root, state, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    if (TEST_FILE_RE.test(entry.name)) continue
    const dot = entry.name.lastIndexOf('.')
    if (dot < 0 || !SOURCE_EXT.has(entry.name.slice(dot).toLowerCase())) continue
    let stats
    try { stats = statSync(join(dir, entry.name)) } catch { continue }
    if (stats.size > 2 * 1024 * 1024) continue
    let lines = 0
    try {
      lines = readFileSync(join(dir, entry.name), 'utf8').split('\n').length
    } catch {
      continue
    }
    state.files += 1
    state.lines += lines
    const relativePath = relative(root, join(dir, entry.name)).replaceAll('\\', '/')
    if (lines > WARN_LINES) state.oversize += 1
    if (state.largest === null || lines > state.largest.lines) state.largest = { path: relativePath, lines }
  }
}

/**
 * Measure one module directory for map rendering.
 * @param {string} projectRoot normalized or native project root
 * @param {string} module module-relative directory such as `plugin/flow-tower`
 * @returns {{ files: number, lines: number, oversize: number, largest: { path: string, lines: number } | null, truncated: boolean } | null}
 */
export function moduleDebt(projectRoot, module) {
  const root = String(projectRoot ?? '')
  const rel = String(module ?? '')
  if (root.length === 0 || rel.length === 0 || rel === '(root)') return null
  if (NON_CODE_ROOTS.has(rel.split(/[\\/]/)[0].toLowerCase())) return null
  const key = `${root}\u0000${rel}`
  const cached = cache.get(key)
  const now = Date.now()
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) return cached.value
  const dir = join(root, rel)
  const state = { files: 0, lines: 0, oversize: 0, largest: null, truncated: false }
  walk(dir, root, state, 0)
  const value = state.files === 0 ? null : state
  if (cache.size > 200) cache.clear()
  cache.set(key, { at: now, value })
  return value
}

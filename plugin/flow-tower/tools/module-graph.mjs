#!/usr/bin/env node
/**
 * Module contract + dependency-graph tool.
 *
 * Purpose: scan every module under plugin/flow-tower, extract real import
 * edges, verify the contract headers' generated dependency lines, detect
 * dangling references and cycles, and write the reverse index.
 *
 * Usage:
 *   node tools/module-graph.mjs --check   # CI: fail on drift/cycles/missing contracts
 *   node tools/module-graph.mjs --write   # update generated dependsOn/usedBy/publicApi lines
 *   node tools/module-graph.mjs --bootstrap <json>
 *
 * The generated lines inside a contract block are the only write target:
 *   * dependsOn: [generated] ...
 *   * usedBy: [generated] ...
 *   * publicApi: [generated] ...
 * External dependencies are listed on `externalDeps`.
 *
 * Contract blocks live at the top of a file:
 *   /**
 *    * --- module contract ---
 *    * purpose: ...
 *    * dependsOn: [generated] ...
 *    * externalDeps: [generated] ...
 *    * usedBy: [generated] ...
 *    * publicApi: [generated] ...
 *    * risk: ...
 *    * --- end module contract ---
 *    *\/
 *
 * Only `purpose` and `risk` are manually owned. Everything in a
 * `[generated]` line is derived from code; do not hand-edit those lines.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS_DIR = join(ROOT, 'docs')
const GRAPH_FILE = join(DOCS_DIR, 'module-graph.json')
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'docs'])
const CONTRACT_SCOPE = [
  (path) => path === 'index.js',
  (path) => path === 'client.js',
  (path) => path.startsWith('lib/'),
  (path) => path.startsWith('compaction/'),
]
const DEV_ONLY = [
  (path) => path.startsWith('test/'),
  (path) => path.startsWith('eval/'),
  (path) => path.startsWith('tools/'),
]

/** Soft target per implementation file; above FAIL requires a registered exemption. */
const LOC_WARN = 400
const LOC_FAIL = 700
const EXEMPTIONS_FILE = join(ROOT, 'module-graph.exemptions.json')

/** @returns {{files: Record<string, {reason?: string, owner?: string, reviewBy?: string}>}} */
function readExemptions() {
  if (!existsSync(EXEMPTIONS_FILE)) return { files: {} }
  try {
    const parsed = JSON.parse(readFileSync(EXEMPTIONS_FILE, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && parsed.files !== null && typeof parsed.files === 'object'
      ? { files: parsed.files }
      : { files: {} }
  } catch (error) {
    console.error(`module graph: invalid ${relative(process.cwd(), EXEMPTIONS_FILE)}: ${error instanceof Error ? error.message : String(error)}`)
    return { files: {} }
  }
}

const START_MARK = '--- module contract ---'
const END_MARK = '--- end module contract ---'

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (stat.isDirectory()) walk(full, out)
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(full)
  }
}

/** @param {string} value */
function toPosix(value) {
  return value.split(sep).join('/')
}

/** @param {string} file @param {string} root */
function rel(file, root = ROOT) {
  return toPosix(relative(root, file))
}

/** @param {string} path */
function isContractPath(path) {
  return CONTRACT_SCOPE.some((test) => test(path))
}

/** @param {string} path */
function isDevOnly(path) {
  return DEV_ONLY.some((test) => test(path))
}

/** @param {string} spec @param {string} fromFile @param {Set<string>} known */
function resolveLocal(spec, fromFile, known) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null
  const base = resolve(dirname(fromFile), spec)
  const candidates = [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js'), join(base, 'index.mjs')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return rel(candidate)
  }
  return { dangling: spec }
}

/** @param {string} text */
function parseImports(text) {
  const specifiers = []
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:[^'"]*?\s+from\s+)['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specifiers.push(match[1])
  }
  return [...new Set(specifiers)]
}

/** @param {string} text */
function parseExports(text) {
  const names = new Set()
  for (const match of text.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1])
  if (/\bexport\s+default\b/.test(text)) names.add('default')
  for (const match of text.matchAll(/\bexport\s*\{([^}]*)\}(?:\s*from\s*['"][^'"]+['"])?/g)) {
    for (const part of match[1].split(',')) {
      const cleaned = part.trim().replace(/\s+as\s+/, ' as ')
      if (cleaned.length === 0) continue
      const alias = cleaned.includes(' as ') ? cleaned.split(' as ')[1].trim() : cleaned
      if (alias.length > 0) names.add(alias)
    }
  }
  if (/\bexport\s+\*\s+from\b/.test(text)) names.add('*')
  return [...names].sort()
}

/** @param {string} text */
function contractBlockRange(text) {
  const lines = text.split('\n')
  const marker = lines.findIndex((line) => line.includes(START_MARK))
  if (marker < 0) return null
  const endMarker = lines.findIndex((line, index) => index > marker && line.includes(END_MARK))
  if (endMarker < 0) return null
  let start = marker
  while (start > 0 && lines[start - 1].trim() === '/**') start -= 1
  if (!lines[start].includes('/**')) {
    while (start > 0 && !lines[start].includes('/**')) start -= 1
  }
  let end = endMarker
  while (end + 1 < lines.length && lines[end + 1].trim() === '*/') end += 1
  if (!lines[end].includes('*/')) {
    while (end + 1 < lines.length && !lines[end].includes('*/')) end += 1
  }
  return { lines, start, end }
}

/** @param {string} text @param {{dependsOn: string[], externalDeps: string[], usedBy: string[], publicApi: string[]}} data */
function renderContract(text, data, bootstrap) {
  const block = [
    '/**',
    ` * ${START_MARK}`,
    ` * purpose: ${bootstrap?.purpose ?? 'TODO: one-sentence responsibility.'}`,
    ` * dependsOn: [generated] ${data.dependsOn.length > 0 ? data.dependsOn.join(', ') : '(none)'}`,
    ` * externalDeps: [generated] ${data.externalDeps.length > 0 ? data.externalDeps.join(', ') : '(none)'}`,
    ` * usedBy: [generated] ${data.usedBy.length > 0 ? data.usedBy.join(', ') : '(none)'}`,
    ` * publicApi: [generated] ${data.publicApi.length > 0 ? data.publicApi.join(', ') : '(none)'}`,
    ` * risk: ${bootstrap?.risk ?? 'TODO: risk / why-not-decoupled.'}`,
    ` * ${END_MARK}`,
    ' */',
    '',
  ].join('\n')
  const range = contractBlockRange(text)
  if (range === null) return block + text
  const updated = [...range.lines.slice(0, range.start), ...block.split('\n').slice(0, -1), ...range.lines.slice(range.end + 1)]
  return updated.join('\n')
}

/** @param {string} text */
function parseContract(text) {
  const range = contractBlockRange(text)
  if (range === null) return null
  const body = range.lines.slice(range.start + 1, range.end)
  const field = (name) => {
    const line = body.find((item) => item.includes(`* ${name}:`))
    return line === undefined ? '' : line.slice(line.indexOf(`* ${name}:`) + name.length + 3).trim()
  }
  const list = (name) => {
    const value = field(name).replace(/^\[generated\]\s*/, '')
    if (value.length === 0 || value === '(none)') return []
    return value.split(',').map((item) => item.trim()).filter(Boolean)
  }
  return {
    purpose: field('purpose'),
    risk: field('risk'),
    dependsOn: list('dependsOn'),
    externalDeps: list('externalDeps'),
    usedBy: list('usedBy'),
    publicApi: list('publicApi'),
  }
}

/** @param {string} path @param {string[]} values */
function sameList(path, values) {
  return path.length === values.length && path.every((item, index) => item === values[index])
}

/** @param {string} path */
function formatList(path) {
  return path.length > 0 ? path.join(', ') : '(none)'
}

function main() {
  const args = process.argv.slice(2)
  const mode = args.includes('--check') ? 'check' : args.includes('--write') ? 'write' : null
  const bootstrapPath = args.includes('--bootstrap') ? args[args.indexOf('--bootstrap') + 1] : null
  if (mode === null && bootstrapPath === null) {
    console.error('usage: node tools/module-graph.mjs --check | --write | --bootstrap <json>')
    process.exit(2)
  }
  let bootstrap = null
  if (bootstrapPath !== null) {
    bootstrap = JSON.parse(readFileSync(bootstrapPath, 'utf8'))
  }

  const files = []
  walk(ROOT, files)
  const modules = files.map((file) => rel(file)).sort()
  const known = new Set(modules)
  /** @type {Map<string, any>} */
  const graph = new Map()
  const violations = []

  for (const file of files) {
    const path = rel(file)
    const text = readFileSync(file, 'utf8')
    const specifiers = parseImports(text)
    const dependsOn = []
    const externalDeps = []
    for (const spec of specifiers) {
      const resolved = resolveLocal(spec, file, known)
      if (resolved === null) externalDeps.push(spec)
      else if (typeof resolved === 'object') {
        if (!isDevOnly(path)) violations.push(`${path}: dangling local import "${resolved.dangling}"`)
      } else dependsOn.push(resolved)
    }
    graph.set(path, {
      path,
      loc: text.split('\n').length,
      dependsOn: [...new Set(dependsOn)].sort(),
      externalDeps: [...new Set(externalDeps)].sort(),
      usedBy: [],
      publicApi: parseExports(text),
      isContract: isContractPath(path),
      isDevOnly: isDevOnly(path),
    })
  }

  for (const node of graph.values()) {
    for (const target of node.dependsOn) {
      const targetNode = graph.get(target)
      if (targetNode === undefined) {
        if (!isDevOnly(node.path)) violations.push(`${node.path}: import target not scanned: ${target}`)
        continue
      }
      targetNode.usedBy.push(node.path)
    }
  }
  for (const node of graph.values()) node.usedBy.sort()

  // Source-shape health: line budget is a soft decoupling signal, not a hard
  // design rule. Oversize files need an explicit, reviewable exemption.
  const exemptions = readExemptions()
  const health = { warn: [], fail: [], exemptions: [], staleExemptions: [] }
  for (const node of graph.values()) {
    node.fanIn = node.usedBy.filter((path) => !isDevOnly(path)).length
    node.fanOut = node.dependsOn.filter((path) => !isDevOnly(path)).length
    node.debt = node.loc > LOC_WARN
    if (!node.isContract) continue
    const exemption = exemptions.files[node.path]
    if (node.loc > LOC_FAIL) {
      if (exemption === undefined) health.fail.push({ path: node.path, loc: node.loc })
      else health.exemptions.push({ path: node.path, loc: node.loc, reason: exemption.reason ?? '' })
    } else if (node.loc > LOC_WARN) {
      health.warn.push({ path: node.path, loc: node.loc })
    }
    if (exemption !== undefined && node.loc <= LOC_WARN) health.staleExemptions.push({ path: node.path, loc: node.loc })
  }
  for (const path of Object.keys(exemptions.files)) {
    if (!graph.has(path)) health.fail.push({ path, missing: true })
  }
  if (mode === 'check') {
    for (const item of health.warn) {
      console.error(`- warning: ${item.path}: ${item.loc} lines > ${LOC_WARN} (soft target; register an exemption above ${LOC_FAIL})`)
    }
    for (const item of health.staleExemptions) {
      console.error(`- warning: stale exemption: ${item.path} is now ${item.loc} lines (<= ${LOC_WARN}); remove it`)
    }
    for (const item of health.fail) {
      violations.push(item.missing
        ? `${item.path}: exemption path not found`
        : `${item.path}: ${item.loc} lines > ${LOC_FAIL} without an exemption in module-graph.exemptions.json`)
    }
  }

  // Cycle detection over local module edges (DFS with colouring).
  const colour = new Map()
  const stack = []
  const cycles = []
  const visit = (path) => {
    if (colour.get(path) === 'gray') {
      const start = stack.indexOf(path)
      cycles.push([...stack.slice(start), path])
      return
    }
    if (colour.get(path) === 'black') return
    colour.set(path, 'gray')
    stack.push(path)
    for (const next of graph.get(path)?.dependsOn ?? []) visit(next)
    stack.pop()
    colour.set(path, 'black')
  }
  for (const path of modules) visit(path)
  if (cycles.length > 0) violations.push(...cycles.map((cycle) => `cycle: ${cycle.join(' -> ')}`))

  let changed = 0
  for (const file of files) {
    const path = rel(file)
    const node = graph.get(path)
    if (!node.isContract) continue
    const text = readFileSync(file, 'utf8')
    const contract = parseContract(text)
    if (contract === null) {
      if (mode === 'check' && bootstrap === null) {
        violations.push(`${path}: missing module contract header`)
        continue
      }
      const boot = bootstrap?.[path] ?? {}
      const next = renderContract(text, node, boot)
      if (bootstrap !== null) {
        writeFileSync(file, next, 'utf8')
        changed += 1
        continue
      }
      continue
    }
    if (mode === 'check') {
      if (contract.purpose.length === 0 || contract.purpose.startsWith('TODO')) violations.push(`${path}: contract purpose missing`)
      if (contract.risk.length === 0 || contract.risk.startsWith('TODO')) violations.push(`${path}: contract risk missing`)
      for (const field of ['dependsOn', 'externalDeps', 'usedBy', 'publicApi']) {
        const actual = node[field]
        if (!sameList(contract[field], actual)) {
          violations.push(`${path}: contract ${field} drift (header=[${formatList(contract[field])}] code=[${formatList(actual)}])`)
        }
      }
      continue
    }
    const rendered = renderContract(text, node, contract.purpose.startsWith('TODO') ? bootstrap?.[path] : {
      purpose: contract.purpose,
      risk: contract.risk,
    })
    if (rendered !== text) {
      writeFileSync(file, rendered, 'utf8')
      changed += 1
    }
  }

  if (bootstrap !== null && mode === null) {
    console.log(`bootstrap: inserted/updated ${changed} contract blocks`)
    return
  }
  if (mode === 'write') {
    const graphJson = {
      root: 'plugin/flow-tower',
      modules: modules.filter((path) => !isDevOnly(path)).map((path) => {
        const node = graph.get(path)
        return {
          path,
          loc: node.loc,
          fanIn: node.fanIn,
          fanOut: node.fanOut,
          dependsOn: node.dependsOn,
          externalDeps: node.externalDeps,
          usedBy: node.usedBy,
          publicApi: node.publicApi,
        }
      }),
      devConsumers: modules.filter((path) => isDevOnly(path)).map((path) => ({ path, dependsOn: graph.get(path).dependsOn })),
      cycles,
      health,
    }
    mkdirSync(DOCS_DIR, { recursive: true })
    writeFileSync(GRAPH_FILE, `${JSON.stringify(graphJson, null, 2)}\n`, 'utf8')
    const md = [
      '# Module graph',
      '',
      'Generated by `node tools/module-graph.mjs --write`. Do not edit by hand.',
      '',
      `- modules: ${graphJson.modules.length}`,
      `- dev consumers: ${graphJson.devConsumers.length}`,
      `- cycles: ${cycles.length}`,
      `- debt warnings (> ${LOC_WARN} lines): ${health.warn.length}`,
      `- debt failures (> ${LOC_FAIL} lines, no exemption): ${health.fail.length}`,
      `- registered exemptions: ${health.exemptions.length}`,
      '',
      'See `module-graph.json` for the machine-readable forward/reverse index.',
      '',
    ].join('\n')
    writeFileSync(join(DOCS_DIR, 'module-graph.md'), md, 'utf8')
    for (const item of health.warn) console.error(`- warning: ${item.path}: ${item.loc} lines > ${LOC_WARN}`)
    for (const item of health.staleExemptions) console.error(`- warning: stale exemption: ${item.path} is now ${item.loc} lines`)
    console.log(`module graph: wrote ${modules.length} modules (${changed} contract block(s) updated), cycles=${cycles.length}, violations=${violations.length}, debt=${health.warn.length}w/${health.fail.length}f`)
    for (const violation of violations) console.error(`- ${violation}`)
    if (violations.length > 0) process.exitCode = 1
    return
  }

  const graphJson = { modules: modules.length, cycles, violations, health }
  if (violations.length > 0) {
    console.error(`module graph check failed (${violations.length}):`)
    for (const violation of violations) console.error(`- ${violation}`)
    process.exitCode = 1
  } else {
    console.log(`module graph check passed: ${modules.filter((path) => !isDevOnly(path)).length} modules, ${cycles.length} cycles, debt=${health.warn.length} warn/${health.exemptions.length} exempt`)
  }
}

main()

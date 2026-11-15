#!/usr/bin/env node
/**
 * Build the public release package into <repo>/dist/flow-tower-context/.
 *
 * The repository package (`plugin/flow-tower`) is the development package with a
 * private local name. Publishing uses this generated directory, whose manifest,
 * bundle patch, LICENSE, locale and market index are release-shaped.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = resolve(HERE, '..')
const REPO = resolve(SOURCE, '..', '..')
const OUT = join(REPO, 'dist', 'flow-tower-context')
const PUBLIC_NAME = 'flow-tower-context'

const manifest = JSON.parse(readFileSync(join(SOURCE, 'package.json'), 'utf8'))
const publicManifest = JSON.parse(readFileSync(join(SOURCE, 'publish', 'package.json'), 'utf8'))
publicManifest.version = manifest.version

/** Copy a file or directory from the source package into the release directory. */
function copyFromSource(relative, target = relative) {
  const from = join(SOURCE, relative)
  const to = join(OUT, target)
  if (!existsSync(from)) throw new Error(`missing source path: ${relative}`)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
}

/** Copy a release-only file from the repository or publish/ directory. */
function copyPublish(relative, target = relative) {
  const from = join(SOURCE, 'publish', relative)
  const to = join(OUT, target)
  if (!existsSync(from)) throw new Error(`missing publish template: publish/${relative}`)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// Runtime code and assets.
copyFromSource('index.js')
copyFromSource('lib')
copyFromSource('client.js')
copyFromSource('compaction')
copyFromSource('assets')
copyFromSource('icon.svg')
copyFromSource('module-graph.exemptions.json')
copyFromSource('README.md')
copyFromSource('README.en.md')
copyFromSource('tools/mcp-server.mjs', 'tools/mcp-server.mjs')

// Release metadata, docs and display resources.
copyPublish('package.json', 'package.json')
writeFileSync(join(OUT, 'package.json'), `${JSON.stringify(publicManifest, null, 2)}\n`, 'utf8')
copyPublish('cordis.patch.yml', 'cordis.patch.yml')
copyPublish('locale/en.json', 'locale/en.json')
copyPublish('locale/zh.json', 'locale/zh.json')
cpSync(join(SOURCE, 'docs', 'DETAIL.md'), join(OUT, 'docs', 'DETAIL.md'))
cpSync(join(SOURCE, 'docs', 'DETAIL.zh.md'), join(OUT, 'docs', 'DETAIL.zh.md'))
cpSync(join(SOURCE, 'docs', 'INSTALL.md'), join(OUT, 'docs', 'INSTALL.md'))
cpSync(join(SOURCE, 'docs', 'COMPATIBILITY.md'), join(OUT, 'docs', 'COMPATIBILITY.md'))
cpSync(join(REPO, 'LICENSE'), join(OUT, 'LICENSE'))

// Plugin market index (format 1) plus its icon, served by jsDelivr or GitHub Pages.
mkdirSync(join(OUT, 'market'), { recursive: true })
cpSync(join(SOURCE, 'market', 'index.json'), join(OUT, 'market', 'index.json'))
cpSync(join(SOURCE, 'icon.svg'), join(OUT, 'market', 'icon.svg'))

// Guard against absolute developer paths leaking into the published bundle.
const leaks = []
for (const relative of ['package.json', 'cordis.patch.yml']) {
  const text = readFileSync(join(OUT, relative), 'utf8')
  if (/file:\/\/\/|[A-Za-z]:\\\\|@local\//.test(text)) leaks.push(relative)
}
if (leaks.length > 0) {
  console.error(`[build-publish] absolute developer paths found in: ${leaks.join(', ')}`)
  process.exit(1)
}

let bytes = 0
let count = 0
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const info = statSync(full)
    if (info.isDirectory()) walk(full)
    else {
      bytes += info.size
      count += 1
    }
  }
}
walk(OUT)
console.log(`[build-publish] ${PUBLIC_NAME}@${publicManifest.version} -> ${OUT}`)
console.log(`[build-publish] ${count} files, ${(bytes / 1024).toFixed(1)} KiB`)
console.log('[build-publish] next: cd dist/flow-tower-context && npm pack --dry-run')

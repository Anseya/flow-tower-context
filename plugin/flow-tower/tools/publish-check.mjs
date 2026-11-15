#!/usr/bin/env node
/**
 * Pre-release checklist for the generated public package.
 *
 * Usage: node tools/publish-check.mjs [--strict]
 *   --strict fails on placeholder OWNER/<owner> so a real release cannot ship them.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const OUT = join(REPO, 'dist', 'flow-tower-context')
const PUBLIC_NAME = 'flow-tower-context'
const strict = process.argv.includes('--strict')

const failures = []
const warnings = []
const ok = []

function check(label, condition, detail = '') {
  if (condition) ok.push(label)
  else failures.push(`${label}${detail ? `: ${detail}` : ''}`)
}

function warn(label, condition, detail = '') {
  if (condition) warnings.push(`${label}${detail ? `: ${detail}` : ''}`)
}

function readJson(relative) {
  return JSON.parse(readFileSync(join(OUT, relative), 'utf8'))
}

if (!existsSync(OUT)) {
  console.error('[publish-check] dist/flow-tower-context not found; run `npm run build:publish` first')
  process.exit(1)
}

const manifest = readJson('package.json')
check('package name is public', manifest.name === PUBLIC_NAME, manifest.name)
check('not private', manifest.private !== true)
check('license is MIT', manifest.license === 'MIT', manifest.license)
check('engines.dsh declared', typeof manifest.engines?.dsh === 'string', JSON.stringify(manifest.engines))
check('manifest has dsh.bundle.patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('manifest has dsh.client', manifest.dsh?.client?.platform === 'web')
check('package version', /^\d+\.\d+\.\d+/.test(manifest.version), manifest.version)

for (const relative of [
  'LICENSE',
  'cordis.patch.yml',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'docs/DETAIL.md',
  'docs/DETAIL.zh.md',
  'docs/INSTALL.md',
  'docs/COMPATIBILITY.md',
  'market/index.json',
  'market/icon.svg',
  'README.md',
  'README.en.md',
]) {
  check(`file ${relative}`, existsSync(join(OUT, relative)))
}

// Bundle patch: public names only, preset present, provider wired.
const patch = readFileSync(join(OUT, 'cordis.patch.yml'), 'utf8')
check('patch uses public package name', patch.includes(`name: ${PUBLIC_NAME}`), 'row name')
check('patch has compaction preset', patch.includes('preset-flow-tower'))
check('preset wires flow-tower compaction', patch.includes(`${PUBLIC_NAME}/compaction`))
check('no local dev name in patch', !patch.includes('@local/flow-tower'))
check('no absolute file URL in patch', !/file:\/\/\//.test(patch))
check('no drive path in patch', !/[A-Za-z]:\\\\/.test(patch))

// Locale meta.detail targets an existing file.
for (const [locale, target] of [['en.json', 'docs/DETAIL.md'], ['zh.json', 'docs/DETAIL.zh.md']]) {
  const data = readJson(`locale/${locale}`)
  check(`locale ${locale} meta.detail`, data.meta?.detail === target, data.meta?.detail)
  check(`locale ${locale} detail exists`, existsSync(join(OUT, target)))
  check(`locale ${locale} title`, typeof data.meta?.title === 'string' && data.meta.title.length > 0)
}

const icon = statSync(join(OUT, 'icon.svg'))
check('icon under 256 KiB', icon.size <= 256 * 1024, `${icon.size} bytes`)

// Market index: format 1, same package/version/engines, icon resolvable.
const index = readJson('market/index.json')
check('market format is 1', index.format === 1)
const plugin = Array.isArray(index.plugins) ? index.plugins.find((item) => item.name === PUBLIC_NAME) : undefined
check('market lists the package', plugin !== undefined)
if (plugin !== undefined) {
  const version = Array.isArray(plugin.versions) ? plugin.versions[0] : undefined
  check('market version matches package', version?.version === manifest.version, version?.version)
  check('market source is npm', version?.source?.type === 'npm')
  check('market engines match package', version?.engines?.dsh === manifest.engines?.dsh,
    `${version?.engines?.dsh} vs ${manifest.engines?.dsh}`)
  check('market icon resolves', typeof plugin.icon === 'string' && existsSync(join(OUT, 'market', plugin.icon)),
    plugin.icon)
}

// Placeholders: warn by default, fail in strict mode (pre-publish).
const textFiles = ['package.json', 'market/index.json', 'docs/DETAIL.md', 'docs/DETAIL.zh.md',
  'docs/INSTALL.md', 'docs/COMPATIBILITY.md', 'README.md', 'README.en.md']
const placeholders = textFiles.filter((relative) => /OWNER|<owner>/.test(readFileSync(join(OUT, relative), 'utf8')))
if (placeholders.length > 0) {
  const message = `placeholder OWNER/<owner> still present in: ${placeholders.join(', ')}`
  if (strict) failures.push(message)
  else warnings.push(message)
}

for (const line of ok) console.log(`  ok   ${line}`)
for (const line of warnings) console.log(`  warn ${line}`)
for (const line of failures) console.log(`  FAIL ${line}`)
console.log(`\n[publish-check] ${ok.length} ok, ${warnings.length} warnings, ${failures.length} failures`)
if (failures.length > 0) process.exit(1)
if (strict && warnings.length > 0) process.exit(1)

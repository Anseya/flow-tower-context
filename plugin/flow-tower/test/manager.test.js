/**
 * Project-scoped storage tests: path normalization, per-project databases,
 * gitignore helper, fallback, legacy migration and union catalog.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { FlowStore } from '../lib/store.js'
import { StoreManager, dbPathForProject, globalDbPath } from '../lib/manager.js'
import { catalogFromStores } from '../lib/catalog.js'
import { normalizeProjectPath, redactSecrets } from '../lib/util.js'
import { entryIdFor } from '../lib/vocabulary.js'

/** @param {string} dir */
function rmWithRetry(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      // Windows may hold the just-closed SQLite WAL handle briefly.
      const until = Date.now() + 25
      while (Date.now() < until) { /* short spin */ }
    }
  }
}

/** @param {() => void} run */
function withTempHome(run) {
  const previous = process.env.DSH_HOME
  const dir = mkdtempSync(join(tmpdir(), 'flow-tower-home-'))
  process.env.DSH_HOME = dir
  try {
    run(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmWithRetry(dir)
  }
}

/** @param {string} dir @returns {any} */
function makeManager(dir) {
  const config = resolveConfig()
  return new StoreManager({ config, log: { info: () => {}, warn: () => {} } })
}

test('storage: project path normalization is stable across slash/case variants', () => {
  assert.equal(normalizeProjectPath('E:\\Proj\\Alpha\\'), 'e:/Proj/Alpha')
  assert.equal(normalizeProjectPath('E:/Proj/Alpha'), 'e:/Proj/Alpha')
  assert.equal(normalizeProjectPath('relative/path'), '')
  assert.equal(normalizeProjectPath(''), '')
})

test('storage: secrets are redacted from plugin-owned excerpts', () => {
  assert.match(redactSecrets('key sk-abcdefghijklmnop1234567890'), /\[redacted\]/)
  assert.match(redactSecrets('token ghp_abcdefghijklmnopqrstuvwxyz012345'), /\[redacted\]/)
  assert.equal(redactSecrets('no secrets here'), 'no secrets here')
})

test('storage: each project gets its own database and a gitignore helper', () => {
  withTempHome((home) => {
    const project = normalizeProjectPath(join(home, 'workspace', 'proj-a'))
    const manager = makeManager(home)
    const store = manager.getStore(project)
    assert.ok(store)
    const expected = dbPathForProject(project)
    assert.equal(store.path, expected)
    assert.ok(existsSync(expected), 'project database should exist on disk')
    assert.ok(existsSync(join(expected, '..', '.gitignore')), 'gitignore helper should be created')
    assert.match(readFileSync(join(expected, '..', '.gitignore'), 'utf8'), /\*/)

    // Two sessions on the same project share one store instance (slash variants normalize equal).
    const one = manager.projectStore({ header: { cwd: project.replaceAll('/', '\\') } })
    const two = manager.projectStore({ header: { cwd: `${project}/` } })
    assert.equal(one.store, two.store)
    assert.equal(one.project, two.project)
    manager.closeAll()
  })
})

test('storage: unwritable project paths fall back to the global database', () => {
  withTempHome((home) => {
    const blocker = join(home, 'blocker')
    writeFileSync(blocker, 'not a directory', 'utf8')
    const project = normalizeProjectPath(join(home, 'blocker', 'nested'))
    const manager = makeManager(home)
    const store = manager.getStore(project)
    assert.ok(store)
    assert.equal(store.path, globalDbPath())
    manager.closeAll()
  })
})

test('storage: an explicit dbPath forces one shared database', () => {
  withTempHome((home) => {
    const dbPath = join(home, 'single.db')
    const config = resolveConfig({ dbPath })
    const manager = new StoreManager({ config, log: { info: () => {}, warn: () => {} } })
    const one = manager.getStore(normalizeProjectPath(join(home, 'a')))
    const two = manager.getStore(normalizeProjectPath(join(home, 'b')))
    assert.equal(one, two)
    assert.equal(one.path, dbPath)
    manager.closeAll()
  })
})

test('storage: legacy global volumes migrate into their project database', () => {
  withTempHome((home) => {
    const project = normalizeProjectPath(join(home, 'workspace', 'legacy-proj'))
    const legacy = FlowStore.open({ dbPath: globalDbPath() })
    const now = Date.now()
    legacy.ensureVolume({ volumeId: 'legacy-volume', project, now })
    const entryId = entryIdFor('legacy-volume', 'src/legacy.ts')
    legacy.insertEntry({
      entryId,
      volumeId: 'legacy-volume',
      kind: 'file',
      headword: 'src/legacy.ts',
      headwordNorm: 'src/legacy.ts',
      gloss: 'legacy entry',
      createdAt: now,
      updatedAt: now,
    })
    legacy.addEntryCount('legacy-volume', 1, now)
    legacy.insertCitation({
      citeId: 'c_legacy', entryId, sessionId: 'legacy-volume', seqStart: 2, seqEnd: 2, eventTime: now, excerpt: 'x', createdAt: now,
    })
    legacy.close()

    const manager = makeManager(home)
    const stats = manager.migrateLegacy()
    assert.equal(stats.migrated, 1)
    assert.equal(stats.failed, 0)

    const projectPath = dbPathForProject(project)
    const target = FlowStore.open({ dbPath: projectPath })
    const volume = target.getVolume('legacy-volume')
    assert.ok(volume, 'volume should exist in the project database')
    assert.equal(volume.entryCount, 1)
    assert.equal(target.getCitation('c_legacy').sessionId, 'legacy-volume')
    target.close()

    const legacyAfter = FlowStore.open({ dbPath: globalDbPath() })
    assert.equal(legacyAfter.getVolume('legacy-volume'), null)
    legacyAfter.close()
    assert.ok(existsSync(join(home, 'flow-tower', '.project-migration-v1')), 'migration marker should be written')
    manager.closeAll()
  })
})

test('storage: union catalog aggregates open project stores', () => {
  const storeA = FlowStore.open({ dbPath: ':memory:' })
  const storeB = FlowStore.open({ dbPath: ':memory:' })
  const now = Date.now()
  for (const [store, volumeId] of [[storeA, 'vol-a'], [storeB, 'vol-b']]) {
    store.ensureVolume({ volumeId, project: 'p', now })
    store.insertEntry({
      entryId: entryIdFor(volumeId, 'src/x.ts'),
      volumeId,
      kind: 'file',
      headword: 'src/x.ts',
      headwordNorm: 'src/x.ts',
      gloss: 'x',
      createdAt: now,
      updatedAt: now,
    })
    store.addEntryCount(volumeId, 1, now)
  }
  const text = catalogFromStores([
    { project: 'E:/proj/a', store: storeA },
    { project: 'E:/proj/b', store: storeB },
  ])
  assert.match(text, /E:\/proj\/a/)
  assert.match(text, /E:\/proj\/b/)
  assert.match(text, /vol-a/)
  assert.match(text, /vol-b/)
  storeA.close()
  storeB.close()
})

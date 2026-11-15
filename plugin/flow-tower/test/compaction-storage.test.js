/**
 * Storage-location, digest-strategy and compaction-memory tests.
 *
 * These cover the settings added after the real long-session compaction:
 * user-selectable storage (`project` / `global` / `custom`), the focus-first
 * digest, and the quality filter that keeps noisy fragments out of the
 * summarizer's project memory.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { resolveConfig } from '../lib/config.js'
import { FlowStore } from '../lib/store.js'
import { StoreManager } from '../lib/manager.js'
import { resolveDbPath, resolveStorageDir } from '../lib/storage.js'
import { buildDigest } from '../lib/catalog.js'
import { ingestCandidates } from '../lib/vocabulary.js'
import { handleWritePayload } from '../lib/web.js'
import { loadProjectMemory, taskScore } from '../compaction/lib/memory.js'

/** @param {string} dir */
function removeDir(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      // Windows may briefly hold the SQLite WAL handle.
    }
  }
}

/** @param {string} dir @param {string} project */
function createMemoryDb(dir, project) {
  mkdirSync(join(dir), { recursive: true })
  const dbPath = join(dir, 'flow_tower.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE volumes (
      volume_id TEXT PRIMARY KEY,
      project TEXT NOT NULL
    );
    CREATE TABLE entries (
      entry_id TEXT PRIMARY KEY,
      volume_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      headword TEXT NOT NULL,
      gloss TEXT,
      module TEXT,
      status TEXT,
      superseded_by TEXT,
      last_seen_at INTEGER
    )
  `)
  db.prepare('INSERT INTO volumes (volume_id, project) VALUES (?, ?)').run(
    'v1',
    String(project).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase(),
  )
  const insert = db.prepare(
    'INSERT INTO entries (entry_id, volume_id, kind, headword, gloss, module, status, superseded_by, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  let seq = 0
  const add = (kind, headword, gloss = '', module = '', status = null) => {
    seq += 1
    insert.run(`e_${seq}`, 'v1', kind, headword, gloss, module, status, null, Date.now() - seq)
  }
  add('task', 'chars=1800 Open tasks: - 六、建议的下一步 1.', 'noise', '', 'open')
  add('task', '0 focus=按最优化方案下一步 ctx=7 - 0 focus=... BROWSE[zh]…', 'noise', '', 'open')
  add('task', '五、下一步建议 1.', 'noise', '', 'open')
  add('task', '如果你选择 **DeepSeek-only 路线**', 'noise', '', 'open')
  add('task', '把 aliases 扩到 100 条并做 hit@5 对比', '真实任务', '', 'open')
  add('task', 'add router view.', 'TODO: add router view.', '', 'open')
  add('decision', 'use node:sqlite DatabaseSync', 'SQLite WAL is the project store', 'lib', null)
  add('file', './commands.ts', 'command definitions', 'lib', null)
  db.close()
  return dbPath
}

test('config: new storage and injection keys validate', () => {
  const config = resolveConfig({
    storageMode: 'custom',
    storagePath: 'D:/memory-store',
    digestStrategy: 'balanced',
    summaryMemoryChars: 1200,
  })
  assert.equal(config.storageMode, 'custom')
  assert.equal(config.storagePath, 'D:/memory-store')
  assert.equal(config.digestStrategy, 'balanced')
  assert.equal(config.summaryMemoryChars, 1200)
  assert.equal(resolveConfig().digestStrategy, 'brief', 'brief is the default injection shape')
  assert.throws(() => resolveConfig({ storageMode: 'custom' }), /storagePath is required/)
  assert.throws(() => resolveConfig({ storageMode: 'nope' }), /storageMode/)
  assert.throws(() => resolveConfig({ digestStrategy: 'nope' }), /digestStrategy/)
  assert.throws(() => resolveConfig({ summaryMemoryChars: 10 }), /summaryMemoryChars/)
})

test('storage resolver: project, global and custom locations', () => {
  const home = mkdtempSync(join(tmpdir(), 'flow-tower-storage-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const project = 'E:/proj/alpha'
    assert.equal(
      resolveStorageDir(resolveConfig(), project),
      join('E:\\proj\\alpha', '.flow-tower'),
    )
    assert.equal(resolveStorageDir(resolveConfig({ storageMode: 'global' }), project), join(home, 'flow-tower'))
    const custom = join(home, 'my-memory')
    assert.equal(resolveStorageDir(resolveConfig({ storageMode: 'custom', storagePath: custom }), project), custom)
    assert.equal(
      resolveDbPath(resolveConfig({ storageMode: 'custom', storagePath: 'memory-store' }), project),
      join('E:\\proj\\alpha', 'memory-store', 'flow_tower.db'),
      'relative custom paths resolve under the project root',
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    removeDir(home)
  }
})

test('storage: manager opens custom database and migrates the current project', () => {
  const home = mkdtempSync(join(tmpdir(), 'flow-tower-migrate-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const project = join(home, 'workspace', 'migrate').replaceAll('\\', '/')
    const customDir = join(home, 'custom-memory')
    const base = resolveConfig({ storageMode: 'project' })
    const manager = new StoreManager({ config: base, log: { info: () => {}, warn: () => {} } })
    const store = manager.getStore(project)
    assert.ok(store)
    const now = Date.now()
    store.ensureVolume({ volumeId: 'vol-migrate', project, now })
    store.insertEntry({
      entryId: 'e_migrate',
      volumeId: 'vol-migrate',
      kind: 'file',
      headword: 'src/migrate.ts',
      headwordNorm: 'src/migrate.ts',
      gloss: 'migrated entry',
      createdAt: now,
      updatedAt: now,
    })
    store.addEntryCount('vol-migrate', 1, now)
    const oldPath = store.path
    assert.ok(oldPath.includes('.flow-tower'))

    const next = resolveConfig({ storageMode: 'custom', storagePath: customDir })
    const result = manager.migrateStorageForProject(next, project)
    assert.equal(result.error, undefined)
    assert.equal(result.migrated, 1)
    assert.ok(existsSync(result.to))
    const migrated = FlowStore.open({ dbPath: result.to })
    assert.equal(migrated.getVolume('vol-migrate')?.entryCount, 1)
    migrated.close()
    assert.ok(existsSync(oldPath), 'old database is kept')
    assert.equal(manager.storageSnapshot(project).mode, 'custom')
    manager.closeAll()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    removeDir(home)
  }
})

test('compaction memory: noisy task fragments are filtered and real work survives', () => {
  const home = mkdtempSync(join(tmpdir(), 'flow-tower-memory-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const project = join(home, 'workspace', 'memory-project')
    mkdirSync(join(home, 'flow-tower'), { recursive: true })
    const settingsFile = join(home, 'flow-tower', 'settings.json')
    writeFileSync(settingsFile, JSON.stringify({ storageMode: 'project' }), 'utf8')
    createMemoryDb(join(project, '.flow-tower'), project)

    assert.ok(taskScore({ headword: '把 aliases 扩到 100 条并做 hit@5 对比', status: 'open' }) > 0)
    assert.equal(taskScore({ headword: '五、下一步建议 1.', status: 'open' }), -1)
    assert.equal(taskScore({ headword: '0 focus=按最优化方案下一步 ctx=7', status: 'open' }), -1)

    const memory = loadProjectMemory(project, 1800)
    assert.ok(memory.length > 0)
    assert.match(memory, /把 aliases 扩到 100 条并做 hit@5 对比/)
    assert.match(memory, /add router view\./)
    assert.ok(!/BROWSE\[/.test(memory), memory)
    assert.ok(!/chars=1800/.test(memory), memory)
    assert.ok(!/五、下一步建议/.test(memory), memory)
    assert.ok(!/如果你选择/.test(memory), memory)
    assert.ok(memory.length <= 1800, `memory should respect its budget: ${memory.length}`)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    removeDir(home)
  }
})

test('compaction memory: reads the user-selected custom storage location', () => {
  const home = mkdtempSync(join(tmpdir(), 'flow-tower-memory-custom-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const project = join(home, 'workspace', 'custom-memory-project')
    const customDir = join(home, 'chosen-memory')
    mkdirSync(join(home, 'flow-tower'), { recursive: true })
    writeFileSync(join(home, 'flow-tower', 'settings.json'), JSON.stringify({
      storageMode: 'custom',
      storagePath: customDir,
      summaryMemoryChars: 900,
    }), 'utf8')
    createMemoryDb(customDir, project)
    // Another project shares the same custom database; its tasks must not leak
    // into this project's summarizer memory.
    const shared = new DatabaseSync(join(customDir, 'flow_tower.db'))
    shared.prepare('INSERT INTO volumes (volume_id, project) VALUES (?, ?)').run('v2', 'e:/other/project')
    shared.prepare('INSERT INTO entries (entry_id, volume_id, kind, headword, gloss, module, status, superseded_by, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('e_other', 'v2', 'task', '另一个项目专属任务不要泄漏到这边', 'other', '', 'open', null, Date.now())
    shared.close()
    const memory = loadProjectMemory(project)
    assert.match(memory, /把 aliases 扩到 100 条并做 hit@5 对比/)
    assert.ok(!/另一个项目专属任务/.test(memory), 'memory must be scoped to the session project')
    assert.ok(memory.length <= 900)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    removeDir(home)
  }
})

test('settings API: switching storage migrates and persists the choice', () => {
  const home = mkdtempSync(join(tmpdir(), 'flow-tower-settings-api-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const project = join(home, 'workspace', 'api-project').replaceAll('\\', '/')
    const customDir = join(home, 'user-chosen-memory')
    const manager = new StoreManager({ config: resolveConfig(), log: { info: () => {}, warn: () => {} } })
    const store = manager.getStore(project)
    const now = Date.now()
    store.ensureVolume({ volumeId: 'vol-api', project, now })
    store.insertEntry({
      entryId: 'e_api',
      volumeId: 'vol-api',
      kind: 'decision',
      headword: 'store the dictionary where the user chooses',
      headwordNorm: 'store the dictionary where the user chooses',
      gloss: 'settings test',
      createdAt: now,
      updatedAt: now,
    })
    store.addEntryCount('vol-api', 1, now)
    manager.closeAll()

    const result = handleWritePayload(manager, '/flow-tower/api/settings', {
      scope: 'global',
      project,
      settings: { storageMode: 'custom', storagePath: customDir },
    })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    assert.equal(result.json.storage.mode, 'custom')
    assert.ok(existsSync(join(customDir, 'flow_tower.db')))
    const settings = JSON.parse(readFileSync(join(home, 'flow-tower', 'settings.json'), 'utf8'))
    assert.equal(settings.storageMode, 'custom')
    assert.equal(settings.storagePath, customDir)
    const migrated = FlowStore.open({ dbPath: join(customDir, 'flow_tower.db') })
    assert.equal(migrated.getVolume('vol-api')?.entryCount, 1)
    migrated.close()
    manager.closeAll()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    removeDir(home)
  }
})

test('digest: brief shows overview, progress, change log and drill-down hint', () => {
  const store = FlowStore.open({ dbPath: ':memory:' })
  const config = resolveConfig({ digestStrategy: 'brief', digestBudgetTokens: 2000 })
  const now = Date.now()
  const projectRoot = fileURLToPath(new URL('..', import.meta.url)).replaceAll('\\', '/')
  store.ensureVolume({ volumeId: 'brief-vol', project: projectRoot, now })
  store.updateVolume('brief-vol', {
    title: '解耦重构完成，准备重启验证',
    abstract: '项目正在从单体模块拆分为契约模块；已完成 web/tools 拆分，下一步验证真实 /compact。',
  }, now)
  ingestCandidates(store, {
    volumeId: 'brief-vol',
    sessionId: 'brief-vol',
    now,
    config,
    candidates: [
      { kind: 'file', headword: 'lib/web-read.js', gloss: 'read API routes', seq: 1, time: now - 3000, module: 'lib' },
      { kind: 'feature', headword: '模块契约与依赖图工具', gloss: 'contract blocks + module-graph check', seq: 2, time: now - 2000 },
      { kind: 'decision', headword: '保留 store 单类以保护事务不变量', gloss: '高风险例外', seq: 3, time: now - 1000 },
      { kind: 'task', headword: '重启后验证真实 /compact 运行记录', gloss: 'pending', seq: 4, time: now - 500, status: 'open' },
    ],
  })
  const digest = buildDigest(store, 'brief-vol', config)
  assert.match(digest, /\[flow-tower\] Project brief/)
  assert.match(digest, /Overview: 项目正在从单体模块拆分/)
  assert.match(digest, /Progress:/)
  assert.match(digest, /进行中：重启后验证真实 \/compact/)
  assert.match(digest, /Change log:/)
  assert.match(digest, /lib\/web-read\.js/)
  assert.match(digest, /模块契约与依赖图工具/)
  assert.match(digest, /dict_lookup\(term\)/)
  assert.ok(!/Headwords:/.test(digest))
  assert.ok(!/Counts:/.test(digest))
  store.close()
})

test('digest: large projects switch to a module map with tip, completion, cite and traversal hints', () => {
  const store = FlowStore.open({ dbPath: ':memory:' })
  const config = resolveConfig({ digestStrategy: 'brief', mapThresholdEntries: 1, digestBudgetTokens: 2000 })
  const now = Date.now()
  const projectRoot = fileURLToPath(new URL('..', import.meta.url)).replaceAll('\\', '/')
  store.ensureVolume({ volumeId: 'map-vol', project: projectRoot, now })
  store.updateVolume('map-vol', {
    title: '## Primary Request and Intent - 超大项目的模块塔图',
    abstract: '## Primary Request and Intent - 全局目标：让模型先看模块塔尖与完成度，再决定是否下钻。其余摘要不应进入 Goal。',
  }, now)
  ingestCandidates(store, {
    volumeId: 'map-vol',
    sessionId: 'map-vol',
    now,
    config,
    candidates: [
      { kind: 'feature', headword: '模块契约与依赖图工具', gloss: 'contract blocks + module-graph check', seq: 1, time: now - 3000, module: 'lib' },
      { kind: 'file', headword: 'lib/web-read.js', gloss: 'read API routes', seq: 2, time: now - 2500, module: 'lib' },
      { kind: 'task', headword: '重启后验证真实 /compact 运行记录', gloss: 'pending', seq: 3, time: now - 2000, status: 'open', module: 'lib' },
      { kind: 'decision', headword: '保留 store 单类以保护事务不变量', gloss: '高风险例外', seq: 4, time: now - 1000, module: 'lib' },
      { kind: 'chapter', headword: '实现](#understand-the-implem', gloss: 'summary section', seq: 5, time: now - 500, module: 'lib' },
      { kind: 'task', headword: '建议先做路由 dispose', gloss: 'suggestion', seq: 6, time: now - 400, status: 'open', module: 'lib' },
      { kind: 'task', headword: '已完成 web/tools 拆分', gloss: 'done note', seq: 7, time: now - 300, status: 'open', module: 'lib' },
      { kind: 'task', headword: '如果你选择 DeepSeek-only 路线', gloss: 'conditional prose', seq: 8, time: now - 200, status: 'open', module: 'lib' },
    ],
  })
  const digest = buildDigest(store, 'map-vol', config)
  assert.match(digest, /Project map/)
  assert.match(digest, /Goal: 全局目标：让模型先看模块塔尖与完成度，再决定是否下钻。/)
  assert.ok(!/Primary Request and Intent/.test(digest), 'goal strips summary section labels')
  assert.ok(!/其余摘要/.test(digest), 'goal stops at the first sentence')
  assert.ok(!/\]\(#/.test(digest), 'markdown link residue never reaches the prompt')
  assert.ok(!/chapter:/.test(digest), 'chapter markers stay out of the change log')
  assert.ok(!/建议先做/.test(digest), 'advice prose is not an open task')
  const openLine = digest.split('\n').find((line) => line.startsWith('Open:')) ?? ''
  assert.ok(!/已完成 web\/tools/.test(openLine), 'done statements are not shown as open work')
  assert.ok(!/如果你选择/.test(digest), 'conditional prose is not shown as memory')
  assert.match(digest, /Open: 重启后验证真实 \/compact 运行记录/)
  assert.match(digest, /Open: 重启后验证真实 \/compact 运行记录/)
  assert.match(digest, /Modules:/)
  assert.match(digest, /lib \[active · 0\/4 · explore\]/)
  assert.match(digest, /tip: /)
  assert.match(digest, /保留 store 单类以保护事务不变量/)
  assert.match(digest, /upper: /)
  assert.match(digest, /cite c_/)
  assert.match(digest, /Traverse:/)
  assert.match(digest, /Latest:/)
  store.close()
})

test('digest: focus, balanced and full retain the dictionary-index shapes', () => {
  const store = FlowStore.open({ dbPath: ':memory:' })
  const config = resolveConfig()
  const now = Date.now()
  store.ensureVolume({ volumeId: 'digest-vol', project: 'E:/proj/digest', now })
  ingestCandidates(store, {
    volumeId: 'digest-vol',
    sessionId: 'digest-vol',
    now,
    config,
    candidates: [
      { kind: 'file', headword: 'src/router.ts', gloss: 'router', seq: 1, time: now - 3000, module: 'src' },
      { kind: 'task', headword: '把 aliases 扩到 100 条并做 hit@5 对比', gloss: 'todo', seq: 2, time: now - 2000, status: 'open' },
      { kind: 'decision', headword: 'do not mutate the returned value', gloss: 'decision', seq: 3, time: now - 1000 },
    ],
  })
  const focus = buildDigest(store, 'digest-vol', { ...config, digestStrategy: 'focus' })
  const balanced = buildDigest(store, 'digest-vol', { ...config, digestStrategy: 'balanced' })
  const full = buildDigest(store, 'digest-vol', { ...config, digestStrategy: 'full' })
  assert.match(focus, /Use dict_browse/)
  assert.match(focus, /把 aliases 扩到 100 条/)
  assert.ok(!/Headwords:/.test(focus), 'focus does not dump the full index')
  assert.match(balanced, /Headwords:/)
  assert.match(full, /Headwords:/)
  assert.equal(focus, buildDigest(store, 'digest-vol', { ...config, digestStrategy: 'focus' }))
  store.close()
})

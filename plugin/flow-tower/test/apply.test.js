/**
 * Wiring test: exercises `apply()` with a fake Cordis context so the plugin's
 * listener/tool/section registration is validated without a Harness process.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, LEGEND_SECTION, name } from '../index.js'
import { createFakeSession, seedConversation } from './fixtures.js'
/**
 * Minimal Cordis-like context for activation tests.
 */
function createFakeCtx() {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {Map<string, any> & { register?: (definition: any) => () => boolean }} */
  const tools = new Map()
  tools.register = (definition) => {
    tools.set(definition.name, definition)
    return () => tools.delete(definition.name)
  }
  /** @type {Map<string, any>} */
  const sections = new Map()
  const cleanups = []
  /** @type {Array<{level: string, message: string}>} */
  const logs = []

  const prompt = {
    section(spec) {
      sections.set(spec.name, spec)
      return () => sections.delete(spec.name)
    },
  }

  const ctx = {
    systemPrompt: prompt,
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
    tools,
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {}
    },
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => {}
    },
    get(service) {
      if (service === 'tools') return tools
      if (service === 'systemPrompt') return prompt
      return undefined
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    listeners,
    sections,
    prompt,
    logs,
    dispose() {
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup()
        } catch {
          // teardown best effort
        }
      }
    },
  }
  return ctx
}

/**
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

/**
 * Poll an async probe until its predicate holds.
 * @template T
 * @param {() => Promise<T>} probe
 * @param {(value: T) => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
async function poll(probe, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  let last = await probe()
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    last = await probe()
  }
  return last
}

test('apply: registers tools, legend and digest; compiles on compaction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-tower-apply-'))
  const ctx = createFakeCtx()
  try {
    apply(ctx, { dbPath: join(dir, 'flow_tower.db') })

    assert.equal(ctx.tools.size, 6)
    assert.deepEqual([...ctx.tools.keys()].sort(), ['dict_browse', 'dict_cite', 'dict_lookup', 'dict_relate', 'dict_search', 'dict_timeline'])
    assert.equal(ctx.sections.size, 1)
    const legend = ctx.sections.get(LEGEND_SECTION)
    assert.ok(legend, 'legend section must be registered')
    assert.equal(typeof legend.text, 'function')
    assert.equal(legend.text(), '', 'legend stays empty before any dictionary exists')

    const session = createFakeSession()
    const seqs = seedConversation(session)
    const event = session.addCompaction({ compactionId: 'cmp-wire-1', seqs, summary: '我们决定采用观察式接入。' })
    ctx.emit('session/event', session, event)

    // Engine-independent evidence: the summary event itself records one run line
    // beside the configured database, so status can prove a checkpoint happened.
    const runLog = join(dir, 'compaction-runs.jsonl')
    assert.ok(existsSync(runLog), 'compaction summary event must write a run record')
    const recorded = JSON.parse(readFileSync(runLog, 'utf8').trim().split('\n').at(-1))
    assert.equal(recorded.source, 'event')
    assert.equal(recorded.ok, true)
    assert.equal(recorded.compactionId, 'cmp-wire-1')
    assert.ok(recorded.summaryChars > 0)

    const browse = ctx.tools.get('dict_browse')
    const exec = { agent: { session }, signal: new AbortController().signal }
    const browseOutput = await poll(
      () => browse.execute({ volume: session.id }, exec),
      (result) => /Dictionary volume/.test(result.text),
    )
    assert.match(browseOutput.text, /Dictionary volume/, 'compiler should commit a volume asynchronously')
    assert.match(legend.text(), /flow-tower-dictionary/)

    // llm/stream fallback: inject the digest when the backend marker is absent,
    // and never duplicate it when the engine already injected project memory.
    const fallbackRequest = {
      purpose: 'compaction',
      sessionId: session.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize' }] }],
    }
    ctx.emit('llm/stream', fallbackRequest, () => undefined)
    assert.match(fallbackRequest.messages.at(-1).content.at(-1).text, /Project context memory/)
    const engineRequest = {
      purpose: 'compaction',
      sessionId: session.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Flow Tower project memory already applied' }] }],
    }
    ctx.emit('llm/stream', engineRequest, () => undefined)
    assert.equal(engineRequest.messages[0].content.length, 1, 'marker present: bridge must not duplicate memory')
    const evidence = readFileSync(runLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(evidence.some((line) => line.source === 'llm-stream'), JSON.stringify(evidence))

    // Pre-step digest is injected exactly once per dictionary version.
    const preStep = ctx.listeners.get('agent/pre-step')[0]
    const next = async () => ({ kind: 'enter', messages: [] })
    const signal = new AbortController().signal
    const first = await preStep({ agent: { session }, step: 1, turn: 1, signal }, next)
    assert.equal(first.messages.length, 1)
    const injected = first.messages[0]
    assert.equal(injected.role, 'user')
    assert.equal(injected.source.kind, name)
    assert.equal(injected.source.form, 'snapshot')
    assert.equal(injected.content[0].type, 'text')
    assert.match(injected.content[0].text, /flow-tower/)
    assert.match(injected.content[0].text, /Project brief/)
    const second = await preStep({ agent: { session }, step: 1, turn: 1, signal }, next)
    assert.equal(second.messages.length, 0, 'digest must not repeat while the version is unchanged')
    const laterStep = await preStep({ agent: { session }, step: 2, turn: 1, signal }, next)
    assert.equal(laterStep.messages.length, 0, 'digest is injected at most once per turn')

    // A compaction replaces the live transcript, so the per-volume injection
    // budget restarts. Without this a long marathon session silently stops
    // injecting project memory once the lifetime cap is reached.
    const { DatabaseSync } = await import('node:sqlite')
    const readInjections = () => {
      const db = new DatabaseSync(join(dir, 'flow_tower.db'), { readOnly: true })
      try {
        const row = db.prepare('SELECT injections FROM index_meta WHERE volume_id = ?').get(session.id)
        return Number(row?.injections ?? 0)
      } finally {
        db.close()
      }
    }
    assert.equal(readInjections(), 1, 'first injection is counted')
    ctx.emit('session/event', session, session.addCompaction({ compactionId: 'cmp-budget-reset', seqs, summary: '预算重置验证。' }))
    assert.equal(readInjections(), 0, 'compaction must restart the injection budget')

    // Lookup + cite through the registered tool definitions.
    const lookup = ctx.tools.get('dict_lookup')
    const lookupResult = await lookup.execute({ term: 'plugin/flow-tower/index.js', volume: session.id }, exec)
    assert.match(lookupResult.text, /Definition:/)
    const citeId = lookupResult.text.match(/c_[0-9a-f]+/)?.[0]
    assert.ok(citeId)
    const cite = ctx.tools.get('dict_cite')
    const citeResult = await cite.execute({ cite_id: citeId }, exec)
    assert.match(citeResult.text, /plugin\/flow-tower\/index\.js/)
    assert.match(citeResult.text, /user/)

    // Time axis: the timeline tool lists compiled entries newest-first.
    const timeline = ctx.tools.get('dict_timeline')
    const timelineResult = await timeline.execute({ volume: session.id }, exec)
    assert.match(timelineResult.text, /# Timeline/)
    assert.match(timelineResult.text, /plugin\/flow-tower\/index\.js/)

    // Task dimension: the TODO in the seeded conversation is open in the brief.
    assert.match(injected.content[0].text, /Progress:/)
    assert.match(injected.content[0].text, /add router view/)
  } finally {
    ctx.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply: project storage creates <cwd>/.flow-tower and shares it across sessions', async () => {
  const previousHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'flow-tower-project-'))
  process.env.DSH_HOME = home
  const ctx = createFakeCtx()
  const projectDir = join(home, 'workspace', 'demo-proj')
  mkdirSync(projectDir, { recursive: true })
  try {
    apply(ctx, {})
    const session = createFakeSession({ id: 'project-session', cwd: projectDir })
    const seqs = seedConversation(session)
    ctx.emit('session/event', session, session.addCompaction({ compactionId: 'cmp-project-1', seqs, summary: '项目级词典。' }))
    const browse = ctx.tools.get('dict_browse')
    const exec = { agent: { session }, signal: new AbortController().signal }
    const output = await poll(
      () => browse.execute({ volume: session.id }, exec),
      (result) => /Dictionary volume/.test(result.text),
    )
    assert.match(output.text, /Dictionary volume/)
    const dbPath = join(projectDir, '.flow-tower', 'flow_tower.db')
    assert.ok(existsSync(dbPath), `project database should live under the project: ${dbPath}`)
    assert.ok(existsSync(join(projectDir, '.flow-tower', '.gitignore')), 'gitignore helper should exist')
    const catalog = await browse.execute({ catalog: true }, exec)
    assert.match(catalog.text, /project store|volume/i)
  } finally {
    ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('apply: invalid config fails soft without registering anything', () => {
  const ctx = createFakeCtx()
  apply(ctx, { maxEntries: -1 })
  assert.equal(ctx.tools.size, 0)
  assert.ok(ctx.logs.some((entry) => entry.level === 'error'))
})

test('apply: dual-lite digest dedupes the fresh native checkpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-tower-apply-plan-'))
  const ctx = createFakeCtx()
  try {
    apply(ctx, { dbPath: join(dir, 'flow_tower.db') })
    const session = createFakeSession()
    const seqs = seedConversation(session)
    session.addCheckpoint('采用观察式接入；修改 plugin/flow-tower/index.js。')
    session.addAssistant('继续实现 injection policy。')
    ctx.emit('session/event', session, session.addCompaction({ compactionId: 'cmp-plan-wire', seqs, summary: '我们决定采用观察式接入。' }))
    const browse = ctx.tools.get('dict_browse')
    const exec = { agent: { session }, signal: new AbortController().signal }
    await poll(() => browse.execute({ volume: session.id }, exec), (result) => /Dictionary volume/.test(result.text))
    const preStep = ctx.listeners.get('agent/pre-step')[0]
    const next = async () => ({ kind: 'enter', messages: [] })
    const result = await preStep({ agent: { session }, step: 1, turn: 1, signal: new AbortController().signal }, next)
    assert.equal(result.messages.length, 1, 'dual-lite still injects long-range orientation')
    const text = result.messages[0].content[0].text
    assert.match(text, /inject: dual-lite/)
    assert.match(text, /task: coding/)
    assert.match(text, /short: checkpoint 0t ago/)
    assert.doesNotMatch(text, /Change log:/)
  } finally {
    ctx.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply: a subagent without its own volume gets the shared project digest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-tower-apply-shared-'))
  const ctx = createFakeCtx()
  try {
    apply(ctx, { dbPath: join(dir, 'flow_tower.db') })
    const main = createFakeSession({ id: 'agent-main', cwd: 'E:/project/agent-team' })
    const seqs = seedConversation(main)
    ctx.emit('session/event', main, main.addCompaction({ compactionId: 'cmp-shared-1', seqs, summary: '项目级记忆。' }))
    const browse = ctx.tools.get('dict_browse')
    const exec = { agent: { session: main }, signal: new AbortController().signal }
    await poll(() => browse.execute({ volume: main.id }, exec), (result) => /Dictionary volume/.test(result.text))

    const child = createFakeSession({ id: 'agent-child', cwd: 'E:/project/agent-team' })
    child.header.parentSession = main.id
    child.header.origin = 'subagent'
    const preStep = ctx.listeners.get('agent/pre-step')[0]
    const next = async () => ({ kind: 'enter', messages: [] })
    const result = await preStep({ agent: { session: child }, step: 1, turn: 1, signal: new AbortController().signal }, next)
    assert.equal(result.messages.length, 1, 'child agent must receive project memory')
    const text = result.messages[0].content[0].text
    assert.match(text, /Shared project (?:brief|map)/)
    assert.match(text, /Shared: this session has no dictionary yet/)
    assert.match(text, /inject: long-only/)
  } finally {
    ctx.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply: missing systemPrompt still registers tools and listeners', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-tower-noprompt-'))
  const ctx = createFakeCtx()
  delete ctx.systemPrompt
  ctx.get = (service) => (service === 'tools' ? ctx.tools : undefined)
  ctx.inject = () => {
    throw new Error('systemPrompt unavailable')
  }
  try {
    apply(ctx, { dbPath: join(dir, 'flow_tower.db') })
    assert.equal(ctx.tools.size, 6)
    assert.equal(ctx.sections.size, 0)
  } finally {
    ctx.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

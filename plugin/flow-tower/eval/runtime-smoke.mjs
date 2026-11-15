#!/usr/bin/env node
/**
 * Runtime smoke helper: seeds (or removes) one synthetic dictionary volume in a
 * project-scoped database so a live agent can verify the tools across processes.
 * Development-only; never part of a real dictionary.
 *
 * Default project = current working directory (pass --project=<abs path> to
 * target the project whose folder should hold `.flow-tower/flow_tower.db`).
 *
 * Run: node eval/runtime-smoke.mjs seed   [--project=<path>] [--volume=<session id>]
 *      node eval/runtime-smoke.mjs clean  [--project=<path>] [--volume=<session id>]
 */

import { FlowStore } from '../lib/store.js'
import { buildDigest } from '../lib/catalog.js'
import { dbPathForProject } from '../lib/manager.js'
import { entryIdFor, normHeadword } from '../lib/vocabulary.js'
import { estimateTokens, normalizeProjectPath } from '../lib/util.js'

const args = process.argv.slice(2)
const mode = args[0]
const projectArg = args.find((arg) => arg.startsWith('--project='))?.slice('--project='.length)
const volumeArg = args.find((arg) => arg.startsWith('--volume='))?.slice('--volume='.length)
const PROJECT = normalizeProjectPath(projectArg ?? process.cwd())
const VOLUME_ID = volumeArg ?? 'smoke-volume-03'
const SESSION_ID = 'smoke-session-missing'
const HEADWORD = 'src/module/smoke-test.ts'
const TASK_HEADWORD = 'TODO: verify project-local storage'
const CITE_ID = 'c_smoke0003'

function openStore() {
  const dbPath = dbPathForProject(PROJECT)
  return { store: FlowStore.open({ dbPath }), dbPath }
}

function seed() {
  const { store, dbPath } = openStore()
  const now = Date.now()
  try {
    store.ensureVolume({ volumeId: VOLUME_ID, project: PROJECT, now })
    const norm = normHeadword('file', HEADWORD)
    store.insertEntry({
      entryId: entryIdFor(VOLUME_ID, norm),
      volumeId: VOLUME_ID,
      kind: 'file',
      headword: HEADWORD,
      headwordNorm: norm,
      gloss: 'synthetic smoke-test file entry across six dimensions',
      module: 'src/module',
      firstSeenAt: now - 60_000,
      lastSeenAt: now - 1000,
      createdAt: now,
      updatedAt: now,
    })
    const taskNorm = normHeadword('task', TASK_HEADWORD)
    store.insertEntry({
      entryId: entryIdFor(VOLUME_ID, taskNorm),
      volumeId: VOLUME_ID,
      kind: 'task',
      headword: TASK_HEADWORD,
      headwordNorm: taskNorm,
      gloss: 'pending smoke verification',
      status: 'open',
      statusSeq: 7,
      firstSeenAt: now - 30_000,
      lastSeenAt: now - 500,
      createdAt: now,
      updatedAt: now,
    })
    store.addEntryCount(VOLUME_ID, 2, now)
    store.insertCitation({
      citeId: CITE_ID,
      entryId: entryIdFor(VOLUME_ID, norm),
      sessionId: SESSION_ID,
      seqStart: 5,
      seqEnd: 5,
      eventTime: now - 1000,
      excerpt: 'synthetic citation for project-local smoke (sk-abcdefghijklmnopqrstuvwxyz redacted)',
      createdAt: now,
    })
    store.bumpVersion(VOLUME_ID, now)
    const digest = buildDigest(store, VOLUME_ID, { digestBudgetTokens: 400 })
    process.stdout.write(`${JSON.stringify({
      project: PROJECT,
      dbPath,
      volumeId: VOLUME_ID,
      headword: HEADWORD,
      taskHeadword: TASK_HEADWORD,
      citeId: CITE_ID,
      digestTokens: estimateTokens(digest),
      entryCount: store.countEntries(VOLUME_ID),
      openTasks: store.openTasks(VOLUME_ID).length,
      modules: store.recentModules(VOLUME_ID).map((item) => item.module),
    }, null, 2)}\n`)
  } finally {
    store.close()
  }
}

function clean() {
  const { store, dbPath } = openStore()
  try {
    store.deleteVolume(VOLUME_ID)
    process.stdout.write(`cleaned ${VOLUME_ID} from ${dbPath}\n`)
  } finally {
    store.close()
  }
}

if (mode === 'seed') seed()
else if (mode === 'clean') clean()
else {
  process.stderr.write('usage: node eval/runtime-smoke.mjs seed|clean [--project=<path>] [--volume=<id>]\n')
  process.exitCode = 2
}

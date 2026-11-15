/**
 * --- module contract ---
 * purpose: Cross-process file locks for dictionary writers.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] node:fs, node:path
 * usedBy: [generated] lib/compiler.js, lib/relations.js, test/flow-tower.test.js, tools/merge-projects.mjs
 * publicApi: [generated] readLock, withLock
 * risk: Medium: a broken lock can corrupt concurrent writes or stall compiles.
 * --- end module contract ---
 */

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** @param {number} ms */
function sleep(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(shared, 0, 0, Math.max(1, ms))
}

/**
 * Run fn while holding an exclusive lock file.
 * @template T
 * @param {string} lockPath
 * @param {() => T} fn
 * @param {{ timeoutMs?: number, staleMs?: number }} [options]
 * @returns {T}
 */
export function withLock(lockPath, fn, options = {}) {
  const timeoutMs = Math.max(10, options.timeoutMs ?? 5000)
  const staleMs = Math.max(1000, options.staleMs ?? 30000)
  const deadline = Date.now() + timeoutMs
  let fd
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, 'wx')
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      } catch {
        // Lock ownership is the open() itself; metadata is advisory.
      }
    } catch (error) {
      if (/ENOENT/i.test(String(error?.message ?? error))) {
        try {
          mkdirSync(dirname(lockPath), { recursive: true })
          continue
        } catch {
          throw error
        }
      }
      if (!/EEXIST/i.test(String(error?.message ?? error))) throw error
      let stale = false
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > staleMs
      } catch {
        stale = true
      }
      if (stale) {
        try {
          unlinkSync(lockPath)
          continue
        } catch {
          // Another process broke it first.
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`flow-tower: lock busy: ${lockPath}`)
      }
      sleep(25)
    }
  }
  try {
    return fn()
  } finally {
    try {
      closeSync(fd)
    } catch {
      // Already closed.
    }
    try {
      unlinkSync(lockPath)
    } catch {
      // Lock already broken by stale-lock handling.
    }
  }
}

/**
 * Read lock metadata (diagnostics).
 * @param {string} lockPath
 * @returns {any | null}
 */
export function readLock(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * --- module contract ---
 * purpose: Hardware profile detection and resource-based capacity caps.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] node:os
 * usedBy: [generated] index.js, lib/config.js, lib/manager.js, lib/store-schema.js, lib/web-read.js, test/flow-tower.test.js
 * publicApi: [generated] applyResourceProfile, hardwareProfile, isResourceCapped
 * risk: Medium: wrong caps can raise memory pressure; profile values are behavioral.
 * --- end module contract ---
 */

import { cpus, freemem, totalmem } from 'node:os'

/**
 * @returns {{ totalMemGB: number, freeMemGB: number, cpuCount: number,
 *   profile: 'low'|'medium'|'high', maxEntriesCap: number, cacheKiB: number, mmapBytes: number }}
 */
export function hardwareProfile() {
  const totalMemGB = Math.max(1, totalmem() / (1024 ** 3))
  const freeMemGB = freemem() / (1024 ** 3)
  const cpuCount = Math.max(1, cpus().length)
  let profile = 'high'
  if (totalMemGB < 8) profile = 'low'
  else if (totalMemGB < 16) profile = 'medium'
  const caps = {
    low: { maxEntriesCap: 1500, cacheKiB: 8192 },
    medium: { maxEntriesCap: 3000, cacheKiB: 16384 },
    high: { maxEntriesCap: 6000, cacheKiB: 32768 },
  }[profile]
  return {
    totalMemGB: Number(totalMemGB.toFixed(1)),
    freeMemGB: Number(freeMemGB.toFixed(1)),
    cpuCount,
    profile,
    maxEntriesCap: caps.maxEntriesCap,
    cacheKiB: caps.cacheKiB,
    mmapBytes: Math.min(256 * 1024 * 1024, Math.floor((totalmem() / 8))),
  }
}

/**
 * Apply the hardware cap to a config-like object (returns a new object).
 * `resourceProfile: 'off'` disables the cap; explicit low maxEntries is kept.
 * @param {Record<string, any>} config
 * @param {{ totalMemGB?: number }} [hardware]
 * @returns {Record<string, any>}
 */
export function applyResourceProfile(config, hardware = hardwareProfile()) {
  if (config.resourceProfile === 'off') return config
  return { ...config, maxEntries: Math.min(Number(config.maxEntries ?? 4000), hardware.maxEntriesCap) }
}

/**
 * @param {Record<string, any>} config
 * @returns {boolean} whether the hardware cap changed maxEntries
 */
export function isResourceCapped(config) {
  return Number(config.maxEntries ?? 0) !== Number(applyResourceProfile(config).maxEntries ?? 0)
}

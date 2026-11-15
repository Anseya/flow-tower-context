/**
 * --- module contract ---
 * purpose: Host RSS guard that sheds optional memory work under pressure and reports state.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] (none)
 * usedBy: [generated] index.js, lib/compiler.js, lib/config.js, lib/web-read.js, lib/web.js
 * publicApi: [generated] DEFAULT_MAX_RSS_BYTES, memoryState, memoryUnderPressure
 * risk: Medium: must only skip optional work, never lose queued seq coverage.
 * --- end module contract ---
 */

/**
 * @param {Record<string, any>} config
 * @returns {boolean}
 */
export function memoryUnderPressure(config) {
  if (config?.memoryGuard === false) return false
  const limit = Number(config?.maxRssBytes)
  if (!Number.isFinite(limit) || limit <= 0) return false
  try {
    return process.memoryUsage().rss >= limit
  } catch {
    return false
  }
}

/** Default guard: 6 GiB RSS on a desktop; tunable through settings. */
export const DEFAULT_MAX_RSS_BYTES = 6 * 1024 ** 3

/**
 * Observable snapshot for `/api/status` and diagnostics.
 * @param {Record<string, any>} config
 */
export function memoryState(config) {
  const limit = Number(config?.maxRssBytes) || DEFAULT_MAX_RSS_BYTES
  let rssBytes = 0
  try {
    rssBytes = process.memoryUsage().rss
  } catch { /* ignore */ }
  return {
    enabled: config?.memoryGuard !== false,
    rssBytes,
    maxRssBytes: limit,
    pressured: config?.memoryGuard !== false && rssBytes >= limit,
  }
}

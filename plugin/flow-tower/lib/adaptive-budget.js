/**
 * --- module contract ---
 * purpose: Scale the digest token budget from live context pressure so a near-full window gets a smaller map.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] (none)
 * usedBy: [generated] index.js, test/flow-tower.test.js
 * publicApi: [generated] MIN_ADAPTIVE_BUDGET, adaptDigestBudget
 * risk: Low: pure heuristic; unknown pressure keeps the configured budget.
 * --- end module contract ---
 */

/** Never shrink below this many tokens; a map smaller than this is not orienting. */
export const MIN_ADAPTIVE_BUDGET = 400

/**
 * @param {number} base configured digest budget in tokens
 * @param {number} pressureTokens latest measured prompt size, when known
 * @param {number} contextWindow routed model capacity, when known
 * @returns {number} effective digest budget
 */
export function adaptDigestBudget(base, pressureTokens, contextWindow) {
  const configured = Number(base)
  if (!Number.isSafeInteger(configured) || configured <= 0) return configured
  const pressure = Number(pressureTokens)
  const window = Number(contextWindow)
  if (!Number.isFinite(pressure) || !Number.isFinite(window) || pressure <= 0 || window <= 0) return configured
  const ratio = pressure / window
  // High pressure: the next step is close to compaction, so keep the injected
  // map minimal. Low pressure: the full configured budget is affordable.
  const scale = ratio >= 0.85
    ? 0.3
    : ratio >= 0.7
      ? 0.5
      : ratio >= 0.55
        ? 0.7
        : 1
  const floor = Math.min(configured, Math.max(MIN_ADAPTIVE_BUDGET, Math.round(configured * 0.2)))
  return Math.max(floor, Math.min(configured, Math.round(configured * scale)))
}

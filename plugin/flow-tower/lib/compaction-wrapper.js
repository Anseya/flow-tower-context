/**
 * --- module contract ---
 * purpose: Delegate-and-observe wrapper around the Host compaction service methods.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] (none)
 * usedBy: [generated] index.js, test/flow-tower.test.js
 * publicApi: [generated] wrapCompactionService
 * risk: Medium: monkey-patches a Host service; must restore original methods and never swallow errors.
 * --- end module contract ---
 */

const WRAPPER = Symbol.for('flow-tower.compaction.wrapper')

/**
 * @param {any} service the host `ctx.compaction` instance
 * @param {{ log?: any, onEvent?: (event: any) => void }} [options]
 * @returns {{ restore: () => void, methods: string[] } | null}
 */
export function wrapCompactionService(service, options = {}) {
  if (service === null || typeof service !== 'object') return null
  if (service[WRAPPER] !== undefined) return service[WRAPPER]
  const methods = ['compactIfNeeded', 'compactNow', 'compactRegion']
  const restore = {}
  const wrapped = []
  for (const name of methods) {
    if (typeof service[name] !== 'function') continue
    try {
      const original = service[name]
      restore[name] = original
      service[name] = async function wrappedCompaction(...args) {
        const started = Date.now()
        try {
          const result = await original.apply(this, args)
          try {
            options.onEvent?.({
              method: name,
              ok: true,
              ms: Date.now() - started,
              result: result === null ? null : { compacted: true },
            })
          } catch { /* metrics are best-effort */ }
          return result
        } catch (error) {
          try {
            options.onEvent?.({
              method: name,
              ok: false,
              ms: Date.now() - started,
              error: error instanceof Error ? error.message : String(error),
            })
          } catch { /* metrics are best-effort */ }
          throw error
        }
      }
      wrapped.push(name)
    } catch (error) {
      options.log?.warn?.(`cannot wrap compaction.${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (wrapped.length === 0) return null
  const handle = {
    methods: wrapped,
    restore() {
      for (const [name, original] of Object.entries(restore)) {
        try { service[name] = original } catch { /* ignore */ }
      }
    },
  }
  try {
    Object.defineProperty(service, WRAPPER, { value: handle, configurable: true })
  } catch {
    try { service[WRAPPER] = handle } catch { /* ignore */ }
  }
  return handle
}

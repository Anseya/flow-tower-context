/**
 * --- module contract ---
 * purpose: Host-adapter helpers for logging and fiber resource registration.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] (none)
 * usedBy: [generated] index.js
 * publicApi: [generated] effectOf, makeLogger
 * risk: Low: pure adapter helpers; tolerate partial Host APIs and never throw into plugin activation.
 * --- end module contract ---
 */

/**
 * Minimal logger that tolerates any Cordis logger shape.
 * @param {any} ctx
 * @returns {{ info: (message: string) => void, warn: (message: string) => void, error: (message: string, error?: unknown) => void }}
 */
export function makeLogger(ctx) {
  const prefix = '[flow-tower]'
  const write = (level, message, error) => {
    const line = `${prefix} ${message}${error === undefined ? '' : ` (${error instanceof Error ? error.message : String(error)})`}`
    try {
      const logger = ctx?.logger
      if (typeof logger?.[level] === 'function') {
        logger[level](line)
        return
      }
    } catch {
      // Fall through to the console fallback.
    }
    if (level === 'info') return
    // eslint-disable-next-line no-console
    console.warn(line)
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message, error) => write('error', message, error),
  }
}

/**
 * Register one resource with the plugin fiber, tolerating a missing `effect`.
 * @param {any} ctx
 * @param {(cleanup?: () => void) => any} register
 * @param {string} label
 */
export function effectOf(ctx, register, label) {
  try {
    if (typeof ctx.effect === 'function') return ctx.effect(register, label)
    return register()
  } catch {
    return undefined
  }
}

/**
 * --- module contract ---
 * purpose: Append the project digest to a compaction summarization request when the Basic backend is active.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] (none)
 * usedBy: [generated] index.js, test/flow-tower.test.js
 * publicApi: [generated] augmentCompactionRequest
 * risk: Medium: prompt mutation only; must never replace the backend instruction.
 * --- end module contract ---
 */

/**
 * @param {any} options GenerateOptions from the llm/stream waterfall
 * @param {{ digest: string, maxChars?: number }} input
 * @returns {boolean} whether the request was augmented
 */
export function augmentCompactionRequest(options, input) {
  if (options === null || typeof options !== 'object') return false
  if (options.purpose !== 'compaction') return false
  if (Object.isFrozen(options)) return false
  const digest = String(input?.digest ?? '').trim()
  if (digest.length === 0) return false
  const maxChars = Math.max(300, Math.min(8000, Number(input?.maxChars ?? 4000)))
  const block = `\n\n[Project context memory — use as background, do not copy verbatim]\n${digest.slice(0, maxChars)}`
  try {
    const messages = Array.isArray(options.messages) ? [...options.messages] : null
    if (messages !== null && messages.length > 0) {
      const last = messages[messages.length - 1]
      if (last?.role === 'user' && Array.isArray(last.content)) {
        messages[messages.length - 1] = {
          ...last,
          content: [...last.content, { type: 'text', text: block }],
        }
        options.messages = messages
        return true
      }
    }
    if (typeof options.system === 'string' && !Object.isFrozen(options.system)) {
      options.system = `${options.system}\n\n${block}`
      return true
    }
  } catch {
    // Frozen/immutable request: leave compaction untouched.
  }
  return false
}

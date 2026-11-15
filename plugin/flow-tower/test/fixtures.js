/**
 * Shared test fixtures: an in-memory session that mirrors the host's
 * `eventAt` / `deriveEventMessage` projection closely enough to exercise the
 * observation-only compiler without a Harness process.
 *
 * @module flow-tower-test/fixtures
 */

/**
 * Create one fake session with an append-only event log.
 * @param {{ id?: string, cwd?: string }} [options]
 */
export function createFakeSession(options = {}) {
  const id = options.id ?? 'session-test-1'
  const cwd = options.cwd ?? 'E:/project/demo'
  /** @type {any[]} */
  const events = []
  let time = 1_760_000_000_000

  const push = (type, data) => {
    const seq = events.length
    time += 1000
    events.push({ type, seq, time, data })
    return seq
  }

  return {
    id,
    header: { cwd },
    events,
    eventAt(seq) {
      return events[seq]
    },
    /** Derived model history, mirroring Session.deriveMessages() enough for tests. */
    deriveMessages() {
      const messages = []
      for (const event of events) {
        const message = this.deriveEventMessage(event)
        if (message !== null && message !== undefined) messages.push(message)
      }
      return messages
    },
    deriveEventMessage(event) {
      if (event === null || event === undefined) return null
      switch (event.type) {
        case 'user/message':
        case 'system/message':
        case 'developer/message':
          return event.data
        case 'assistant/message':
          return event.data.message
        case 'tool/result':
          return event.data.message
        default:
          return null
      }
    },
    addUser(text, source = { kind: 'user' }) {
      return push('user/message', {
        id: `m-${events.length}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source,
      })
    },
    addAssistant(text) {
      return push('assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: `m-${events.length}`,
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: 'test', model: 'test-model' },
        },
        stream: [],
      })
    },
    addToolResult(text) {
      return push('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: `m-${events.length}`,
          role: 'tool',
          content: [{ type: 'text', text }],
          source: { kind: 'tool', callId: `call-${events.length}` },
          toolCallId: `call-${events.length}`,
          isError: false,
        },
      })
    },
    /**
     * Append one compaction summary event covering the given seqs.
     * @param {{ compactionId?: string, seqs: number[], summary: string }} input
     * @returns {any} the appended session event
     */
    addCompaction(input) {
      const seqs = [...input.seqs].sort((a, b) => a - b)
      const seq = push('compaction/summary', {
        compactionId: input.compactionId ?? `cmp-${events.length}`,
        summary: [{ type: 'text', text: input.summary }],
        shadowedRange: { start: seqs[0], end: seqs[seqs.length - 1] },
        shadowedSeqs: seqs,
        shadowedTokenCount: 1000,
        provider: 'test',
        model: 'test-model',
      })
      return events[seq]
    },
    /** Append a native compaction checkpoint user message (dsh-compaction-basic shape). */
    addCheckpoint(summary) {
      return push('user/message', {
        id: `m-${events.length}`,
        role: 'user',
        content: [{
          type: 'text',
          text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background.\n<compacted-summary>\n'
            + String(summary ?? '')
            + '\n</compacted-summary>',
        }],
        source: { kind: 'compaction' },
      })
    },
    /** Append a compaction event without returning it (listener path helper). */
    pushEvent(type, data) {
      return push(type, data)
    },
  }
}

/** @returns {{ info: () => void, warn: (message: string) => void, error: (message: string) => void, messages: string[] }} */
export function createNoopLogger() {
  const messages = []
  return {
    messages,
    info() {},
    warn(message) {
      messages.push(String(message))
    },
    error(message) {
      messages.push(String(message))
    },
  }
}

/**
 * Sample conversation text that exercises every deterministic extractor.
 * @param {ReturnType<typeof createFakeSession>} session
 * @returns {number[]} the seqs to compact
 */
export function seedConversation(session) {
  const seqs = []
  seqs.push(session.addUser('我们决定采用观察式接入，不替换 compaction。请修改 plugin/flow-tower/index.js。'))
  seqs.push(session.addAssistant('已更新 `buildToolDefinitions()`；运行 `node --test` 验证。错误 ERR_MODULE_NOT_FOUND 已修复。'))
  seqs.push(session.addToolResult('src/compiler.js: The file was edited successfully. TODO: add router view.'))
  seqs.push(session.addAssistant('git status --short'))
  return seqs
}

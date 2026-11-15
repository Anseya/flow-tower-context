/**
 * --- module contract ---
 * purpose: Bilingual synonym/query expansion for retrieval.
 * dependsOn: [generated] lib/text-index.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/store.js
 * publicApi: [generated] expandQueryTerms
 * risk: Low: deterministic expansion; no network.
 * --- end module contract ---
 */

import { tokenize } from './text-index.js'

/** Bidirectional zh↔en pairs (lower-case English). */
const PAIRS = [
  ['上下文', 'context'], ['记忆', 'memory'], ['词典', 'dictionary'], ['摘要', 'summary'],
  ['压缩', 'compaction'], ['注入', 'inject'], ['检索', 'search'], ['召回', 'recall'],
  ['关系', 'relation'], ['关系图', 'graph'], ['任务', 'task'], ['决策', 'decision'],
  ['缓存', 'cache'], ['淘汰', 'eviction'], ['编译', 'compile'], ['配置', 'config'],
  ['设置', 'settings'], ['前端', 'frontend'], ['后端', 'backend'], ['插件', 'plugin'],
  ['工具', 'tool'], ['会话', 'session'], ['上下文窗口', 'context window'], ['预算', 'budget'],
  ['证据', 'evidence'], ['引用', 'citation'], ['向量', 'vector'], ['嵌入', 'embedding'],
  ['实体', 'entity'], ['节点', 'node'], ['边', 'edge'], ['图', 'graph'], ['数据库', 'database'],
  ['项目', 'project'], ['模块', 'module'], ['功能', 'feature'], ['时间线', 'timeline'],
  ['关系模式', 'relation mode'], ['摘要树', 'summary tree'], ['上下文注入', 'context injection'],
  ['记忆管理', 'memory management'], ['检索增强', 'retrieval augmentation'],
]

const ZH_TO_EN = new Map()
const EN_TO_ZH = new Map()
for (const [zh, en] of PAIRS) {
  ZH_TO_EN.set(zh, en)
  EN_TO_ZH.set(en, zh)
}

/**
 * Expand a query with known bilingual synonyms (base tokens kept as-is).
 * @param {string} query
 * @returns {string[]}
 */
export function expandQueryTerms(query) {
  const text = String(query ?? '')
  const terms = new Set(tokenize(text))
  const lower = text.toLowerCase()
  for (const [zh, en] of PAIRS) {
    if (text.includes(zh)) {
      for (const token of tokenize(en)) terms.add(token)
    }
    if (lower.includes(en)) {
      for (const token of tokenize(zh)) terms.add(token)
    }
  }
  return [...terms]
}

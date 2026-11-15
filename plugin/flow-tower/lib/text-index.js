/**
 * --- module contract ---
 * purpose: Tokenization, term weights and lexical index helpers for ranked search.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/embeddings.js, lib/semantic.js, lib/store.js, lib/synonyms.js, lib/topics.js
 * publicApi: [generated] entryTermWeights, sampleTerms, tokenize
 * risk: Medium: ranking behavior is user-visible; keep deterministic.
 * --- end module contract ---
 */

const CJK_RUN_RE = /[\u4e00-\u9fa5]+/g
const ASCII_WORD_RE = /[a-z][a-z0-9_./-]{1,}/g

/** Very common CJK bigrams/phrases that make poor search/topic terms. */
const CJK_STOP_TOKENS = new Set([
  '我们', '你们', '他们', '她们', '自己', '没有', '一个', '这个', '那个', '这些', '那些',
  '什么', '怎么', '因为', '所以', '但是', '然后', '如果', '可以', '已经', '还是', '就是',
  '不是', '只是', '这样', '那样', '现在', '时候', '东西', '事情', '问题', '地方', '一起',
  '起来', '出来', '回来', '过来', '下去', '上去', '一下', '一些', '一样', '知道', '觉得',
  '看到', '听到', '说道', '问道', '笑道', '可是', '而且', '不过', '虽然', '于是', '之后',
  '之前', '以后', '以前', '里面', '外面', '这里', '那里', '哪里', '开始', '发现', '终于',
])

/** English function words that make poor search/topic terms. */
const ASCII_STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were', 'have', 'has',
  'had', 'not', 'but', 'you', 'your', 'our', 'their', 'its', 'can', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'into', 'onto', 'over', 'under', 'between',
  'through', 'during', 'before', 'after', 'above', 'below', 'then', 'than', 'them', 'these',
  'those', 'there', 'here', 'where', 'when', 'what', 'which', 'who', 'whom', 'whose', 'why',
  'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'only',
  'own', 'same', 'too', 'very', 'just', 'also', 'now', 'use', 'used', 'using', 'get', 'got',
  'make', 'made', 'like', 'one', 'two', 'new', 'see', 'seen', 'per', 'via', 'etc',
])

/**
 * Tokenize text into searchable terms.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const value = String(text ?? '').toLowerCase()
  const tokens = []
  for (const run of value.match(CJK_RUN_RE) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      const bigram = run.slice(index, index + 2)
      if (CJK_STOP_TOKENS.has(bigram)) continue
      tokens.push(bigram)
    }
  }
  for (const word of value.match(ASCII_WORD_RE) ?? []) {
    if (word.length < 2 || ASCII_STOP_WORDS.has(word)) continue
    tokens.push(word)
    // Index path/symbol segments too: "src/compiler/cache.ts" -> src, compiler, cache, ts.
    if (/[./_-]/.test(word)) {
      for (const part of word.split(/[./_-]+/)) {
        if (part.length >= 2 && !ASCII_STOP_WORDS.has(part)) tokens.push(part)
      }
    }
  }
  return tokens
}

/**
 * Tokenize one dictionary entry into weighted terms (headword counts double).
 * @param {{ headword: string, gloss?: string, module?: string }} entry
 * @returns {Map<string, number>}
 */
export function entryTermWeights(entry) {
  const weights = new Map()
  const add = (text, weight) => {
    for (const token of tokenize(text)) weights.set(token, (weights.get(token) ?? 0) + weight)
  }
  add(entry.headword, 2)
  if (Array.isArray(entry.aliases)) {
    for (const alias of entry.aliases.slice(0, 8)) {
      if (typeof alias === 'string' && alias.trim().length > 0) add(alias, 3)
    }
  }
  add(entry.gloss ?? '', 1)
  add(entry.module ?? '', 1)
  return weights
}

/**
 * Tokenize a full text sample into a term set (topic extraction).
 * @param {string} text
 * @returns {Set<string>}
 */
export function sampleTerms(text) {
  return new Set(tokenize(text))
}

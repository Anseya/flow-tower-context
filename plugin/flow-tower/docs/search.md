# Search: recall, ranking and the panel UI

This note records the search pipeline, the measured recall baseline (v0.66.2)
and the remaining semantic-recall work. It complements `docs/injection-policy.md`
(what the model sees) and `docs/context-optimization.md` (token budget).

## Pipeline

```
compaction delta ──► extract candidates ──► entries
                                              │
                     tokenize: CJK bigrams, ASCII words, path segments
                                              │
                                   search_terms (headword×2, alias×3, gloss, module)
                                              │
        ┌─────────────────────────────────────┼──────────────────────────────┐
        ▼                                     ▼                              ▼
 lexical ranking (TF-IDF sum +        sparse TF-IDF cosine +          smart (opt-in):
 bilingual synonyms + relation       co-occurrence expansion          DeepSeek rewrite
 boost)                                                              + candidate rerank
        └─────────────────────────────────────┴──────────────────────────────┘
                                              ▼
                       hybrid = lexical order first, semantic fills gaps
                          + exact/prefix/substring/alias reasons
```

- **lexical**: BM25-lite style term weighting; `expandQueryTerms()` adds a fixed
  bilingual synonym table and path segments. This is the trustworthy baseline.
- **semantic**: sparse TF-IDF vectors over the same terms plus co-occurrence
  expansion. It is **not** a neural embedding; it only finds entries that share
  related terms.
- **hybrid** (default): preserves lexical order and only appends semantic hits
  that lexical ranking missed. Pure RRF fusion was measured to be worse than
  lexical (0.88 vs 0.94 overall), so it is intentionally lexical-first.
- **smart** (opt-in): two host-LLM calls (rewrite query → rerank candidates).
  DeepSeek-only, slower, best for "I know what I mean but not the words".
- **embedding** (optional): `embeddingEndpoint` + `tools/embed.mjs` backfill;
  used only with `mode=semantic`.

## Measured recall (`npm run eval:search`)

Synthetic project corpus: 12 compiled entries, 50 pseudo-queries, top-5.

| Query type | lexical | sparse semantic | hybrid |
| --- | ---: | ---: | ---: |
| exact headword | 1.000 | 1.000 | 1.000 |
| truncated headword | 0.917 | 0.917 | 0.917 |
| gloss fragment | 0.917 | 0.667 | 0.917 |
| cross language (zh↔en) | 0.929 | 0.143 | 0.929 |
| **overall** | **0.940** | **0.660** | **0.940** |

Interpretation:

1. Lexical + the bilingual synonym table is strong on project dictionaries;
   TF-IDF exact/prefix matching already covers most "I remember roughly" cases.
2. Sparse semantic-lite is weak as a standalone recall layer, especially for
   cross-language paraphrases. It should only fill gaps, never displace lexical.
3. Real semantic recall needs either the host LLM smart path or an embedding
   provider; the zero-dependency build cannot honestly promise neural semantics.

## API

`GET /flow-tower/api/search`

| Param | Values | Default |
| --- | --- | --- |
| `q` | query string | required |
| `mode` | `hybrid` / `lexical` / `semantic` | `hybrid` |
| `kind` | file/feature/decision/task/error/... | all |
| `module` | module prefix | all |
| `status` | open/done | all |
| `sort` | `relevance` / `recent` | relevance |
| `limit` | 1–100 | 15 |
| `scope` | entries/summaries/both | entries |

Response includes `mode`, `timingMs`, `results[]` with `entryId/headword/kind/
status/module/gloss/lastSeenAt/score/matched/sources/reasons`. `dict_search`
exposes the same `mode/kind/module/status/sort` parameters; `smart:true` keeps
the LLM path.

## Panel search UI (v0.66.2)

- Debounced search (320 ms) and Enter/Escape; no button-only flow.
- Kind, sort and module-prefix filters; semantic-only and smart toggles.
- Result cards: headword, kind/status, module, score, gloss, matched terms,
  lexical/semantic sources and exact/prefix/alias reasons.
- Keyboard: ↑/↓ moves between hits, Enter opens the entry detail + citations.
- "Load more" increases the limit without losing the current results.
- "Smart rerank" button appears on normal searches; when there are zero hits it
  is the recommended next step.
- All node text is written with `textContent`, so dictionary content cannot
  inject markup into the panel.

After replacing the client script, refresh the page once; the panel script is
served as part of the page and cached by the browser.

## Remaining semantic work (ordered)

1. **Auto smart fallback**: when hybrid top score is below a threshold or the
   result set is empty, offer/trigger one cached smart call; cache by
   `(query, project, mode)` for the panel session.
2. **Alias mining**: generate aliases from file basenames, path segments,
   citation excerpts and strong relation neighbors; index them at compile time.
3. **Query normalization**: light English stemming, CJK unigram fallback for
   two-character queries that miss, and prefix match for ASCII identifiers.
4. **Embedding path**: document a local/remote embedding endpoint recipe; keep it
   opt-in because the plugin promises zero external services by default.
5. **Eval growth**: add real-session queries (hand-written paraphrases) to
   `eval/search-recall.mjs`; current corpus is synthetic and deliberately small.

## Verify

```powershell
cd plugin\flow-tower
npm run eval:search          # lexical/hybrid recall report
npm test                     # 84 tests + module graph check
node --check <(extracted panel script)   # browser script syntax
```

Live verification (2026-11-15, runtime 0.66.2, port from the GUI URL):

```powershell
GET /flow-tower/api/search?q=checkpoint&mode=hybrid&limit=3   # 200, mode=hybrid,
#   fields: matched/sources/reasons/module/status/lastSeenAt
GET /flow-tower/api/search?q=搜索&mode=lexical&kind=feature&sort=recent&limit=2   # 200, filtered
GET /flow-tower/api/smart-search?q=检查点漏检&limit=3         # 200, mode=smart,
#   8 bilingual expanded queries, reranked=true (was a hard 500 before the import fix)
```

The search panel was also confirmed working in the GUI after a page refresh.

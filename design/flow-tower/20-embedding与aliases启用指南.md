# 20 · 如何真正启用 embedding 与 aliases（v0.42）

> 当前实测状态（2026-11-15）：
> `embeddingConfigured=false, vectorCount=0, entriesWithAliases=0, llmCompiler=off`
> 也就是说：**接口/字段/索引都在，但两项都还没真正启用。**

---

## 1. Embedding：配置 → 回填 → 验证

### 1.1 前置条件
需要一个 **OpenAI-compatible embeddings endpoint**：

```http
POST <endpoint>
{ "model": "text-embedding-3-small", "input": ["text1", "text2"] }
→ { "data": [ { "embedding": [0.01, ...] }, ... ] }
```

常见可用：
- OpenAI `https://api.openai.com/v1/embeddings`
- Ollama `http://127.0.0.1:11434/v1/embeddings`（model 如 `nomic-embed-text`）
- LM Studio / vLLM 的 OpenAI-compatible server

### 1.2 在设置页配置
打开 `Settings` → **语义 / embedding（可选）**：

| 字段 | 示例 |
| --- | --- |
| `embeddingEndpoint` | `http://127.0.0.1:11434/v1/embeddings` |
| `embeddingModel` | `nomic-embed-text` |

保存（全局或当前项目均可）。这是可编辑字段，**保存后工具侧动态读取，无需重载插件**。

### 1.3 API Key（如果 endpoint 需要）
插件的搜索请求跑在 **DSH 宿主进程**里，所以 key 必须在启动 DSH 前放进宿主环境：

```powershell
$env:FLOW_TOWER_EMBEDDING_KEY = "sk-..."
# 或 OPENAI_API_KEY
# 然后重启 DSH
```

只给 CLI 用的 key 不会自动传给宿主；反过来，宿主环境的 key 也不会进 Settings 文件（安全考虑）。

### 1.4 回填向量（必须）
语义搜索只有在 `entry_vectors` 表里有向量时才走 embedding，否则静默回退词法/稀疏。

```powershell
cd <plugin>/flow-tower
$env:FLOW_TOWER_EMBEDDING_KEY = "sk-..."   # 如需
node tools/embed.mjs `
  --project="E:\Programming-related Engineering Project\超级上下文" `
  --endpoint="https://api.openai.com/v1/embeddings" `
  --model="text-embedding-3-small" `
  --limit=2000
```

输出会显示 `embedded=N skipped=M`；向量写入项目本地 SQLite 的 `entry_vectors` 表。

### 1.5 验证
- 设置页底部会显示：`embedding=configured · vectors=N · aliases=M · llmCompiler=...`
- `/api/status` 的 `semantic.vectorCount` 应 > 0；
- `dict_search({query, semantic:true})` 或面板搜索勾选 `semantic`；
- 若结果与不勾选完全相同，检查：vectorCount 是否 0、endpoint 是否 401/超时、模型维度是否一致。

### 1.6 注意
- 向量写入后不会自动删除；淘汰会清对应向量；
- endpoint 会收到 `headword + gloss + module` 文本，隐私敏感场景请用本地 endpoint；
- `semantic:true` 是 embedding 优先，失败回退 sparse；不是"纯 embedding"。

---

## 2. Aliases：LLM 提案 → 提交 → 索引

### 2.1 先理解限制
- aliases 由 **LLM 提案** 生成（prompt 要求 2–6 个同语言别名/缩写/同义词）；
- `llmCompiler: shadow` **只审计不提交**，所以 **shadow 不会产生可检索的 aliases**；
- 要真正把 aliases 写入词条并建索引，必须 **`llmCompiler: on`**，并且发生一次编译（新的压缩/新内容）。

### 2.2 配置（Settings → 自动化 / LLM）

| 字段 | 建议 |
| --- | --- |
| `llmCompiler` | 先 `shadow`，再 `on` |
| `llmTimeoutMs` | `90000`（reasoning 容易超过 30s） |
| `llmMaxTokens` | 默认 16000，通常够；不足时改 patch/config |
| `proposalMode` | 可选；只影响是否落盘原始提案，不影响提交 |

保存后 **必须重载插件**：`modelCaller` 和 `dict_shadow_probe` 在插件启动时创建；只改设置不重载，LLM 不会真正接上。

```powershell
# 由代理执行
plugin_manager remove_bundle target=@local/flow-tower
plugin_manager install_bundle target=E:\dsh-plugins\flow-tower
```

### 2.3 先 shadow 验证
```json
{ "limit": 20, "offset": 0 }
```
调用 `dict_shadow_probe` 看：
- accepted/rejected；
- 条目是否包含 `aliases`；
- JSON 是否稳定、是否超时。

**shadow 只是评估，不会写 aliases。**

### 2.4 再 on，让它真正提交
1. `llmCompiler` 改为 `on`；
2. 重载插件；
3. 触发一次编译（继续聊天直到发生压缩，或新会话产生压缩）；
4. 提案中带 aliases 且通过 validator 的词条会写入 `entries.aliases`，并进入 `search_terms` 索引（权重 3）；
5. 之后用别名查询即可命中。

### 2.5 验证
- 设置页底部 `aliases=N`；
- `/api/status.semantic.entriesWithAliases > 0`；
- `dict_search({query: "某个别名"})` 能命中对应词条。

### 2.6 重要限制
- **不会自动回填历史词条**：只有 LLM 再次提案到同一 headword 时才会更新 aliases；
- 若要让现有 1994 条都得到别名，需要单独的 **alias backfill**（当前未提供）；
- `llmCompiler: on` 会真实调用宿主模型、有 token 成本与延迟；建议先 shadow 审核。

---

## 3. 故障排查

| 现象 | 检查 |
| --- | --- |
| `embeddingConfigured=false` | Settings 的 endpoint 是否保存到全局/项目层；项目层是否覆盖 |
| configured 但 `vectors=0` | 是否跑过 `tools/embed.mjs`；endpoint 是否返回 401/超时 |
| 勾 semantic 没变化 | 先看 vectorCount；再看 endpoint 维度是否一致；失败会静默回退 |
| `llmCompiler` 改 on 没反应 | 没有重载插件；或 settings 覆盖 patch（settings 优先） |
| shadow 有 aliases 但搜不到 | shadow 不提交；需要 `on` + 编译 |
| LLM 超时 | `llmTimeoutMs` 调大（如 90000）；reasoning 模型需要更长 |
| aliases 覆盖率低 | 历史词条未重新编译；需要 alias backfill 或再次压缩 |

---

## 4. 一句话操作顺序

**Embedding**：Settings 填 endpoint/model →（如需 key 用宿主环境变量）→ `tools/embed.mjs` 回填 → 搜索勾 semantic。
**Aliases**：Settings 设 `llmCompiler=shadow` → 重载 → probe 审核 → 改 `on` → 重载 → 触发压缩 → aliases 入库/可检索。

# 流动塔 · DSH 社区插件源码解剖（03）

> 日期：2026-11-15 · 解剖员：plugin-source · 唯一写入范围：本文件
> 上游：`00-精读笔记.md`（事实层）、`01-构思对齐.md`（讨论层，第 8.3 节待核验）
> 标注约定：**【源码】**＝本地文件可逐字核到，后附 `文件:行号`；**【判断】**＝我的推论或归纳，未在源码中验证。
> 行号口径：本地解压副本；bgx666 `index.js` 1651 行、`client.js` 1827 行、`src/text.js` 216 行、`src/store.js` 559 行（与 `00-精读笔记` 记的 1625/1826/213 行差 1 行以上，是不同快照，引用以本次行号为准）。

---

## 1. 读了什么（逐文件）

### 1.1 bgx666 版 `@xiaob/dsh-memory-tree` 0.4.21（约 5600 行）

| 文件 | 行数 | 关键内容 |
| --- | --- | --- |
| `package.json` | 74 | `dsh.bundle.patch`、`dsh.client.inject`、`peerDependencies`（:49-73） |
| `cordis.patch.yml` | 10 | 只 insert 一行 `memory-tree`（:8-10） |
| `index.js` | 1651 | 顶层原型 patch、Config、4 条 HTTP 路由、异步压缩作业、事务提交、prompt 段注册 |
| `client.js` | 1827 | Web 半：`__ModuleLoader__` 信封、`conversation.chat.node` 槽位接管、卡片解析与 DOM 折叠、设置页 |
| `src/store.js` | 559 | SQLite DDL、事务、append-only 合并、moveSession、stats |
| `src/engine.js` | 443 | 分片 → 反向渐进前缀 → 叶子 → mergeUp → checkpoint 渲染 |
| `src/schema.js` | 237 | 节点字段归一化、`applyBudget` 硬裁、字段行渲染 |
| `src/text.js` | 216 | 节点文本、`renderNodeBlocks`、`isCheckpoint`、时间范围 |
| `src/tool.js` | 184 | `explore_memory_tree` 完整 schema + 下钻答案 |
| `src/policy.js` | 187 | 定价、选区间、区间回放、空闲锁扫描、checkpoint 帧 |
| `src/llm.js` | 100 | `ctx.llm.stream` 调用、`parseNodeJson` 三级恢复 |
| `src/chunk.js` | 64 | token 分片、tool 配对安全 |
| `src/prompts.js` | 50 | 模板加载与严格占位符替换 |
| `src/status.js` | 214 | CLI 看树 + 生命周期日志，`MAX_DEPTH=6`（:28） |
| `prompts/compress/*` | 14 个 md | 7 类 prompt × zh/en（leaf / parent / skeleton / budget / retry / leaf_scope / leaf_scope_chunk） |
| `tests/*.js` + `probe-install.mjs` | 5 个 | policy / async / smoke（10 个 `test(`）/ client / 安装漂移探针 |
| `tools/sync.mjs`、`tools/db-schema.mjs` | 88 + 22 | 发布到 profile（非 symlink）、打印表结构 |
| `README.md` | 344 | 安装、证据链、文件表、数据库说明 |

### 1.2 qinghuaju 版 `dsh-memory-tree` 0.4.2（文档 4 篇 + 核心源码）

- `docs/ARCHITECTURE.md`（234 行）全读：进程隔离、集成点表、数据模型、AST、召回打分、分层、安全、性能。
- `docs/TOOLS.md`（165）、`docs/PRINCIPLES.md`（172）、`docs/PHASE1.md`（172）全读：五个工具、设计权衡、配置全表、风险。
- `src/plugin.mjs`（513）全读；`src/dsh/{tools,inject,capture,host-client,engine-host}.mjs` 全读；`src/engine/{space,index,ast}.mjs` 与 `store.mjs` 的 DDL/事务段全读。
- `src/engine/{engine,recall,config,embed}.mjs` **只按符号抽查**（grep `rememberExchange`/`recall`/`spaceId`），未逐行读完——这是本文件的读法边界。

### 1.3 projects/ 下 7 份文档与 CoMeT

- `dsh-memory-tree_DEPLOY.md`（180 行）：三种部署形态、单 profile 单写者、数据目录搬迁、故障排查。
- `dsh-memory-tree_PHASE1.md` / `_PRINCIPLES.md` / `_TOOLS.md`：与 qinghuaju `docs/` 同名文件为同一份内容的拷贝（行数一致）。
- `dsh-memory-tree_bgx666_README.md`（= 仓库 README 拷贝）、`dsh-memory-tree_bgx666_中文解析.html`：二手导读页，章节为"这是什么/核心功能/与会话绑定的开关/压缩与树结构/界面与按需加载/配置入口"。
- `dsh-memory-tree_qinghuaju_README.md` / `README.zh.md`：跨会话记忆定位 + 安装器 + 市场索引说明（`market/index.json` format 1）。
- `CoMeT_CognitiveMemoryTree_README.md`（289 行）+ `comet-memory_pypi.json`：0.5.0 / MIT / `requires_python>=3.12` / 分类 `Development Status :: 3 - Alpha` / `home_page: null`、`project_urls: null`。

---

## 2. 两插件架构对比（表）

| 维度 | bgx666（会话内压缩替换） | qinghuaju（跨会话长期记忆） |
| --- | --- | --- |
| 定位 | 替换压缩后端的 **summarize 实现**，把扁平摘要换成树 | 旁路捕获会话 + 召回注入 + 工具，**不碰 compaction** |
| 挂载 | `package.json` `dsh.bundle.patch` + `insert` id/包名（:49-52, patch:8-10） | 同左，但 `name: './src/plugin.mjs'` 相对入口（patch:10-14） |
| 扩展点 | **模块顶层** patch `BasicCompactionEngine.prototype.summarize/compactIfNeeded`（index.js:179-225） | **声明式** `apply(ctx, config)` + `ctx.on`/`ctx.inject`（plugin.mjs:146-160, 349-359） |
| 进程模型 | 与宿主同进程 | 引擎 fork 子进程，宿主只做 IPC（ARCHITECTURE.md:6-29；host-client.mjs:118-193） |
| 存储 | 单库 `$DSH_HOME/memory-tree/memory_tree.db`，4 表（store.js:17-74） | hot/warm/cold 三库，9 表 + FTS5（store.mjs:24-134） |
| 树的性质 | **摘要树**：向上合并成父节点 | **AST 文档树**：结构硬解析 + embedding 软边（ast.mjs:94-116） |
| 节点 ID | `node<level>_<3位序号>`（store.js:208-226） | 整数自增 + `path`（`/根/小节`，ast.mjs:98-116） |
| 原文保真 | 叶子 `details` 存原始消息数组（engine.js:242-258） | `documents.text` 存原文（ARCHITECTURE.md:39-58） |
| 写入 | 压缩事务 `beginRun/commitRun/discardRun/rollback`（store.js:258-289, 382-394） | 小同步事务 + `pending/failed` 重试（PRINCIPLES.md:105-123） |
| 上下文注入 | 压缩 checkpoint 本身就是树（policy.js:176-182） | `agent/pre-step` 注入一条 `<memory-recall>` 消息（plugin.mjs:266-313） |
| 工具 | 1 个：`explore_memory_tree`（tool.js:41-78） | 5 个：`mem_recall/store/stats/dream/rotate`（tools.mjs:33-356） |
| UI | Web 半接管 `conversation.chat.node` 的 `compaction` 槽位（client.js:19-29, 1749-1775） | 无 client 半，只有工具卡片 `presentCall`（tools.mjs:112-117） |
| 多实例 | 全局 `active` 单 owner（index.js:166） | 无全局态，但数据层单写者（TOOLS.md:137） |
| 失败策略 | 任何异常退回后端扁平摘要（index.js:1634-1648） | 捕获失败只记日志；召回超时静默跳过（plugin.mjs:304-312） |
| 引擎约束 | `dsh >=0.2.1-rc.3 <0.3.0`（package.json:25-27） | `dsh ^0.2.1-alpha.2`、Node ≥22.5（package.json:24-27） |

---

## 3. 挂载与扩展点机制

### 3.1 bundle patch 的两种写法【源码】

bgx666：`package.json:49-60` 声明 `dsh.bundle.patch`、`dsh.client.inject: ['@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-renderer']`、`platform: 'web'`；`exports` 暴露 `"." → ./index.js`、`"./client" → ./client.js`（:31-37）。
`cordis.patch.yml:8-10` 只有 `- insert: [{ id: memory-tree, name: '@xiaob/dsh-memory-tree' }]`，:1-7 注释明确"**故意不禁用 compaction-basic**……后端仍是 `ctx.compaction` 的唯一 owner（锁、tool 配对、surface 替换都在它手里）"。
qinghuaju：`package.json:70-74` 同样 `dsh.bundle.patch`，`cordis.patch.yml:10-14` 的 `name` 写的是 **相对路径** `./src/plugin.mjs`，并带 `config: { enabled: true }`。
**【判断】** 两种 `name` 形态都被接受（一个包名、一个相对入口），说明我们可以先按 qinghuaju 的相对入口做本地开发，发布时再由包名解析；`config` 块可以随 insert 一起下发，这正好是"流动塔"的树级默认预算入口。

### 3.2 顶层副作用 patch + 符号去重（多实例的关键约束）

```js
// index.js:176-198（摘）
const ORIGINAL = Symbol.for('@xiaob/dsh-memory-tree/original')
const previous = Base.prototype.summarize
const originalSummarize = previous?.[ORIGINAL] ?? previous
const patched = async function patchedSummarize(input, agent, signal) {
  if (active === null) return originalSummarize.call(this, input, agent, signal)
  return active.compact(this, input, agent, signal)   // ← 永远只有"最后一个 constructor 的实例"接活
}
patched[ORIGINAL] = originalSummarize
Base.prototype.summarize = patched
```

- **【源码】** 同样的手法用于 `compactIfNeeded`（index.js:201-225），把 `pressure` 触发改为后台作业，溢出/手动 `/compact` 仍走同步。
- **【源码】** 防 HMR 双包裹：`previous?.[ORIGINAL]` 取回"真正的原始实现"（:180, 202），再挂回新 wrapper；日志 `rewrapped=no|yes`（:196）。
- **【源码】** 单 owner：`let active = null`（:166）→ 每次 `constructor` 里 `active = this`（:660）→ 卸载时 `if (active === this) active = null`（:747）；HTTP 处理器写成 `(active ?? this)._serveXxx`（:699-706），所以旧实例的路由不会打到旧 store 上。
- **【源码】** hook 安装失败只记 `patchfail` 日志不抛错（:182-184, 223-224），"插件没加载"和"压缩静默退回扁平摘要"都可在 `$DSH_HOME/memory-tree/plugin.log` 事后区分（:134-154）。

### 3.3 其余扩展点（bgx666 全清单）

| 扩展点 | 写法 | 行号 |
| --- | --- | --- |
| 系统提示词段 | `ctx.inject(['systemPrompt'])` → `prompt.section({ name:'tool:explore_memory_tree', order: getSectionOrder('TOOL_READ')+10, text:(context)=>… })`，按 `_sessionEnabled` 返回空串 | index.js:627-651 |
| 工具注册 | `ctx.get('tools').register({...})`，`ctx.effect(() => () => off())` | tool.js:41-78 |
| HTTP 路由 | `scope.get('webServer')`/`ctx.get('webServer')` → `web.register({ kind:'exact', path, handler })`；用 `Symbol.for('@xiaob/dsh-memory-tree/route-cleanup')` 在 HMR 前先清旧路由；`duplicate exact route` 视为可容忍 | index.js:674-745 |
| 设置热更新 | `ctx.on('settings/document-updated', ns)` → 重读 `settings.describe()` 里 `memory-tree` 的 config | index.js:764-776 |
| 会话事件 | `ctx.on('session/event', …)` 做孤儿压缩修复 + 记录保留行 | index.js:780-787 |
| 卸载清理 | `ctx.effect(() => () => { abort jobs / rollback / close store / active=null })` | index.js:746-760 |
| Web 半 | `window.__ModuleLoader__.load({ id, factory: (require) => ({ apply, inject }) })`，`inject=['slots']`，导出 `apply(ctx)` | client.js:19-29, 1814-1815 |

### 3.4 qinghuaju 的插件形态【源码】

- `name`/`inject` 命名导出（plugin.mjs:37-38），`Config` 用 schemastery 但**故意不给字段默认值**（:40-47 注释说明默认值会遮蔽 `config.json`），`apply` 整体 try/catch（:146-156）。
- 钩子逐个 `attach` 并各自 try/catch："某个 hook 改名只损失那个 hook"（:336-359）；`agent/error` 上做注入熔断（:315-334）。
- `defineTool` 声明式 schema：`parameters` 用**对象映射**而非 JSON Schema（tools.mjs:47-59），带 `output.schema/render`、`timeoutMs`、`isConcurrencySafe`、`presentCall`（tools.mjs:61-117）。
- 注入消息的 source 是硬约束：session format v4 要求"producer-owned source kind"，旧 `{kind:'plugin'}` 会被迁移成 `plugin:<name>`，**第三方插件必须直接发迁移后的形状**（inject.mjs:9-13, 102-108）。

---

## 4. 存储 / 事务 / prompt / 工具 / UI 逐项解剖

### 4.1 SQLite DDL（bgx666，store.js:17-60）

- `nodes`：`PRIMARY KEY(session_id, id)`，列 `level/summary/parent_id/msg_start/msg_end/created_at/is_active/dedupe_key/details/meta/time_start/time_end/run_id`（:18-35）。
- 索引：`ux_nodes_dedupe(session_id, dedupe_key) WHERE dedupe_key IS NOT NULL`、`ix_nodes_active(session_id, level, is_active)`、`ix_nodes_parent`、`ix_nodes_roots(session_id, is_active, parent_id, msg_start)`（:36-41）。
- `runs(run_id PK, session_id, committed, created_at)`；`keeps PK(session_id, checkpoint)`；`session_prefs(session_id PK, enabled)`（:42-59）。
- 打开时 `PRAGMA journal_mode=WAL; busy_timeout=5000; synchronous=NORMAL`（:142-144）；`#migrate` 只 `ALTER TABLE ADD COLUMN`（meta/time_start/time_end/run_id），不重写旧行（:162-170）。

### 4.2 事务与防孤儿

- 通用事务：`BEGIN IMMEDIATE` → action → `COMMIT`，异常 `ROLLBACK`（store.js:102-117）。
- 三件套：`beginRun` 插入 `committed=0` 的 run（:258-264）；`commitRun` 置 1（:271-275）；`discardRun` 删该 run 的节点+run（:282-289）。
- **提交顺序（关键）**：后台写节点的 runId 先 `commitRun`（index.js:1462）→ 写 `compaction/start` → `compaction/summary` → 替换 surface 的 `user/message` → `compaction/end`（index.js:1468-1507）；替换落地后置 `prepared.committed=true`（:1505），此后不再回滚。
- 失败路径：`_rollback` 删本次 created 节点 + `discardRun`（index.js:885-896）；`rollback` 先把子节点 `parent_id=NULL,is_active=1` 再删父（store.js:382-394）。
- 启动自愈：`#recoverRuns` 在 open 时删除所有 `committed=0` 的节点（store.js:182-193）；会话层另有 `closeOrphanedCompaction` 补写缺失的 `compaction/end`（index.js:545-567，仅当 start 超过 60s）。
- 提交前四道锁校验：区间仍在 surface、seq 未变、`toolPairingBalancedBefore/After`、`inspectIdle` 无开回合/无未配对 compaction（index.js:1437-1455）。

### 4.3 append-only 与 `is_active` 语义

- `merge`：插入父节点（level=子层+1、range 取并集、时间取首尾），然后把每个子节点 `parent_id=父, is_active=0`——**不删除**（store.js:344-369，:365-366）。
- `roots` = `is_active=1 AND parent_id IS NULL`（:407-414）；`children` 不筛 `is_active`（:417-423），所以被合并的子节点仍可通过 `explore_memory_tree` 下钻（tool.js:117-123）。
- 上下文的可见性只看 roots：checkpoint 只渲染活跃根（text.js:205-215），旧节点不退化成"消息"。
- 层级无硬上限：`mergeUp` 以 `store.stats().depth` 决定是否继续（engine.js:394-402）；`status.js:28` 的 `MAX_DEPTH=6` 只影响 CLI 打印。
- **【判断】** 这套"删旧 = 置位 + 指父"正是"流动树"最省事的可逆底座：任何重挂/升降只需改 `parent_id/is_active`，原文与旧视图永远可回溯。

### 4.4 节点 ID 与消息区间

- ID：`node${level}_${String(value).padStart(3,'0')}`（store.js:208-226），号段从 `SELECT id … ORDER BY id DESC` 反推；内存计数器 `#counters: Map<sessionId, Map<level,next>>`（:122-123, 209-214）。
- 反向预分配：模型调用按"最新片→最旧片"倒序跑，但 ID 在循环前正序预留，保证序号跟时间线（engine.js:204-212）。
- 消息序：`msg_start/msg_end` 是 surface 内消息序号；`#nextOrdinal = MAX(msg_end)+1`（store.js:229-235），叶子按 chunk 长度推进。
- `dedupe_key` 列与 `hasLeaf`（:292-297）是内容去重入口，但当前引擎写入时传 `null`（engine.js:255）——**预留未用**。

### 4.5 上下文注入：三件套

1) **系统提示词**（index.js:52-87，`MEMORY_TREE_PROMPT`）结构依次为：树是什么 → 【先读可见节点】 → 【节点是什么】 → 【压缩保留什么】 → 【怎么查】 → 【树的结构与翻法】 → 【一致性】。要点：node 是"你自己的记忆不是资料"、`[已压缩 · 不需要压缩]` 是保护标记、先读可见节点再调工具、通常 2~4 次调用、工具说"找不到节点"是编号问题不是记忆缺失、不许编造。
   注入是**按会话条件返回**的：`text: (context) => _sessionEnabled(sessionId) ? limits.systemPrompt : ''`（:634-645）；配置里清空该字段即回落到内置全文（:345-351）。
2) **checkpoint 即树**：`renderNodeBlocks` 产出 `[记忆树] 共 N 个活跃节点，深度 Lx，已折叠到第 M 条。…` 头 + 每根节点一个 block（text.js:205-215）；`nodeText` 格式见 :128-148（`[node0_003 · L0 · 第13-18条] [已压缩 · 不需要压缩]` + `[摘要]`/`[时间]`/字段行）。外层由 `frameBlocks` 包成"preamble + `<compacted-summary>` + blocks + `</compacted-summary>`"（policy.js:13-20, 176-182），整段作为**一条 user 消息**的多个 content block 替换被遮蔽区间（index.js:1471-1501）。
3) **token 预算**：
   - 节点：`nodeBudget=1000` 字（zh；en ×3.5），summary 占 40%、fields 占 60%（engine.js:30-34）；`applyBudget` summary 硬帽 60%、组牺牲顺序 `env/commands/artifacts/patterns/next_steps/blockers/user/todo/decisions/errors/constraints`，总量超 1.1× 再砍 summary（schema.js:132-191）。
   - 一轮：`chunkTokens=30000`、`maxChunks=12`（Config:105-106）；缺口由 `covered` 回传，只提交被摘要的前缀（engine.js:182, 265-268；index.js:1329-1345）。
   - 触发：`triggerTokens=500000`（0=按窗口比例），`retainMessages=30`，优先级 default < env < profile（index.js:324-362, 337-343）。
   - 详情：单节点展开 `DETAIL_TOTAL=12000`、每条 700 字、最多 40 条（tool.js:30-32；index.js:1155-1162 同值）。
   - 溢出保护：checkpoint 估价 ≥ 被遮蔽 token 就先降级为 summaryOnly，再不行抛错（index.js:1476-1488）。

### 4.6 渐进分片与"前缀缓存"

`splitByTokens`：0.75× 目标且遇 user 边界才切，1.4× 硬切，**绝不在 tool call/result 之间切**（chunk.js:16-18, 33-57）。
调用顺序：`for (index = chunks.length-1; index >= 0; index--)`，每片请求 = system + 上次 checkpoint（或已有根节点） + `chunks.slice(0, index+1)` + 指令（engine.js:194-228）。第一个请求最长，之后每片都复用已建立的最长前缀。
**【判断】** 这是"流动塔"最该抄的性能件：它把"每次压缩要重读全量"变成"每轮只多读一片"；代价是每片必须带全前缀，所以 `chunkTokens × maxChunks` 就是单轮上下文上限（30k×12=360k）。

### 4.7 `explore_memory_tree`：完整 schema 与 handler

```json
// tool.js:44-66（源码压缩摘录）
{ name: "explore_memory_tree", parameters: {
    type: "object", additionalProperties: false, required: ["node_id"],
    properties: { node_id: { type: "string", description: "...e.g. \"node0_012\" or \"node1_003\"..." } } },
  output: { schema: { type:"object", additionalProperties:false, required:["text"], properties:{ text:{type:"string"} } },
            render: (_args, value) => [{ type: "text", text: value.text }] } }
```
- handler：`exec.agent.session.id` 取分区（:67-75）→ `describe(store(), sessionId, nodeId, limits)`。
- `describe` 逻辑（:97-144）：空树提示 → 头部统计 → 节点不存在时明确"编号不存在≠记忆里没有" → 命中节点全文 → 有子节点则列子节点（`- id Lx #a–#b 时间 摘要`，摘要 `excerptChars` 默认 260）→ 叶子才回放 `details`（预算 12000/条 700，按 `【role · HH:MM】` 渲染）。
- 纯文本工具调用且无正文时，用 `【assistant→tool】name(args)` 补一行（:173-184），否则回放只剩工具结果看不出是谁调的。
- **【源码】** 只有 `node_id` 一个参数，无关键词搜索、无直达叶子捷径；靠 prompt（index.js:71-81）引导"2~4 次、够用就停"。

### 4.8 HTTP 路由与 UI 卡片协议

| 路由 | 方法/参数 | 返回 | 行号 |
| --- | --- | --- | --- |
| `/memory-tree/api/status` | GET `?session=&compaction=` | `{jobs, last, live, keep, enabled}`（:1014-1020） | index.js:938-1026 |
| `/memory-tree/api/session` | POST `?session=` body `{enabled}` | `{session, enabled}`；关闭时 abort 作业 | index.js:1038-1076 |
| `/memory-tree/api/node` | GET `?session=&id=` | `{id,level,start,end,summary,time,body,children,details}`（:1174-1184） | index.js:1125-1188 |
| `/memory-tree/api/move` | POST body `{source,target}` | moveSession 统计 | index.js:1086-1115 |

UI 协议（client.js）：
- 信封 `window.__ModuleLoader__.load({ id, factory })`，`factory(require)` 里 `require('react')`，无构建步骤（:1-26）。
- 槽位：`ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name, key:'compaction', priority:-1 }, MemoryTreeCard))`——原版行在 priority 0，**-1 才遮蔽**（:1749-1761，注释引用了宿主报错原文）。
- 解析：`HEAD = /^\[node(\d+)_(\d+) · L(\d+) · 第(\d+)-(\d+)条\]/`（:43）、`DIGEST = /^\[记忆树\]/`（:45）；不匹配时 `parseSummary` 返回 `{header:'', raw, nodes:[]}`（:93），卡片退化为原文显示。
- "只显示最新树"：`cardEnd = max(summaryEventSeq ‖ shadowedRange.end ‖ shadowedSeqs.at(-1))`（:676-679），`useLatestCard` 只让最大者渲染，其余 `return null`（:645-661, :874）；注释原文"the tree is one evolving structure"（:629-635）。
- DOM 折叠：用 `data-chat-node-key` 找行（:112-120），按 keep 集合把 checkpoint 之前的行隐藏（:776-872）；keep 集合来自 `/status?compaction=<seq>`（:699-726），落库在 `keeps` 表；`pageshow`/`visibilitychange` 时重读（:745-769）。
- 其它槽位：`conversation.composer.dock`（会话级开关 + 进度，order -100，:1780-1784）、`settings.section`（id `memory-tree`，order 55，:1786-1803）、通过 `ctx.get('configForms')` 读写同一 `Config` 命名空间（:1786-1792）。

### 4.9 qinghuaju 的数据/召回模型（对照用）

- 表：`spaces/documents/nodes/vectors/edges/embed_cache/recalls/audit` + FTS5 contentless（store.mjs:24-134）；`nodes` 有 `space_id/path/parent_path/depth/kind/hash/importance/access_count/archived`（:60-82）；唯一去重 `documents(space_id, hash)`（:56）。
- 空间：`project:<规范化根路径>` 或 `global`（space.mjs:13-18, 51-60）；召回默认 project+global（:62-68）——**这是资料里最接近"多树隔离"的现成分区模式**。
- 召回打分：`(0.55·cos + 0.20·lexical + 0.25·RRF) × tierWeight + 0.06·importance + 0.05·exp(-age/45d) + 0.03·log1p(access)`，命中后一跳扩散（父 ×0.55，邻居 ×0.55·sim），≥0.88 去重（ARCHITECTURE.md:128-142；PRINCIPLES.md:60-79）。
- 注入：`agent/pre-step` waterfall 先 `await next()`，仅 `kind==='enter' && step===1`；每 `(session,turn,query)` 一条、60s 冷却、失败熔断（plugin.mjs:266-313, 192-210）。
- **【判断】** 对"分总层"最有参考价值的是它把"注入块"当成有预算的一等对象（`maxNodes/maxChars/maxNodeChars` 三层限流 + 多样性阈值 + 审计表 `recalls`），而不是把摘要全量塞进 prompt。

---

## 5. 01-构思对齐 §8.3 五处硬编码核验

| # | 原文主张 | 核验 | 证据与修正 |
| --- | --- | --- | --- |
| 1 | `index.js:166 let active = null` 全局单实例，prototype 钩子只能一个 owner | **准确** | :166 定义；:191-192 wrapper 读 `active`；:195/222 挂 prototype；:660 `active=this`；:747 置 null；路由 `(active ?? this)` :699-706。**补充**：prompt 段闭包绑定 `this._limits`（:640-643），多实例时旧实例注册的 section 会读旧配置 → 需要"注册表 + 单入口分发"，不只是换变量。 |
| 2 | `store.js` 单库单表 `PRIMARY KEY(session_id,id)`，所有查询按单 session | **基本准确**，措辞需修 | PK 在 :34；是**单库四表**（:17-60），不是单表。单 session 分区：`roots` :407、`stats` :544、`node` :426、`children` :417、`activeAtLevel` :397、`nextNodeId` :249、`nextOrdinal` :229、`setKeep/getKeep` :448/461、`sessionEnabled` :482、`moveSession` 相关 :530-536。**补充**：库路径固定 :70-74；`#counters` 内存计数器以 sessionId 为键 :122-123/209-213；`sessions()` 无参全库聚合 :433-439。 |
| 3 | `MEMORY_TREE_PROMPT` 写死一棵树；`renderNodeBlocks` 只渲染一棵；client 正则只认 level+serial | **准确** | index.js:52-53；text.js:205-215（签名只吃 `roots` + 单会话 `stats`）；client.js:43。**补充（8.3 漏）**：ID 分配器 store.js:208-226 无树前缀；`[记忆树]` 标记与 `isCheckpoint` 只认单一 digest 头（text.js:170-191）。 |
| 4 | 工具只收 `node_id`；4 路由按 session+id；`_jobs/_last/_keeps/_agents/_engines/_store` 全是 Map | **部分不准确** | 工具 :47-57、handler :67-75、路由 :699-706、status 参数 :938-947、node 参数 :1130-1140 均属实。**修正**：`_store` 不是 Map，是单实例字段（:605, :875-878）；真正的 Map 是 6 个：`_jobs/_last/_keeps/_agents/_engines/_skipUntil`（:607-616）。 |
| 5 | `moveSession` 单树整棵迁移且拒绝覆盖；client 注释"one evolving structure"、只渲染最大卡 | **准确**（一处措辞需修） | store.js:515-541，目标已有点即抛错 :519-522，整棵 `UPDATE session_id` :530-532；client.js:629-635 注释、:636-661 注册表、:874 `return null`。**修正**："最大卡"的判据是 `cardEnd=max(summaryEventSeq‖shadowedRange.end‖shadowedSeqs.at(-1))`（:676-679），不是字面上的 summaryEventSeq。 |

**结论【判断】**：8.3 的方向完全成立（prototype 单 owner、prompt 单树、UI 单卡是架构级），但它是按"5 个功能面"归纳的，漏了 3 类同等级的耦合：**ID/主键命名空间**、**会话级开关与 jobs 键**、**checkpoint 体积校验**。多树改造应按下面 5.2 的清单排期，而不是只改 5 处。

### 5.2 8.3 没提到的硬编码（按风险排序）

| 编号 | 硬编码 | 证据 | 对多树的影响 |
| --- | --- | --- | --- |
| A | 节点 ID `node{level}_{三位}` + `#counters` 以 sessionId 为键 | store.js:208-226, 122-123 | 同一会话两棵树都会从 `node0_001` 起号 → **撞 PK**。必须改成 `tower_id` 参与 ID 或改复合主键。 |
| B | 压缩是**会话级串行锁**：`compaction/start…end` 与 `inspectIdle` | index.js:1449-1455, 545-567；policy.js:141-173 | 多树不能并发提交 checkpoint；"两棵树同时上浮"必须排队或合并成一次事务。 |
| C | 后台作业与 agent/engine 快照按 session 唯一 | index.js:607-616, 1214-1217, 1216 `if (this._jobs.has(sessionId)) return true` | 一次会话只允许一个后台压缩；多树需要 per-tower 作业键，否则第二棵树永远拿不到槽。 |
| D | 会话级开关表 `session_prefs` + `_sessionEnabled` 闸门 | store.js:55-59, 482-502；index.js:640-643, 808-814, 1210-1213, 1621-1624 | 现在是"开=整会话一棵树"；多树需要树级开关与"会话↔树"归属规则（8.4 未定项）。 |
| E | checkpoint 单树渲染 + "必须比被遮蔽区间小"硬校验 | text.js:205-215；index.js:1476-1488 | 多树摘要会把 checkpoint 撑大；这条校验会让"分总层常驻"首先撞墙。**这是多树最硬的一个物理上限。** |
| F | `keeps` 以 `(session_id, checkpoint)` 为键，折叠边界按会话 | store.js:48-54, 448-472；index.js:826-844 | 卡片折叠边界无法区分树；多树 UI 需按树/按 checkpoint 重新定义可见范围。 |
| G | 配置/预算单实例：`Config`、`readLimits`、settings 热更新 | index.js:103-132, 324-362, 764-776 | 一处 `nodeBudget/mergeThreshold` 服务所有树；多树若要"每树不同流动阈值"需树级配置层。 |
| H | HTTP/UI 请求无塔参数 | index.js:938-947, 1130-1140；client.js:704-710, 881-884, 1663 | 前端只能拿到"这个会话的树"；多树视图需要 `tower` 参数与新的 status 载荷。 |
| I | 单库路径与 `sessions()` 全库聚合 | store.js:70-74, 433-439 | 选"每树一库"就要重写状态枚举与迁移；选"一库多树"要加 `tower_id` 列并重建 4 个索引。 |
| J | 诊断单文件 `plugin.log` | index.js:146-154；status.js:117-123 | 多树日志混流；多实例/多树排查会非常困难（轻风险但修复成本低）。 |

**【判断】** A/B/C/E 是"架构级"，必须在第一版开工前定死；D/F/G/H 是"加字段+改查询"；I/J 可以后置。E 的缓解方式我倾向"checkpoint 只放路由视图（tree_id + 一句话画像 + 预算），树内摘要仍留在树库、由工具按需取"——正好对上 `01-构思对齐` §8.2 的"路由视图 vs 总述视图"分工。

---

## 6. 可复用 vs 必须重写（按文件粒度）

### 6.1 可直接复用（几乎不改）

| 来源 | 文件 | 理由 |
| --- | --- | --- |
| bgx666 | `src/schema.js` | 字段集 + `applyBudget` 的"组牺牲"算法与树无关，只需在渲染头加树标识 |
| bgx666 | `src/chunk.js` / `src/llm.js` / `src/prompts.js` | 纯工具：分片、流式调用+三级 JSON 恢复、模板严格占位符 |
| bgx666 | `src/policy.js`（除 `frameBlocks` 文案） | 定价/选区间/回放/空闲锁与树的数量无关 |
| bgx666 | `src/status.js` 的 CLI 展示骨架 | 加一列 `tower_id` 即可 |
| bgx666 | `tests/policy.test.js`、`tests/client.test.js` 的离线测法 | `new Function` 剥 import（async.test.js:26-31）、以页面加载器真实形态求值 client（client.test.js:15-37）——**多树版应照抄这套"不需要 Harness 也能测"的思路** |
| bgx666 | `client.js` 的槽位接管 + DOM 折叠 + keep 边界机制 | :1719-1812 注册协议、:776-872 折叠、:699-726 keep 拉取；只需改"最新卡"判据与解析正则 |
| qinghuaju | `src/dsh/inject.mjs` | 注入消息的 source 语义、`insertRecallMessage`、去重守卫、`isCapturable` 过滤（这正是"分总层注入"的落点） |
| qinghuaju | `src/dsh/capture.mjs` | 缓冲/合流/串行 flush/失败不回流 |
| qinghuaju | `src/engine/space.mjs` | `project:<root>` / `global` 的空间键解析，可改造成 `tower_id` 解析器 |
| qinghuaju | `src/dsh/host-client.mjs` + `engine-host.mjs` | 若"流动塔"要做 SQLite+embedding，直接抄"引擎移出宿主 + 重启退避 + 300ms 硬超时退出" |

### 6.2 必须重写/大改

| 文件 | 改动性质 |
| --- | --- |
| bgx666 `index.js` | 挂载层重写：`active` → **按 tower 的注册表 + 单入口分发**；`_jobs/_skipUntil` 键加 tower；prompt 段改为"路由视图（树清单 + 画像 + 预算）+ 树内规则"两级；4 条路由加 tower 维度 |
| bgx666 `src/store.js` | schema 重写：`tower_id` 进主键与全部索引，或每树一库 + 注册表；`#nextId/#counters`、`roots/stats/children/activeAtLevel`、`keeps`、`session_prefs`、`moveSession` 全部重写语义（moveSession 应从"整棵搬迁"变成"跨树迁移/合并"） |
| bgx666 `src/engine.js` | `compactIntoTree` 需接受 tower 分区，并在 `mergeUp` 上层增加"树尖 → 分总层"的合并/画像生成（当前只有树内 mergeUp） |
| bgx666 `src/text.js` | `renderNodeBlocks` 改为"多树渲染"：分总层头 + 每树一节；`isCheckpoint` 的 `[记忆树]` 单标记要扩成带版本/树清单的标记 |
| bgx666 `src/tool.js` | schema 改 `{tower_id?, node_id?}`（或分两个工具：`list_flow_towers` + `explore_flow_tree`）；`describe` 增加跨树下钻与"树尖→分总层"路径 |
| bgx666 `client.js` | `parseSummary`/`HEAD`/`useLatestCard`/`foldSiblings` 全部要按"多树 + 分总层路由视图"重设计；是否仍只渲染一张卡要重新决策 |
| bgx666 `prompts/compress/*` | leaf/parent 的字段契约可留；`skeleton` 要加 `tower_id` 或树内定位；系统提示词（index.js:52-87）必须重写为"多树 + 路由"版本 |
| qinghuaju `src/dsh/tools.mjs` | 工具集要改成"树管理"语义（建树/合并树/列树/选树），不是 `mem_store/mem_recall` |
| qinghuaju `src/engine/store.mjs` | 若要 embedding/软边，可复用；否则只抄它的 `spaces` 分区 schema 形状 |

**【判断】** 最省力的第一版路径是：**读 bgx666 的 `store/text/engine` 做单树底座，抄 qinghuaju 的 `space.mjs/inject.mjs` 做多空间与注入，自己写"分总层"这一层（两插件都没有）**。两插件都没有的东西有 3 个：树间路由、跨树总述、树的生命周期管理（新建/归档/合并）——这正是我们真正要设计的东西。

---

## 7. 事实边界

1. 本文件所有结论来自**静态阅读**：未运行任何插件、未执行她的测试、未打开任何 SQLite。凡"行为上会怎样"的句子都已标【判断】。
2. 只读了两处 `src` 之外：`docs/` 与 `README`（作为作者自述，属二手证据，与源码冲突时以源码为准）。`src/engine/{engine,recall,config,embed}.mjs`、`scripts/*`、`eval/*` **未逐行读**；`presentation/`、`market/*.html` 未读。
3. `00-精读笔记` 第 4.1 节的常量（1000/9/3/8、30000/12、500000/30）经本次复核**全部准确**，出处 index.js:103-132；但 `index.js:316` 注释（"8 nodes…4 merged"）与 `README.md:318`（"8/4 合并"）仍是旧值，`tests/async.test.js:209`（`mergeThreshold:8, branch:4`）同样过时——以 Config 默认值为准。
4. `README.md:327` 称 smoke 测试"9 例"，实际 `tests/smoke.test.js` 有 10 处 `await test(`（:71, :81, :96, :117, :151, :197, :216, :239, :265, :296），又是一处文档漂移。
5. bgx666 的 `src/text.js` 实际 216 行（`00-精读笔记` 记 213）、`client.js` 1827 行（记 1826）：不同快照，引用行号请以本文件为准。
6. CoMeT 的"lossless"与 benchmark 数字为**厂商自报**（README:119-129），且 PyPI 元数据 `home_page/project_urls` 均为 null、分类为 Alpha——与 `00-精读笔记` §4.3 一致，未独立复现。
7. qinghuaju 的 `docs/*` 自述性能（30k 节点召回 p50 191ms 等，ARCHITECTURE.md:198-208）为作者本机 fake embedder 实测，不可外推。

# Context Flow Tower（上下文流动塔）

> 当前版本 **0.66.4** · DeepSeek Harness **>=0.2.2-rc.3 <0.3.0** · 发布包名 **`flow-tower-context`** · **MIT**
>
> 中文 · [English](README.en.md) · [安装](docs/INSTALL.md) · [兼容性](docs/COMPATIBILITY.md) · [发布指南](docs/PUBLISHING.md) · [项目总览](../../README.md) · [论文（Word）](../../paper/FlowTower-压缩驱动的项目级上下文记忆系统.docx) · [设计文档](../../design/flow-tower/)

## 1. 这是什么

一个**观察式、自动化、项目本地**的上下文记忆插件：观察 DSH 的 `compaction/summary` 事件，把压缩摘要的增量**确定性编译**成可检索、可逐字回溯的项目词典，并在模型上下文里**按需注入**长程项目全貌。它不重造宿主的压缩事务，只在压缩之上补一层“可检索的长期记忆”。

- **压缩驱动编译**：以压缩事件为唯一写入锚点，零 LLM 调用、无写放大；
- **十类词条**：file / api-symbol / feature / decision / task / command / error / topic / chapter / person；
- **可逐字回放**：每条词条带 `seq` 引文，`dict_cite` 回放原始消息，而不是摘要；
- **类型化关系**：parent / derivedFrom / cites / replaces / mergedFrom / sibling / relatedTo / taskContext；
- **双注入策略**：`auto` 在 dual / dual-lite / long-only / short-only 间按任务类型、checkpoint 新鲜度与上下文压力自适应；
- **多 agent 共享**：无自有词典卷的子代理/新会话读取项目级共享 digest，并跨卷聚合 open task；
- **项目本地存储**：单文件 SQLite（WAL + 项目写锁），默认 `<项目>/.flow-tower/flow_tower.db`；
- **认证优先**：面板页面、检索/引文 API 与设置写入全部经过 DSH Connection 准入；未认证请求返回 401/403，Connection 服务不可用时 fail-closed（503），不会匿名暴露项目记忆。

## 2. 快速开始

### 2.1 环境要求

- DeepSeek Harness **0.2.2-rc.3**（Desktop 或 web profile 均可）；
- 无需外部服务；可选 embedding 与 DeepSeek smart rerank 默认关闭。

### 2.2 安装

发布后（npm / 插件市场）：

```powershell
# 方式 A：插件市场（推荐）
#   插件 → 实验性插件 → 开启 Custom plugin indexes
#   插件 → 发现 → 添加索引源：
#   https://cdn.jsdelivr.net/npm/flow-tower-context/market/index.json
#   搜索 “Flow Tower Context” → 安装 → 重启 DSH

# 方式 B：直接安装 npm 包
plugin_manager install_bundle target=flow-tower-context@0.66.4
```

开发/未发布时（当前仓库形态）：

```powershell
# 方式 A：DSH 界面 Settings → Plugins → Add plugin，选择本目录 plugin/flow-tower
# 方式 B：先构建发布包，再安装构建目录
npm run build:publish        # 生成 dist/flow-tower-context
plugin_manager install_bundle target=<repo>\dist\flow-tower-context
```

要求：DSH `>=0.2.2-rc.3 <0.3.0`；安装后需重启 DSH 才会加载新的 JS 模块代次。详细步骤、验证与卸载见 [docs/INSTALL.md](docs/INSTALL.md)，兼容性见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

### 2.3 会话预设层接管压缩（可选但推荐）

DSH 的插件补丁只作用于宿主平面，会话的压缩服务由 preset 的 isolate 组装配。发布版的 bundle 会注册一个 agent 预设 **Flow Tower (compaction memory)**：它镜像官方 `cordis` 预设，只把压缩组里的 `compaction-basic` 换成 `flow-tower-context/compaction`（`FlowTowerCompactionEngine` 继承宿主 `BasicCompactionEngine`，只重写 `summarize()`，其余触发/区间/事务/裁剪全部保留）。

新建会话时选择该预设即可让项目记忆进入压缩请求；不选则插件以“观察 + 注入 + 工具/面板”模式工作。预设插件列表是官方 `cordis` 预设的快照，DSH 升级后需按 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) 重新生成。

### 2.4 安装后验证

```powershell
# 状态接口（端口以 GUI URL 为准；注意路由前缀是 /flow-tower）
Invoke-RestMethod http://127.0.0.1:<port>/flow-tower/api/status | ConvertTo-Json -Depth 5
```

关键字段：`version`、`compactionBackend`、`lastSummarize.memoryChars`、`lastInjection.mode`、`compactionDiagnostics.sessionEngineVerified`。若接管成功，`memoryChars > 0` 且 `sessionEngineVerified = true`。面板：插件 → Flow Tower（词典 / 时间线 / 关系图 / 任务 / 设置）。

## 3. 核心机制

### 3.1 压缩驱动编译

观察 `session/event` 上的 `compaction/start|summary|end`，从 `compaction/summary` 的 `shadowedSeqs` 区间读取原始消息与摘要，抽取词条、关系与引文；再按 delta 做增量更新、去重、归档与维护清理（被引用的摘要噪声归档、模块归属补齐）。编译是确定性的，时间与 delta 规模成正比。

### 3.2 双注入策略

压缩之后上下文里同时存在两类信息源：短程 `<compacted-summary>` checkpoint（权威、精确）与长程 digest/项目地图（全貌、索引）。默认按三个信号选择模式：

| 模式 | 注入内容 | 触发（`injectionMode: auto`） | 预算系数 |
| --- | --- | --- | --- |
| `long-only` | 完整 digest / 地图 | 上下文中无 checkpoint | 1.0 |
| `dual-lite` | 只给目标/未完成任务/模块/遍历指引，去掉近期段落 | checkpoint 新鲜（≤2 轮）且任务为 coding/research/history | 0.6 |
| `dual` | 完整 digest | planning 任务；或 checkpoint 已陈旧（>2 轮） | 1.0 |
| `short-only` | 不注入，仅用原生 checkpoint | 普通对话且 checkpoint 新鲜；或压力比 ≥0.85 | 0 |

预算按压力自适应（基 2000 token，0.55/0.7/0.85 三档缩放，下限 400），注入头带机器可读标记，例如：
`[flow-tower] Project map · 项目 · 10 open / 20 done · inject: dual · short: checkpoint 1t ago · task: coding`

**注入预算按压缩周期计算**（v0.66.3）：压缩会替换掉旧的持久化注入消息，因此每次压缩完成时重置每卷计数，长会话不会在 40 次后静默停止注入。

### 3.3 检索

- 默认 `hybrid`：词法（CJK bigram + ASCII + 路径分段，headword ×2、alias ×3、双语同义词扩展）优先，稀疏语义补位，避免纯融合把正确命中挤出前列；
- `/api/search` 与 `dict_search` 支持 `mode`（hybrid/lexical/semantic）、`kind`、`module`、`status`、`since/until`、`sort`；
- 面板“智能重排”可选调用 DeepSeek 做查询改写 + 候选重排（结果缓存 10 分钟）；embedding 路径可选、默认关闭。

### 3.4 存储与证据链

- 项目本地 SQLite：词条、关系、引文、摘要树、分组、指标、注入游标；
- 运行日志 `compaction-runs.jsonl`（引擎行含 `memoryChars/injectedMessages`，事件行含 `compactionId`），引擎诊断日志 `$DSH_HOME/flow-tower/compaction-engine-debug.log`；
- 状态接口合并两行证据，并提供 `compactionDiagnostics`（引擎日志摘要、`sessionEngineVerified`）。

## 4. 配置默认值（节选）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `storageMode` | `project` | 可选 `global` / `custom` |
| `maxEntries` | `6000` | 单卷容量，滚动淘汰 |
| `digestMode` | `on-change` | 词典版本变化才注入 |
| `digestStrategy` | `brief` | 大项目自动切项目地图 |
| `injectionMode` | `auto` | 可选 `dual` / `off` |
| `digestBudgetTokens` | `2000` | 再按压力缩放 |
| `summaryMemoryChars` | `1800` | 注入压缩请求的项目记忆上限 |
| `mapThresholdEntries` | `200` | 达到后 brief 切换为模块塔图 |
| `relationsMode` | `on` | 类型化关系 |
| `llmCompiler` | `off` | 可选 `shadow` / `on`（提案需 seq 引用校验） |
| `proposalMode` | `off` | LLM 提案管线 |

完整配置与三层策略（bundle 默认 → `$DSH_HOME/flow-tower/settings.json` → `<项目>/.flow-tower/settings.json`）见 [docs/injection-policy.md](docs/injection-policy.md) 与面板设置页。

## 5. 工具与面板

模型侧 6 个工具：`dict_browse`、`dict_lookup`、`dict_cite`、`dict_timeline`、`dict_search`、`dict_relate`（`llmCompiler != off` 时另有 `dict_shadow_probe`）。只读面板含 Browse / Tree / Timeline / Tasks / Graph / Settings；HTTP 接口 `/flow-tower/api/*` 只读；另有 `tools/mcp-server.mjs`（stdio JSON-RPC）可选。

## 6. 评测与测试

```powershell
cd plugin/flow-tower
npm test                  # 85/85 单测 + module-graph --check（68 模块 / 0 循环）
npm run eval:search       # 检索召回：lexical/hybrid Recall@5 = 0.94，sparse semantic 0.66
npm run eval:cost         # 上下文成本：工具输出 525.9 万字符、裁剪上限 ≈315k token、注入平均 767 token
node eval/txt-corpus-eval.mjs --file=<语料.txt>   # 长文本压测（《凡人修仙传》全本 8.44M 字符 → 2,846 词条、保真 100%）
```

其他评测脚本：`eval/offline-eval.mjs`、`eval/real-session-eval.mjs`、`eval/long-session-eval.mjs`、`eval/relations-bench.mjs`、`eval/ci.mjs`。论文中的数字来自真实开发会话（8 次压缩、3881 词条、23676 条活跃关系）与上述离线评测。

发布相关：

```powershell
npm run build:publish          # 生成 dist/flow-tower-context（公开包名、LICENSE、bundle patch、索引、DETAIL）
npm run publish:check          # 发布前检查（包名/引擎/本地化/市场索引/绝对路径）
npm run publish:check:strict   # 连同 Anseya 占位符一起严格检查
```

## 7. 已知边界

- 语义召回弱：默认靠词法 + 同义词 + 稀疏语义，跨语言与同义改写有限；需要可选 smart rerank 或 embedding；
- 不压缩就不编纂：纯短会话不产生记忆；
- 任务/决策抽取是启发式，可能存在长句/碎片，靠质量门槛、维护清理与 cite 回放兜底；
- 单写者（文件锁 + WAL），不做多主合并；
- 预设层覆盖是静态快照，DSH 升级后需重新生成；
- 工程债：`store.js`、`client.js`、`web-page-script.js` 有 LOC 豁免；尚无浏览器端自动化测试。

## 8. 项目链接、论文与许可证

- 项目总览（中英双语）：[../../README.md](../../README.md)
- 论文（Word，不署名）：[../../paper/FlowTower-压缩驱动的项目级上下文记忆系统.docx](../../paper/FlowTower-压缩驱动的项目级上下文记忆系统.docx)
- 设计文档（21 篇）：[../../design/flow-tower/](../../design/flow-tower/)
- 发布包名：**`flow-tower-context`**；代码仓库（公开地址，发布前占位）：`https://github.com/Anseya/flow-tower-context`
- 插件市场索引（发布后）：`https://cdn.jsdelivr.net/npm/flow-tower-context/market/index.json`
- 安装 / 兼容性 / 发布：[docs/INSTALL.md](docs/INSTALL.md) · [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) · [docs/PUBLISHING.md](docs/PUBLISHING.md)
- DSH 官方站点：<https://www.deepseek.com/harness/>
- 许可证：**MIT**（见仓库根目录 [LICENSE](../../LICENSE)）

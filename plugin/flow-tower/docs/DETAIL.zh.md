# Flow Tower 上下文记忆

面向 DeepSeek Harness（DSH）的压缩驱动项目级上下文记忆插件。

Flow Tower 观察宿主的 `compaction/summary` 事件，把每次压缩的摘要增量**确定性编译**为项目本地词典：十类词条、类型化关系、可逐字回放的 seq 引文与三层摘要树。随后以「短程 checkpoint + 长程 digest」双注入策略，根据任务类型、checkpoint 新鲜度与上下文压力，在 dual / dual-lite / long-only / short-only 四种模式间自适应。

## 功能

- **压缩驱动编译**：压缩事件是唯一写入锚点，确定性编译、不额外调用 LLM；
- **可检索**：6 个 `dict_*` 工具 + 只读面板；默认 hybrid 检索，支持 kind/module/status/时间过滤与可选 DeepSeek 智能重排；
- **可回溯**：每条词条带 seq 引文，`dict_cite` 回放原始消息；
- **自适应注入**：注入头带机器可读标记（`inject: dual-lite · short: checkpoint 1t ago · task: coding`）；
- **多 agent 共享**：无自有词典卷的子代理/新会话读取项目级共享 digest，并跨卷聚合未完成任务；
- **项目本地存储**：每个项目一个 SQLite 文件（WAL + 项目写锁），可切换全局/自定义路径。

## 压缩接管（可选预设）

安装 bundle 后会注册一个名为 **Flow Tower (compaction memory)** 的 agent 预设：它镜像官方 `cordis` 预设，但把压缩 provider 换成 Flow Tower，使项目记忆进入压缩请求本身；新建会话时选择该预设即可。不选预设时插件仍以“观察 + 注入”模式工作。

由于预设声明是官方预设插件列表的快照，DSH 升级后可能需要重新生成，详见 `docs/COMPATIBILITY.md`。

## 安装

见包的 `docs/INSTALL.md`（或仓库 README）：Discover 索引安装、npm 安装、本地开发安装，以及验证与卸载步骤。

## 配置要点

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `storageMode` | `project` | 可选 `global` / `custom` |
| `maxEntries` | `6000` | 单卷容量，滚动淘汰 |
| `injectionMode` | `auto` | 可选 `dual` / `off` |
| `digestBudgetTokens` | `2000` | 自适应预算基数，按压力缩放 |
| `summaryMemoryChars` | `1800` | 注入压缩请求的项目记忆上限 |
| `llmCompiler` | `off` | 可选 `shadow` / `on` 提案管线 |

## 评测（仓库内）

85/85 单元/集成测试、68 模块 0 循环、离线检索 Recall@5 0.94、单次长程注入 694–829 token；真实 `/compact` 接管注入 1799 字符项目记忆。论文记录了设计、8 类工程问题与长文本语料压测。

## 已知边界

- 语义召回以词法为主；同义改写/跨语言需要可选 smart rerank 或 embedding；
- 不压缩就不编纂：从不压缩的短会话不产生词条；
- 任务/决策抽取是启发式，精度依赖引文回放与检索兜底；
- 单写者存储，不做多主合并；
- 压缩预设是 DSH cordis 预设的静态快照。

## 链接

- 代码仓库：https://github.com/Anseya/flow-tower-context
- 论文（Word）：仓库内 `paper/FlowTower-压缩驱动的项目级上下文记忆系统.docx`
- 许可证：MIT

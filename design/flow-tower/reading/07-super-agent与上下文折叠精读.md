# 07 · Super-agent 与上下文折叠（CarryOn）精读

> 日期：2026-11-15
> 资料：`papers/super-agent/`（原型文档 7 份 + Cordis 论文 PDF）、`papers/context-folding/`（CarryOn HTML/PDF/txt）。
> 标注：【原文】= 本地文件可核（行号）；【二手】= 新闻报道/转述，未在本地文件核实。

---

## 1 Super-agent 原型（dsh-superagent-prototype，MIT 研究原型）

### 1.1 领域模型（`docs_001-domain.md`）

【原文】核心域对象：`Source → Trigger → Thread → Ticket → Eval`，加上 `Mandate`（授权）与 `Subscription`（订阅）。

- Source 产生 Trigger；Trigger 属于 Thread，并**扇出为上下文**给订阅该 Thread 的 Ticket（`docs_001-domain.md:7,29,37`）。
- **Correlation 只增加上下文，从不负责路由**（`docs_001-domain.md:30,55`）。
- Subscription 是 Ticket ↔ Thread 的多对多关系，由 Thread 持有；匹配的 Trigger 扇出给所有存活订阅 Ticket，**不检查发送者**（`:37`）。
- 每个 Thread 同一时刻只跑一个 Eval，期间到达的 Trigger 合并进下一批（`:43,93`）。
- Ticket 状态**独立于 Session**：可被移交、恢复、由多个 Executor 执行（`:56`）。
- 两个角色会话：Main Session（orchestrator，评估/派发/回复）与 Executor Session（worker，每 Ticket 一个 + 一个目录）（`:80-81`、`docs_003-execution.md:25`）。

**对我们的对应**：我们的"项目字典 + digest"本质上就是**上下文订阅**——会话订阅项目记忆；差异是我们没有"主动扇出/多任务调度"，只做被动索引。

### 1.2 授权与上下文投递（`docs_002-authorization.md`）

【原文】订阅 Thread 的消息会作为上下文到达 Ticket，**绕过准入门但授予零新权限**（`:20`）；Executor 也可"仅为上下文"订阅相关 Thread（`:40-42`）；是否有人类参与由 `waitsForPerson` 判定（`docs_007-architecture.md:121`）。

**对我们的对应**：我们的 A6 公理（记忆内容是不可信上下文、不是指令）与它同构；可以把"上下文投递不授予权限"写进我们的 README/工具返回。

### 1.3 执行与恢复（`docs_003-execution.md`、`docs_007-architecture.md`）

- `worker-<ticket id>` 会话 + Ticket 短名目录，位于 execution root 下（`docs_003-execution.md:25`）。
- Effects 出站队列重试：2 秒起、翻倍到 60 秒（`docs_007-architecture.md:177-178`）。
- `Sessions` 统一管理两个角色的 DSH Session，并注册提示词/工具（`:235`）。
- `HealthBoard` 健康条目，一个组件只能认领一次（`:269`）。
- 模型面工具（main Session）：`orchestrator_eval` / `orchestrator_eval_read` / `orchestrator_eval_decide` 等（`:213`）。
- 架构原则：**显式、窄依赖**（每个类只拿到它用的接口，`Pick` 类型）（`:257`）。

### 1.4 设计与实验数字（【二手】，新闻/厂商报道，未本地核实）

- 双层 Router/Worker、事件驱动、异步 ReAct（`start()/stop()` 全双工）、多信道（IM 回复 ≤100 词）、存算分离、外部 Watchdog。
- 50% 任务 12.4 分钟完成、95% 任务 15.7 分钟（对比单 Session p95 29.5 分钟）；Router 批处理让单决定推理时间 6.4s → 1.6s；去掉订阅直通后 Router 决定数 +30%、读缓存 token 23.23M → 31.77M。
- **启示**：系统级调度能提升完成时间，但**代价是更多 token/缓存**；任何"上下文 agent 化"都必须先算这笔账。

### 1.5 Cordis 论文（arXiv:2608.25512）

【摘要】把经典 effect/coeffect 提升为运行时机制：
- **时间可组合**：每个上下文变换都携带逆操作（可完全回退组件副作用）；
- **空间可组合**：每次上下文变化按组件的 coeffect 规格分类，驱动组件的激活/失活；
- 两者统一为单一 context 类型，所有 effect/coeffect 都经它中介，形成"context 范式"；由此得到动态组合演算，并在 Cordis 中实现（effect tracking + coeffect resolution + 声明式 loader/配置协调/HMR）。

**对我们的意义**：DSH 插件"注册即可见、卸载即回滚"的机制有正式理论基础；我们的 `ctx.effect` 清理、legend/digest 注入都是"可逆上下文变换"，应继续走这套语义（不要用不可逆的全局副作用）。

---

## 2 CarryOn：上下文折叠（arXiv:2610.18784）

### 2.1 问题与主张

【原文】长任务 agent 把进展存在持久任务状态里，却**反复重放"这些进展是怎么来的"交互历史**；于是问：能否在进展可复用时退役历史、只留可复用对象？（`CarryOn...txt:252-285`）

### 2.2 上下文视图三件套（`:323,331`）

| 组件 | 内容 |
| --- | --- |
| **Continuation Carriers** | 可复用任务对象：稳定 ID + 内容/位置 + 复用条件 + 版本；分**外部对象**（代码文件、文档、表格等环境中可重开的产物）与**信息产物**（综合结论、排障结论等） |
| **Execution Context** | 当前焦点、未解决约束与义务（obligations）、下一步（`:365`） |
| **Live Tail** | 最近一次 fold 之后的原始交互，未折叠前直接可用（`:369`） |

### 2.3 Fold 事务（`:389,413,423,434,438-445`）

1. Compiler 接收输入包（候选对象 + 相关历史 carrier 记录 + 证据 + 当前 execution context）；
2. 只为候选对象提出编辑，每条编辑**必须绑定授权证据**；execution context 则对整条 live tail 修订；
3. **先校验后提交**：校验失败 → 现有 context view 与 live tail 完全不变；通过 → 原子应用 carrier 编辑 + 提交 execution context；
4. fold 把被覆盖的交互历史替换为对象化上下文视图。

### 2.4 实验（`:289,557-565,629,729`）

OSWorld 2.0：Claude Opus 4.7 partial 43.9% → 49.7%（+5.8%），binary 15.7% → 19.4%，**同时降低总 token 用量**；对比多种压缩/剪枝/摘要/检索方法（Table 4 含 post-fold text length 指标）。

### 2.5 与我们的关系

| CarryOn 概念 | 我们的对应 | 差异 |
| --- | --- | --- |
| Continuation carriers | 我们的词条（file/feature/decision/task/chapter/person）+ 引文 seq | 我们有引用句柄、无"版本/复用条件" |
| Execution context（focus/obligations/next step） | digest 里的 Project / Open tasks / Recent modules | **缺 current focus 与 next step** |
| Live tail | 宿主 session log 未压缩部分 | 宿主天然提供 |
| Validated fold（拒绝则不变） | 编译事务 + 确定性校验（idempotent run、引文存在） | **缺"语义是否被证据支持"的校验层** |
| Compiler agent | 我们目前是确定性抽取（零 LLM） | 这正是"要不要加 agent"的核心问题 |

---

## 3 两个工作的共同设计原则（可直接吸收）

1. **上下文是系统职责，不是人的职责**（Super-agent）：会话调度/上下文同步/任务进度都应系统化。
2. **订阅式上下文扇出**：新信息按订阅关系投递，且**投递不授予权限**；correlation 只加信息、不路由。
3. **对象化上下文 + 活尾**（CarryOn）：历史退役，留"可复用对象 + 指引性上下文"；原始交互只在活尾里。
4. **先校验后提交、拒绝即无变化**：所有上下文变更走校验事务。
5. **注意力预算**：常驻只放指向性信息（≤100 词/≤400 tok），少打扰。
6. **代价意识**：Super-agent 的缓存/决定成本数据说明，agent 化不是免费的。

---

## 4 事实边界

- Super-agent 的性能数字来自【二手】报道，未在本地原型文档核实；本地文档是**参考实现文档**，与设计长文不完全一致（README 自述"adapted for publication"）。
- 原型 README 声明：研究代码、非官方产品、与内部版本/设计长文不同。
- CarryOn 的 benchmark 为论文自报，未复现；其与我们的可比性有限（OSWorld 桌面任务 vs 项目上下文记忆）。
- Cordis 论文 92 页，本次只核到摘要级；未逐章精读（PDF 已归档）。

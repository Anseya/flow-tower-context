# 上下文流动塔 · 多 agent 上下文处理评估（要不要加 agent、怎么加）

> 日期：2026-11-15
> 依据：`papers/super-agent/`（dsh-superagent 原型文档 + Cordis 论文）、`papers/context-folding/`（CarryOn 论文）、`reading/07-super-agent与上下文折叠精读.md`、本项目 v0.4.0 实现与 `08/09` 文档。
> 问题：上下文处理要不要增几个 agent？

---

## 0 结论

**要，但只加"后台 agent"，不进热路径；数量上先加 2 个（编纂 + 校验），跨塔路由 agent 放第二阶段。**

判断标准不是"agent 越多越智能"，而是三条硬条件：

1. **必须改善可测指标**（引用保真、任务完成度、跨塔命中率）；
2. **失败必须回退确定性结果**（agent 挂了/超预算 → 确定性编纂照常，词典不受影响）；
3. **必须离线/异步 + 硬预算**（不在用户回合的主链路上增加延迟与缓存抖动）。

Super-agent 与 CarryOn 恰好给了正反两面的证据：
- Super-agent 证明"系统接走会话调度与上下文同步"能显著改善完成时间，但代价是 **token/缓存开销上升**（二手数据：去掉订阅直通后 Router 决定 +30%、读缓存 token 23.23M→31.77M）；
- CarryOn 证明"对象化上下文 + 先校验后提交"能在**降低 token 的同时提升任务成功率**（+5.8%），因为每次 fold 都被校验、拒绝则什么都不变。

---

## 1 我们现在的上下文流程与 agent 插槽

```
宿主压缩事件 ──▶ 确定性编纂（现在，零 LLM）
                   │  entries/citations/task status/时间/模块
                   ▼
            项目本地词典库 ◀── 工具（browse/lookup/cite/timeline）
                   │
                   ▼
            digest（≤400 tok，step1/版本变化才注入）──▶ 模型
```

可插入 agent 的位置只有三处，且都不在主链路上：

| 插槽 | 触发 | 是否阻塞会话 | 推荐 |
| --- | --- | --- | --- |
| A. 编纂 Agent | 每次压缩后（异步队列） | 否 | ✅ v1.5a |
| B. 校验 Agent | 编纂结果提交前 | 否（可批量/重试） | ✅ v1.5a（可合并进 A） |
| C. 跨塔路由 Agent | 工具调用找不到词/多项目候选时 | 是（工具内，需超时） | ⚠️ v2，且只在确定性失败时 |
| D. 检索/注入/摘要全交给 agent | 每轮 | 是 | ❌ 不推荐（延迟、成本、缓存不稳） |

---

## 2 三个候选 agent 的具体设计

### 2.1 A. 编纂 Agent（Compiler Agent）——最值得做

**职责**：把确定性抽取覆盖不到的语义信息编成词条，并保持引用可核。

- **输入**：本次压缩 delta 的原始消息（宿主 session log）+ 已有词条摘要（避免重复）+ 项目画像；
- **输出**（严格 JSON）：`{entries:[{kind, headword, gloss, senses?, related?, taskStatus?, citations:[seq...]}]}`，**每条必须有 seq 引用**，无引用的条目直接丢弃；
- **可产出的新种类**：`topic`（主题）、`person`（人物/角色）、`relation`（人物/模块/任务关系）、`decision`/`task` 的语义化表述（把"决定采用 A"改写为可查词条，同时保留原句引用）；
- **预算**：每次压缩 ≤1 次调用、输出 ≤1000 tok、输入 ≤8k tok；超时 30s；
- **落库**：先写 staging（不直接进活动词典）→ 校验（§2.2）→ 通过后原子提交；失败回退确定性结果；
- **参照**：CarryOn 的 Compiler（只对有证据的候选提编辑）+ Super-agent 的 Worker Session（隔离会话、独立目录）。

**为什么值得**：我们 v0.4 的小说实测已暴露上限——章节/人物可以确定性抽，但"情节/人物关系/主题"抽不出来；技术语料里"为什么这么做/约束/背景"也抽不出来。这是 v1.5 唯一能显著提升"可用性"的方向。

### 2.2 B. 校验 Agent（Assessor / Verifier）——先确定性、后语义

**职责**：确保 agent 提案"被证据支持且不越权"，对应 CarryOn 的 validated fold（拒绝则什么都不变）。

- **第一层（确定性，必做，不花 LLM）**：JSON schema、seq 存在且在 delta 内、headword 不超长、无密钥模式、条目不超预算、不与已有词条冲突；
- **第二层（可选 LLM）**：检查"释义是否被引用原文支持"、"是否把猜测写成事实"、"是否把不可信内容当指令"；输出逐条 `accept/reject + reason`；
- **失败策略**：整批拒绝（不部分提交）或只提交通过项；拒绝原因写 metrics，供调 prompt；
- **成本优化**：优先合并进编纂 Agent 的同一调用（self-check + 二次校验），只有高风险批次才单独调用。

**参照**：CarryOn "validation fails → existing context view and live tail remain unchanged"；我们的引文/事务机制已经能承接这个语义。

### 2.3 C. 跨塔路由 Agent（Router Agent）——第二阶段

**职责**：当"词头精确/前缀匹配"失败时，在多个项目库/卷之间选 1–2 个去查。

- **输入**：用户问题 + 各项目库的窄目录（tower_id/画像/词头摘要，≤800 tok）；
- **输出**：`{projects:[...], reason}`；
- **预算**：1 次调用、≤1500 tok、超时 10s；超时/失败 → 回退 `dict_browse` 人工式浏览；
- **参照**：Super-agent Router 的批处理（单决定 6.4s→1.6s）说明路由必须批处理/缓存，否则不划算；
- **前置**：先有"多项目库 + 联合目录"（我们已有）；没有确定性回退前不要上。

### 2.4 明确不做的

- **不做"每轮一个上下文总结 agent"**：它会让 digest 每轮变化，直接打爆前缀缓存（我们已经有"版本变化才注入"的教训）。
- **不做"agent 删除记忆"**：不可逆；删除只能由确定性淘汰策略做。
- **不做"多 agent 辩论决定记什么"**：成本不可控，收益无证据。
- **不把检索/读取交给 agent 代理**：`dict_lookup`/`dict_cite` 已经是 2 次调用直达，agent 化只会更慢更贵。

---

## 3 与 Super-agent / CarryOn 概念映射

| 概念（来源） | 我们的对应 | 现状 | 计划 |
| --- | --- | --- | --- |
| Router / Worker 双层（Super-agent） | 确定性 digest 路由 + 后台编纂 agent | 半有 | v1.5a 加 worker（编纂） |
| Thread Subscription 上下文扇出（Super-agent） | 项目词典 + digest 订阅（同项目会话共享） | 有 | 保持确定性；不引入主动 sender 语义 |
| Correlation 只加上下文不路由（Super-agent） | `related` 共现链接 | 有 | 保持 |
| 投递不授予权限（Super-agent 授权） | A6 公理：记忆是不可信上下文 | 有 | 写进工具返回/文档 |
| Execution context：focus/obligations/next step（CarryOn） | digest 的 Project/Open tasks/Recent modules | 部分 | v1.5a 加 **current focus / next step**（可由编纂 agent 填，确定性兜底） |
| Continuation carriers（CarryOn） | 词条 + 引文 | 有 | 加"复用条件/版本"为可选字段 |
| Validated fold（CarryOn） | 编译事务 + 幂等 run + 引文校验 | 部分 | v1.5a 加语义校验层 |
| HealthBoard / Watchdog（Super-agent） | compile metrics + warn 日志 | 部分 | v1.5b 加 health 指标（编译失败率/积压/耗时） |
| 注意力预算（Super-agent 100 词规则） | digest ≤400 tok、step1 注入 | 有 | 保持 |
| 时间/空间可组合（Cordis） | `ctx.effect` 清理、插件注册即可见 | 有 | 继续用可逆 effect，不用全局副作用 |

---

## 4 实施路线（可验收）

| 阶段 | 内容 | 验收标准 | 回退 |
| --- | --- | --- | --- |
| **v1.5a-0** 管线准备 | 编译管线拆成 `deterministic → staging → validate → commit`；metrics 增加 staged/rejected/cost | 现有 28 单测全绿；确定性结果不变 | — |
| **v1.5a-1** 编纂 Agent（默认关） | 配置 `agentCompiler: 'off'/'shadow'/'on'`；shadow = 只写 staging 不提交，用来算收益 | shadow 模式跑真实会话：对比词条增量/可查率，成本 ≤ 1 次/压缩且 ≤2k tok | 关掉即回退确定性 |
| **v1.5a-2** 校验 | 确定性校验必过；高风险批次再语义校验；整批回滚 | 引用保真 100%、拒绝原因可查 | 拒绝即不提交 |
| **v1.5b** execution context | digest 增加 current focus / next step（agent 填、确定性兜底） | digest 仍 ≤400 tok；缓存不变时不重注入 | 关掉回到现状 |
| **v1.5c** 路由 Agent | 仅确定性失败时调用；批处理/缓存 | 跨项目问题命中率提升且 p95 延迟可控 | 超时回退 browse |
| **v2** 跨塔迁移 | 两项目库合并/迁移（带冲突校验） | 迁移后引文可回放 | 保留原库 |

**先决问题**：DSH 插件内如何安全地起"后台 agent"？两条路：
1. 用 DSH 的 subagent 服务（`ctx.get('subagent')` / agent preset 的 worker session），参考 dsh-superagent 原型 `Sessions`/`DshExecutor` 的做法（每 worker 独立 session + 目录）；
2. 若不支持，用 `ctx.llm.stream` 做"单次结构化抽取调用"（不是完整 agent，但成本可控、实现简单）——**建议先用 2 起步，验证收益后再升级为完整 agent**。

---

## 5 成本与风险

| 风险 | 数据/依据 | 对策 |
| --- | --- | --- |
| token/缓存成本上升 | Super-agent：去订阅直通后 Router 决定 +30%、读缓存 token 23.23M→31.77M | shadow 模式先量化；每压缩 ≤1 次；off 默认 |
| 前缀缓存被 agent 改动打散 | 我们已有"版本变化才注入"经验 | agent 只写库，不改 digest/section；digest 仍版本门控 |
| agent 编造/错引 | CarryOn 的校验思想 | 无引用即丢弃；语义校验；整批回滚 |
| 后台任务堆积/崩溃 | Super-agent watchdog/health | 队列上限 + 超时 + metrics + 失败回退 |
| 叙事/人物抽取主观 | 小说实测：人物靠对白署名频次 | 人物仅作候选，低置信度可标注 |
| 插件权限扩大 | agent 会话可能读写项目 | worker session 只给必要工具（只读项目目录+写词条库） |

---

## 6 对"要不要加"的最终建议

- **短期（这一版之后）**：先做 **pipeline 拆分 + shadow 编纂 agent**（默认关），用真实会话量化"值不值得"；这一步不改产品行为，风险最低。
- **中期**：shadow 数据显示词条可查率提升 ≥10–15%、引用保真 100%、每压缩成本可控 → 切 `on`，并加语义校验。
- **长期**：跨塔路由 agent + 跨塔迁移；仍然坚持"确定性优先、agent 兜底"。
- **永远不做**：agent 改写常驻 digest、agent 删除记忆、热路径多 agent。

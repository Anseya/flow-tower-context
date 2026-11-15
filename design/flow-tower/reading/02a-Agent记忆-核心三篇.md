# 02a · Agent 记忆核心三篇精读（MemGPT / APDMem / ConvMem）

> 日期：2026-11-15｜精读员：papers-agent-1｜任务：task-2
> 定位：对 `00-精读笔记.md`（事实层）与 `01-构思对齐.md`（讨论层）做**独立核验 + 面向实现深挖 + 纠错补强**，不复述。
> 标注约定：**无标记 = 原文事实**（附 txt 行号或原文引文）；**【推断】= 我的判断**，不是论文结论；**（00:Lxx）** 指 `00-精读笔记.md` 对应行。

---

## 1. 本次实际读了什么

| 文件 | 行数（read 工具） | 阅读区间 | 方式 |
| --- | --- | --- | --- |
| `papers/tree-memory/extracted/MemGPT_2023_2310.08560.txt` | 1351 | 1–700、701–1351 | 全文通读；另用 grep 复核 `70%/100%/cache/page/heartbeat/function` 命中 |
| `papers/tree-memory/extracted/APDMem_2026_2610.02472.txt` | 1820 | 1–700、701–1400、1401–1820 | 全文通读（含全部附录 prompt、算法、超参表） |
| `papers/tree-memory/extracted/ConvMem_2026_2609.10441.txt` | 2027 | 1–700、701–1400、1401–2027 | 全文通读（含全部附录 prompt、消融、case） |
| `design/flow-tower/00-精读笔记.md` | 125 | 1–125 | 全文 |
| `design/flow-tower/01-构思对齐.md` | 123 | 1–123 | 全文 |
| DSH 宿主（运行时，非文件） | — | — | `cordis_inspect` host Service/Event/Config 目录；精读 `compaction` / `tokenMeter` / `systemPrompt` / `toolResultPruner` 契约与 `agent/pre-step` 事件契约 |

三篇论文的行号引用均指上述 txt 文件。DSH 侧引用的是**运行中 Harness 的服务/事件契约**（查询返回原文），不是源码行号；`app.asar` 未解包，未能读到 `dsh-compaction-basic` 等实现源码（见 §5）。

---

## 2. 机制层拆解

### 2.1 MemGPT：主上下文三段 + 队列管理器 + 自指函数调用

**数据结构（原文）**：主上下文 = `system instructions`（只读静态）+ `working context`（固定大小、只可经函数写）+ `FIFO Queue`（滚动历史，含用户/助手消息、系统告警、函数输入输出）；**FIFO 第 0 位永远是"被驱逐消息的递归摘要"**（L152-171）。外部上下文 = `recall storage`（消息库）+ `archival storage`（任意长度文本库，PostgreSQL+pgvector+HNSW，`text-embedding-ada-002` 余弦检索，L632-649）。
**一处原文自相矛盾**：正文说主上下文是"三个连续段"（L152-155），但图 3 画了四块，多一个 `Output Buffer`（L186-206），正文未定义其行为。

**驱逐算法（据 L214-233 转写）**：

```
if prompt_tokens > warning_token_count:     # 原文举例 "e.g. 70% of the context window"
    insert system msg "Memory Pressure"      # in-band：作为消息进 FIFO，不是隐藏状态位
if prompt_tokens > flush_token_count:       # 原文举例 "e.g. 100%"
    evict N messages                         # 原文 "e.g. 50% of the context window"
    new_recursive_summary = summarize(old_recursive_summary, evicted_messages)
    queue[0] = new_recursive_summary
    evicted_messages -> recall storage       # "stored indefinitely ... readable via function calls"
```

**分页**：检索函数带页码，图例是 `archival_storage.search("nobel physics", page=2)`，返回头 `Showing 10 of 124 results (page 1/13)`（L602-607）；recall 检索返回 `Showing 3 of 3 results (page 1/1)`（L140-143）。→ 页大小 10/3 是示例输出，不是论文声明常量。
**函数调用接口**：论文可见的只有 4 个名字——`working_context.append`（L90,95）、`working_context.replace`（L357-359）、`recall_storage.search`（L145）、`archival_storage.search`（L602）；完整 schema 不在论文："The MemGPT prompts have been edited for brevity. For full implementation details (including exact prompts) visit https://research.memgpt.ai"（L1059-1061）。**因此"MemGPT 的 function call 设计"只能核到语义（自指读写 + 分页 + 错误回灌），核不到精确 schema。**
**控制流**：事件（用户消息/系统消息/用户交互/定时事件）触发推理（L325-336）；函数可带 `request heartbeat=true` 立刻续推理，否则 yield 等下一个外部事件（L341-350）；函数参数解析失败/运行时错误会回灌模型（L255-271）。
**真实超参**：只有 70%/100%/50% 三个 `e.g.` 示例；nested KV 任务 140 对 UUID≈8k token、nesting 0–4（L748-769）。
**失败模式（原文自承/实测）**：① 会"没翻完就停"——`MemGPT will often stop paging through retriever results before exhausting the retriever database`（L735-737）；② 函数调用能力弱的底座会垮——GPT-3.5 版"significantly degraded"（L744-747）；③ 底座越新不一定越好——nested KV 上 `MemGPT with GPT-4 Turbo performs worse than MemGPT with GPT-4`（L676-677）；④ GPT-3.5 在 1 层嵌套即 0%，"primary failure mode is to simply returns the original value"（L773-775）。

### 2.2 APDMem：四层 L0–L3 + 7 action + 有界控制器

**四层精确内容（L220-231，附录 I L1631-1725）**：
| 层 | 原文定义 | 物化时机 |
| --- | --- | --- |
| L0 | 主题摘要：**per-turn** 一句（≤30 词）+ 5–8 关键词 + 3–5 tags；代词消解、相对日期归一，作主索引层 | ingestion（4-turn 滑窗、overlap 1、≤6000 chars/窗） |
| L1 | 个性化关键事实：session 级 bullet，5–25 条（用户信息/推荐/计划/偏好/约束） | 首次 `read_facts` 惰性生成后缓存 |
| L2 | turn 级证据笔记：按 turn 分组的原子事实 bullet（保持时间顺序，禁止合并多条） | 首次 `read_turns` 惰性生成后缓存 |
| L3 | 原文消息（verbatim），按 turn 分组 | ingestion（无 LLM 处理） |

> 注意：L0 不是"会话摘要"，而是**逐 turn 一行 + 关键词**的窗式索引；`00` 第 42 行"叶层留原文"在此对应 L3，L1/L2 是**中间派生层**。

**7 个 action 的精确定义与出处**：动作空间 `A = {search, read_facts, read_turns, read_raw, interpret_dates, decompose, reflect}`（L249-255）。
- `search`：在 L0 上做 hybrid（BM25+stemming 与 dense，RRF 融合）+ keyword boost，返回 top-K session（L293-296；附录 G L1457-1508；超参 top-K=20、RRF k=60、cos 权重 0.5、boost 0.1）。
- `read_facts`：取候选 session 的 L1（"auto-drill step selects the most promising unexplored sessions"）。
- `read_turns`：取 L2，按时间序。
- `read_raw`：取 L3，**限制在已选 session 的最相关 turn 内**。
- `interpret_dates`：把相对日期按提问时间戳归一（query preparation）。
- `decompose`：多跳/复合问题拆子查询。
- `reflect`：总结证据集、指缺口、判断是否值得再检索，并产出 1–5 条新查询（prompt 见 L1210-1235）。
**成本-保真序**：`c(L0)<c(L1)<c(L2)<c(L3)`、`f(L0)<…<f(L3)`，控制器解 `min Σc s.t. sufficient(V_T,q)=1`（L261-276）。

**控制器伪代码（Algorithm 1，L1017-1049 原文转写）**：

```
V0 ← ∅ ; nudges ← 0
for t = 1..Tmax:
    response ← LLM(q, d, V_{t-1}, A)
    if response has tool calls:
        V_t ← V_{t-1} ∪ ⋃ EXECUTE(τ)
    else if |V_{t-1}| grew since last reflection and nudges < 2:
        inject nudge message ; nudges++
        V_t ← V_{t-1}
    else:
        a_draft ← response ; return a_draft, V_{t-1}
return a_draft, V_Tmax
```

**收敛与预算**：终止条件 = `reflect` 找不到新证据（`|Vt|=|Vt−1|`）或到 `Tmax`（L317-325）。`Tmax=20`（L373-375、L1190-1202），但实测**中位数只用 5 步**（GPT-4.1；p95=12、p99=17；mini 中位 3；L1391-1408）→ 20 是"最坏成本上界"，不是常态成本。
**控制器 prompt 结构（Fig.7，L1149-1180）**：先列四层语义，再给 7 条策略纪律（相对时间先 `interpret_dates`、复杂先 `decompose`、`search` 用 3–5 个多样查询、对**所有可能相关的 session** 读关键事实、计数类必须 `reflect`、按时间推理、跨 session 去重）+ 一条 CRITICAL（计数题没 reflect 不许给答案）。
**真实超参（Table 5，L1321-1381）**：L0 W=4 turns/overlap 1/≤6000 chars；L1 ≤12000 chars、5–25 bullet、workers=8；embedding Nomic-v1.5 (768d)；RRF k=60；cos w=0.5；top-K=20；keyword boost 0.1；Max ReAct steps=20；auto-drill/search=3；max drill sessions=10；max raw turns=20；max reflection rounds=2；agent temp=0.0。
**代价（00 未记，重要）**：Table 2（L529-558）——离线构建 145.4k token / 101.5s；**在线（cold start，L1/L2 无缓存）124.3k token / 37.7s per question**（GPT-4o-mini 口径）；Table 10（L1587-1591）其他底座在线 86.5k–128.5k、42.7–57.7s。→ "只下钻 8%" 指**会话比例**（3.7/47.7，L578-581），不等于便宜。
**消融（决定抄什么，Table 4 L636-672）**：去掉 `read_raw` 掉 5.9%（最大）、`read_facts` 掉 3.6%、`L2` 仅 0.5%、`reflect` 掉 3.6%、`decompose` 掉 2.1%、`interpret_dates` 仅 0.2%；L3-only 平 RAG 掉 12.3%。Organized Notes 带来 multi-session +6.0、temporal +3.0；草稿答案带来 SS-User +2.9（L1758-1769、L1810-1820）。
**失败模式/自承局限（原文）**：L0 质量门控召回——`retrieval recall depends on the quality of the L0 thematic summaries: if a summary omits a relevant detail, the corresponding turn may receive lower BM25 and dense-retrieval scores`（L790-794）；冷启动——`Lazy materialization of L1 and L2 may introduce cold-start latency when a session is accessed for the first time`（L805-807），缓解是"主动预物化（离线/后台）"而非"缓存"（L807-818）；无跨会话关系——`does not explicitly model cross-session relationships in the way graph-based memory structures can`（L819-824）；广度-深度权衡——multi-session 上 77.4 输给 SimpleMem 81.2（GPT-4.1，L497-506）；错误主因是检索（22.2%→10.6%）而非生成（8–10%），换强控制器 79.8→86.8（L620-635）。

### 2.3 ConvMem：query 条件化的分层卷积 + 残差旁路

**它不是记忆库，是每次 query 重算的计算图**（原文未描述任何持久化；**无跨 query 复用为【推断】**）。核心对象：`W`=单 kernel 上下文长度、`S`=步长（S<W 产生重叠，每 token 被扫 `W/S` 次）、`L`=层数、`C`=通道数（L162-181）。语义 kernel `(h,r)=K_LLM(x,q;p)`，`h` 是压缩摘要，`r∈{0,1,2}` 是离散相关度：0 无关、1 可能相关/背景、2 **含直接证据或答案**（L192-208）。
**原文保真的关键机制（精确）**：
1. 跳连**只在输入层触发**：`During convolution at the input layer, if the kernel assigns a critical score r = 2 to a segment xi, this raw segment will add a skip connection to the final layer`（L279-283）。
2. 缓冲公式：`B ← B ∪ {xi | Score(xi) = 2}`（L282-284）。
3. 末层消费原始片段：`a(c) = LLM(q(c) ⊕ H(L,c) ⊕ B(c))`（L379），再 `A = LLM(Q ⊕ ⊕_c (q(c) ⊕ a(c)))`（L385-393）。
→ 即"未改原文直送末层"成立，但**旁路是一等公民的只有被判定 r=2 的片段**；被误判成 1 的片段只会以摘要形态向上走。

```
segments = slice(D, W=8000, S=1600)        # over-scan = W/S = 5
for each channel c of decompose(Q):        # 文本 Cmax=5，Table 2 写 10（矛盾）
    B_c = []; H_0 = []
    for x in segments: (h,r)=K(x,q_c); H_0.append(h); if r==2: B_c.add(x)
    for l in 1..L: H_l = Conv(H_{l-1}, K_c)
    a_c = LLM(q_c ⊕ H_L ⊕ B_c)
A = LLM(Q ⊕ ⊕_c (q_c ⊕ a_c))
```

**真实超参（L583-589、Table 2 L1255-1282、B.2 L1216-1239）**：W=8000 token、S=1600（5× 过扫）、`L∈[2,3]`（≤128k）/`[3,4]`（1M）、`Cmax`=10（Table 2）**但** B.2 正文写 "flexible upper limit of Cmax = 5 sub-questions"→ **论文自相矛盾**；temperature 0.7、top-p 0.95；vLLM 0.6.0 + PagedAttention + A800；JSON 解析失败时"回退默认 r=1 防信息丢失"。
**消融**：过扫 1×/3×/5×/10× → Sub-EM 64.8/69.5/**77.3**/75.0（5× 最优）；跳连 有/无 = 77.3/65.6；单 kernel 68.0 vs 多 kernel 77.3（L705-762）。
**自承局限（原文）**：① `the total computational cost is higher than that of linear scanning methods`（L899-902）；② `dependency on query decomposition`，分解错则"kernels may operate on incomplete premises"（L902-908）。
**对我方有用的两个失败案例**：sequential 记忆 agent 的"早期看似无关的信息被覆盖、后来需要时不可恢复"（L1422-1432）；RL agent 对 benchmark 标签过拟合、宁可输出记住的错标签也不读上下文（Case 3，L1533-1545）——后者说明"忠实原文"与"指标"会冲突。

---

## 3. 对 `00-精读笔记.md` 的核验

### 3.1 一致（核到原文，无需改）
1. §1 标题核对表三篇一致（MemGPT L1、APDMem L1-2、ConvMem L1）——一致。
2. §2 "原文回溯句柄 … ConvMem 用 residual buffer 的 semantic skip connection 把未改原文直送末层"（00:L42）——一致，机制细节见 §2.3（补上"仅输入层、仅 r=2"两个限定）。
3. §2 "APDMem 四层 L0→L3 + 7 个 action + `Tmax=20`，只下钻 8% haystack"（00:L43）——一致（8%=3.7/47.7 会话；`Tmax` 只在 L373-375）。
4. §3.3 "APDMem 是 ingestion 固定四层 + 按需物化 L1/L2，层数不流动"（00:L72）——一致，建议措辞微调为"层数固定、**物化深度**流动"（L232-237）。
5. §6 第 1 条 APDMem 三段自承引文（00:L110）——均核到（L790-794、L798-800、L819-824）。

### 3.2 更正（原文与 00 有偏差，必须改）
1. **00:L67 的阈值不是硬常量**。原文是 `the 'warning token count' … (e.g. 70% of the context window)`、`the 'flush token count' (e.g. 100% …)`、`evicts a specific count of messages (e.g. 50% …)`（L215-233）。三个数都是 `e.g.` 举例。**建议改为**："MemGPT 用 warning/flush 双阈值 + 驱逐批量，论文举例 70%/100%/50%，未声明为默认配置；精确值只在实现里"。否则 DSH 插件若照抄 70/100/50 会把示例当规格。
2. **00:L114 "APDMem 提到 cold-start latency 并用 L1/L2 缓存缓解"不准确**。缓存只降低**重复访问**成本（L236、L1653）；首访延迟的缓解手段是"主动预物化（offline/background）"（L807-809），且论文明确 lazy 是**刻意选择**、预计算全量可能浪费（L809-818）。建议改为："APDMem 承认 L1/L2 惰性物化有首访延迟；缓存压重复访问，首访靠预物化/预热门会话，属显式成本-延迟权衡"。
3. **00:L110 引文截断导致语义偏重**。原文完整句：`APDMem does not explicitly model cross-session relationships in the way graph-based memory structures can.`（L819-821）。截成 `does not explicitly model cross-session relationships` 会被读成"完全不建跨会话关系"，而原句限定是"不像 graph 那样显式建模"。建议保留后半句。

### 3.3 补强（00 未记、但影响选型/实现）
1. **APDMem 的"8%"是会话比例，不是成本**。在线仍需 124.3k token / 37.7s per question（cold start 口径，Table 2；其他底座 86.5–128.5k / 42.7–57.7s，Table 10）——比离线只省约 15%。"下钻少"≠"便宜"，因为每步都是完整 ReAct 调用。→ 对 DSH 的启示：控制器预算必须显式（Tmax 之外还要加 token 上限）。
2. **`read_raw`（L3 原文）是主力不是兜底**：去掉它掉 5.9%，而 L2 只掉 0.5%（Table 4）。00 把原文层当"保真备份"的设计倾向需要修正为"原文层同时是精度来源"。
3. **APDMem 的 L0 不是会话摘要**，而是 4-turn 滑窗的 per-turn 一行 + 关键词 + tags（L1633-1643）。做塔的"叶层"时不能把"一层摘要"当 L0。
4. **三篇全文都没有讨论 prompt/prefix cache**（grep 实证：MemGPT 仅 L862 把 "caches" 列为未来方向；APDMem 仅 L236/L557/L1653 指 L1/L2 层缓存；ConvMem 仅 L805/L1205 指 KV cache）。→ 00 第 6 节第 3 条"流动会让前缀缓存失效、这是主要工程代价"是**正确的构思推断，但不能写成论文发现**；反过来，MemGPT 把 working context 放在 prompt 前部，**每次写入都改前缀**，可作为"记忆机制天然反缓存"的原始素材。
5. **ConvMem 的"SOTA"只限 training-free**。Table 1 里 RL 训练的 MemAgent 在 in-distribution HotpotQA 上 F1 反而更高（28k：75.55 vs 67.44；896k：68.80 vs 63.09；L505-579），原文措辞也是 `new state-of-the-art among training-free methods`（L594-596）。别把它当性能上界，它值钱的是**保真旁路**与**无训练可并行**。
6. **MemGPT 的完整函数 schema 不在论文**（L1059-1061 自承）。凡是"MemGPT 有 N 个函数/函数长什么样"的说法，在这份 PDF 里都核不到；能核到的只有 4 个调用名与语义。

---

## 4. 面向 DSH 插件的实现映射

> **本节整节是设计判断（【推断】/建议），不是论文事实**；仅引号内文字与"DSH 契约"标注句为运行中契约原文。三篇论文没有一篇讨论如何落到 DSH 宿主上。

### 4.0 总判断【推断】
DSH 已经把 MemGPT 的分层记忆实现了一半，**我们不该重造分页**：
- `session log`（`Session.snapshotEvents/ownEvents`、`CompactionResult.shadowedSeqs`）= MemGPT 的 recall storage（可永久回溯）；
- `SessionSurface.nodes`（`SurfaceOp = 'append' | {op:'replace', startSeq, endSeq}`）= main context；
- `ctx.compaction`（`compactIfNeeded(trigger: 'pressure' | 'context-overflow')`、`compactRegion(start,end)`、"replaces the selected surface span with one summary node"）= queue manager；
- `ctx.tokenMeter.measure()` 返回 `TokenMeasurement {totalTokens, surfaceTokens, nodes:[{seq, tokens, heuristicTokens}]}` = 压力计。
→ **流动塔插件应做"surface 之上的树 + 跨树分总层"**，把驱逐委托给 compaction，把原文句柄委托给 shadowed seqs。

### 4.1 模块 ↔ 机制映射表
| 流动塔部件 | DSH 真实落点（运行中契约） | 论文依据/取舍 |
| --- | --- | --- |
| 压力告警（不用自己驱逐） | `agent/pre-step` waterfall 返回 `PreStepDecision {kind:'enter', messages, startsRequestSeries?}` 注入一条告警消息；阈值用 `ctx.tokenMeter.measure().totalTokens` ÷ contextWindow | MemGPT 的 memory pressure 是 in-band 消息（L214-222）；DSH 的 eviction 已有 `trigger:'pressure'` |
| 树节点元数据 | 每节点存 `{tree_id, node_id, level, parent_id, span:{start_seq,end_seq}, shadowed_seqs, summary, tokens, created_turn, tier, version}` | APDMem 四层（L220-231）+ MemGPT 句柄（`shadowedSeqs`） |
| 叶子原文保真 | 不删原事件；替换节点写 `sourceEventSeqs` 指向被遮蔽 seq；超大原文 `ctx.spillStore.saveText` 换 `SpillRef` | 抄 `toolResultPruner.pruneSession` 的契约原文：替换"cites the shadowed node so replay can recover the replacement input"，并发 `compaction/prune` 影子价格事件 |
| 摘要替换/上浮 | `ctx.compaction.compactRegion(start, end, agent)`；`CompactionResult {summarySeq, shadowedRange, shadowedTokenCount}` 就是新父节点与覆盖范围 | bgx666 `mergeUp` 的 DSH 原生等价物；注意 compaction 契约要求两端 tool-call 配对平衡 |
| 下钻工具 | `ctx.tools.register(ToolDefinition)`；建议 4–5 个：`tree_search / read_facts / read_turns / read_raw / reflect` | APDMem 7 action（L249-255）；`interpret_dates`/`decompose` 不占工具位（消融 ↓0.2/↓2.1，直接让模型推理更划算） |
| 工具 schema 常驻成本 | `ToolSchema.deferLoading?: true`（DSH 契约字段）；`ctx.systemPrompt.tools(provider)` 按装配动态注入 | 【推断】推迟加载可减小常驻前缀；三篇无论文依据 |
| 惰性物化/冷启动 | L1/L2 首次访问生成后落盘缓存（DSH `storageDomain.open`）；预热可挂到 `agent/turn-stopping`（回合将闭、模型不欠回复）或后台 jobs | APDMem lazy + cache（L232-237、L1653）；DSH 有 `turn-stopping` serial 事件 |
| 模型异构 | `agent/request` waterfall 可替换 `LlmCallConfig`（provider/model/reasoningEffort/maxTokens） | APDMem 控制器用强模型、生成用弱模型（Table 3，L593-606） |
| 跨树分总层注册表 | `ctx.agents.list()/roots()` + `sessionProjectionCache.cachedSnapshot` + `storageDomain`；常驻只放 `tower_id｜一句话画像｜时间范围｜下钻代价` | 00/01 的"路由视图极窄"要求；三篇均无跨会话实现（APDMem 自承 L819-824） |
| 手动"现在流动"入口 | `ctx.commands.register` + `ctx.compaction.compactNow` | APDMem 手动 reflect/深层下钻的等价物 |

### 4.2 触发时机（四个钩子，按成本从低到高）
1. **`agent/pre-step`（每 step，最便宜）**：只读 `tokenMeter`，超 warning 阈值时注入 ≤1 条短告警/路由提示；返回 `startsRequestSeries: true` 表示开启新请求序列（缓存 epoch 边界）。
2. **`agent/turn-stopping`（每 turn 末）**：做树维护——上浮/重摘要/判重/冷热分档；必须可回滚，参考 DSH compaction 的 durable marker（`compaction/start` → `compaction/end`，失败留痕）与"单次只允许一个 compaction 进行"的锁语义。
3. **`system-prompt/assemble` waterfall（每次 prompt 组装）**：只做只读拼装（把路由视图插进 runtime context），**禁止在此写库**。
4. **`ctx.compaction.compactNow` / `ctx.commands`**：用户显式触发。

### 4.3 prompt 位置与前缀缓存影响（DSH 证据 + 【推断】分开）
- **DSH 事实**：`ctx.systemPrompt` 有 `section / context / variable / tools` 四类输入；`refreshContext` 契约原文："Sections, tools, and interpolation variables retain the accepted assembly; their providers and waterfall do not rerun. Contexts added only by the assembly waterfall retain their accepted values." → **section/tools/variables 在一次 accepted assembly 内冻结，runtime context 可以每 step 刷新**；任一类注册变更会发 `system-prompt/change`。`TokenUsage` 带 `cacheReadTokens/cacheWriteTokens`；`request/header` 事件带 `startsSeries?: true` 与 `reason: 'initial'|'resume'|'change'|'series'`。
- **落点建议**：塔尖"路由视图"放 **`ctx.systemPrompt.context`**（不是 section）；文本按 `tree_id` 字典序稳定排序、不按活跃度排序（活跃度每 turn 变 = 每次重排 = 前缀失效）。【推断】
- **变长文本（新叶摘要、证据片段）放尾部**：通过 `agent/pre-step` 的 `messages` 注入到当前 step，而不是塞 system 前缀；结构变更（上浮/合并/剪枝）只在 `startsRequestSeries` / 新 series 起点做，并设"静默期"。【推断】
- **代价必须自测**：三篇论文都无 prompt cache 数据（§3.3 第 4 条），只能用 `cacheWriteTokens/cacheReadTokens` 实测"每次流动的缓存代价"。【推断】

### 4.4 建议的插件设计约束（每条附依据）
1. **只包装不替换 `ctx.compaction`**：DSH 契约写明 "Load one implementation per context as `ctx.compaction`"，与 bgx666 冲突时用 `ctx.get('compaction')`（optional access）包一层分发，别抢注册。
2. **原文永不删**：所有摘要替换都带 `sourceEventSeqs/shadowedSeqs` 并写版本号；照抄 `toolResultPruner` 的替换+影子定价模式。
3. **阈值分两层**：warning（≈70% 量级，示例值先做成可配）只在 `pre-step` 提示；驱逐交给 compaction 的 `'pressure'`/`'context-overflow'`，不自建 overflow 判定。
4. **工具 ≤5 个且尽量 `deferLoading`**；`read_raw` 必留（消融最大，−5.9%）。
5. **控制器预算显式**：`Tmax`（起步 8–10，不必 20；APDMem 中位 5）+ 每 query token 上限 + 每 turn 总预算；APDMem 在线 124k/38s 是**冷启动下限口径**，不能当上限。
6. **L1/L2 惰性 + 后台预热**，并提供"首访降级"（直接给 L0/L3 摘要，不阻塞回答）。
7. **分总层只读**：总述视图异步生成、带版本号、不参与路由决策（01 §8.2 硬规矩）；路由视图按 `tree_id` 稳定排序。
8. **流动只在 series/turn 边界**，记录每次流动的 token 与 cache 代价，作为下一轮静默期参数。

---

## 5. 事实边界

1. 三篇均为预印本（MemGPT arXiv v2 = 2024-02-12，L87；APDMem 2026-10-01，L95；ConvMem 2026-09-09，L92），所有 benchmark 数字均**作者自报**，未独立复现；不作为选型唯一依据。
2. **MemGPT 的阈值是示例**：70%/100%/50% 三处均带 `e.g.`（L215-233），论文未给默认配置；**完整 function schema 不在论文**（L1059-1061）。
3. **APDMem 的 124.3k/37.7s 是 cold-start、GPT-4o-mini、LongMemEval-S 口径**（Table 2 标题 L555-558；Table 10 其他底座不同）；跨任务不可外推。
4. **ConvMem 内部矛盾**：`Cmax` 在 B.2 正文为 5（L1229-1231）、Table 2 为 10（L1272-1273）；复现须以代码为准（本地无代码）。
5. **三篇都没有 prompt/prefix cache 讨论**（grep 证据见 §3.3-4）；"流动破坏前缀缓存"是推断，不是论文结论。
6. **DSH 侧**：`app.asar` 未解包，`dsh-compaction-basic` / `dsh-token-meter` / `dsh-system-prompt` 的**源码与默认阈值未核**；本文 DSH 契约全部来自运行中 `cordis_inspect`（Service/Event/Config 目录的签名与描述原文）。**未核**：真实 DeepSeek prompt cache 命中行为、`ToolSchema.deferLoading` 的确切语义（只知道字段存在）、`developer/message` 的模型可见性与注入方式、`ctx.get('compaction')` 是否能安全包装既有实现。
7. **未读**：三篇的引用文献（除被正文直接引用的机制外）未回原文；APDMem/ConvMem 的 PDF 版式与 txt 抽取是否有错行未逐页比对（个别表格列在 txt 中粘连，如 APDMem Table 1 列名与数值行错位，本文只使用正文明确给出的分类数字）。
8. 文中的【推断】标记共 5 处（§4.0、§4.1 `deferLoading` 行、§4.3 三条），另 §4 其余内容按整节声明整体属"设计建议"，均不构成事实陈述。

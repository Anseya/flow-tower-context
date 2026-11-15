# 02b · Agent 记忆补充四篇：独立核验与实现深挖

> 日期：2026-11-15 ｜ 角色：papers-agent-2（task-7）
> 前置：已全文读完 `00-精读笔记.md`（125 行）与 `01-构思对齐.md`（123 行），本文不复述，只做核验与深挖。
> 资料：`papers/tree-memory/extracted/` 四篇 txt。**行号均为 read 工具行号**，`文件:行号` 可直接回查。
> 原则：原文事实 = 白文；判断 = 【推断】。查不到的一律进第 5 节，不补写。

---

## 1. 本次实际读了什么

| 文件 | read 总行数 | 实际阅读区间 | 重点 |
| --- | --- | --- | --- |
| HORMA_2026_2606.11680.txt | 1946 | 1–480、529–1105、1222–1302、1443–1946 | 方法 4.1–4.4、表 1–3、附录 B/C/D/E |
| HarnessTheMemory_NeurIPS2026_2608.15008.txt | 6913 | 1–120、180–450、730–904、1130–1327、2159–2338、2576–2706、3019–3088、3418–3632、6881–6913 | 摘要/贡献、11 substrate、k 扫描、路由 E.3、组合 E.4、限制 |
| CoMeT_ACL2026_2602.01766.txt | 2754 | 1–130、131–290、339–657、737–1074、1588–1657 | 摘要/绪论、3.1–3.2 记忆机制、表 2–4、结论/限制 |
| GameAgentSurvey_2024_2404.02039.txt | 2951 | 1–45、281–640、1800–1879 | §4 记忆系统全文、表 2、§9.1 开放挑战 |

- 未读：HORMA 参考文献 1106–1221；Harness 附录逐指标表的大部；CoMeT 参考文献；综述 §5 后半–§8（推理/感知/多智能体，与记忆无关）。
- 抽取质量提醒：CoMeT 第 410–620 行的公式与图内文字是 `<latexit>` 乱码；HORMA 图 1 的文字是碎片（104–139）；四篇的宽表都是逐列抽取，容易错位。因此本文数字优先引**正文句子**，宽表数字只在能对应到明确行列标签时引用。
- 版本提醒：综述正文是 ACM Comput. Surv.，页脚印 `Publication date: June 2026`（306、1800 行），文件名 2024/arXiv 2404.02039 只是首版时间；CoMeT 正文只标 `arXiv:2602.01766v2 [cs.LG] 17 Apr 2026`（106 行），**未核到 ACL 2026 录用字样**。

---

## 2. 机制层拆解

### 2.1 HORMA：文件系统式层级 + note 溯源（最贴近"流动树"的一篇）

**总式**：`F_{t+1}=T_F(F_t,a_t,o_t)`（348–350）；`π(a_t|o_t,F_t,q)=M_r(C_t|F_t,q)·M_θ(a_t|o_t,C_t,q;P_main)`（360–361）。写侧 manager `M_m` 与读侧 retriever `M_r` **显式解耦**，理由是完全不同的时间尺度与信用分配（204–224、326–331）。

**数据结构（原文可核）**
- 记忆 = 一个"分层文件系统 workspace"，每步把原始轨迹归档进**带时间戳的目录**，再按任务相关性合成结构化 note；note 存"紧凑抽象 + 时间元数据 + 指向底层 raw trajectory 的引用"（377–384）。
- 目录形状：图 1 抽取出的文字碎片给出 `/memory/entities/people/Alice_profile.md`、`/memory/events/Meeting_with_Alice.md`、`/memory/raw_logs/traj_0001.jsonl`、日期串 `2025-05-01 …`、以及 `Notes (Summaries) / Timestamps / Linked Evidence / raw logs` 分区（104–139）。**拼接成完整路径是我的【推断】**，原文没有给出目录规范。
- 附录 E 的实际 note 例子（1916–1945）：`People/Caroline.md`、`Dates/May2023.md`、`Topics/LGBTQ/support group.md`。内容形如
  `- Attended an LGBTQ support group on May 7, 2023 (the day before the conversation) (D1:3)`
  `- "I went to a LGBTQ support group yesterday and it was so powerful." (D1:3)`。
- **引用格式就是行内 `(D1:3)`**，与 LoCoMo 的 `dia_id` 命名一致（Harness 论文 P6 指标定义里也写 `gold evidence dia_ids`，`HarnessTheMemory…txt:3059`）；但 HORMA 全篇**没有定义** `D#:#` 的含义，标【推断】。
- 同一事实用**多条路径冗余索引**（People / Dates / Topics 三份），这正是它自己提炼的 end_003 技能"Retrieval Path Redundancy"（1636–1641）。

**导航动作（真实动作空间）**
`ls, grep, cd, cat` + 两个终止动作 `{select, done}`：`select` 把核实内容加入 `C_t`，`done` 在证据足够时终止（433–439）。**注意：没有"按 citation 解析回 raw 文件行"的动作**，论文也没写反查协议；从 `(D1:3)` 到 `raw_logs/*.jsonl` 的具体行，要 agent 自己 grep——这是 HORMA 没讲清的一环（见第 5 节）。

**伪代码（据 4.2–4.4 与附录 D.4–D.6 重写，非原文）**
```
每步 t：
  manager: mkdir 时间戳目录; 写 raw traj; 选相关性高的内容生成 note(.md)
           note = 抽象 + 时间锚 + 引用(来源轮ID) + 原始引文
  retriever: while not done and calls < 10:
               a = LLM(ls|grep|cd|cat|select|done, 当前目录/已读内容, q)
               if a==select: C_t += 选中内容
  primary: M_θ(a_t | o_t, C_t, q)      # 只吃 C_t，不吃整个 F_t
```
**真实超参数**：GRPO 学习率 `1e-6`、batch 64、mini-batch 16、rollouts G=8、clip 0.2、KL 0.01、entropy 0.001、rollout 温度 1.0、top-p 0.95、**max response 2048、max interaction turn 10**（1517–1541）；检索侧目标 **≤1000 tokens/query**（857–858），实测 Ncall 4.43–5.53 次/步或题（804–845）。评测预算：ALFWorld 上下文 1950/2200 tokens（1267–1273）；LoCoMo 10K、LongMemEval 50K（665–667）。

**效果（自报）**：ALFWorld 成功率 56.7%（small）/73.9%（large），Truncation 基线 17.9%/34.3%（638–640、848–850）；长对话只用基线 token 的 3.07%–22.17%（LoCoMo）与 1.24%–16.19%（LongMemEval）（253–254）；LoCoMo Overall 51.6（no-limit 55.9），LongMemEval Overall 55.9（no-limit 20.4）（677–786）。

**消融的两个关键结论**
1. **技能 prompt 是主要增益，RL 只对轻量 retriever 关键**：Claude 作 manager+retriever，无技能 51.5 → 有技能 73.9（ALFWorld）、42.2→51.6（LoCoMo）、43.6→55.9（LongMemEval），`Ncall` 还下降（804–820）。Qwen 3.5 4B：无技能无 RL 35.8 → 有技能 40.3 → 技能+GRPO 64.9（821–845）。**⇒ 对 DSH 插件：可先只抄"技能 prompt 库"，不必训练 retriever。**
2. **写侧组织坏掉，读侧救不回来**：把小模型的 retriever 换成 Claude 后增益很小，"flawed memory organization cannot be compensated for by high-quality retrieval"（947–958）。**⇒ 写侧（压缩/摘要模型与 prompt）比检索工具更值得投入。**

**失败模式（原文分类，可直接当检查表）**：`D_exo` = raw 能过、HORMA 失败 → 信息在构造时丢失；`D_end` = 反过来 → 结构化记忆抑制了幻觉/lost-in-the-middle（399–410）。exogenous 假设清单更具体：`facts never written, overwritten summaries, wrong file read, grep misses, truncation`（1827–1828）。技能 JSON 强制带 `memory_prompt_improvement` 字段（1837–1839）——**技能必须落成"怎么改写写侧 prompt"才算闭环**。

### 2.2 Harness the Memory：11 个 substrate 与"宽召回伤决策"

**实验设计（受控单变量）**：11 方法 / 7 家族（Flat、Text Record、Structural、Hierarchical、Refinement、Weight、Activation），四个属性定义 substrate——representation + write + read + management（2279–2291）；固定 prompt、scaffold、answer call、辅助 LLM（GPT-4O-mini）、embedding（text-embedding-3-small）、judge、agent loop（2323–2326）；3 骨干（QWEN3-8B / QWEN3-32B-AWQ / GEMMA-4-26B-A4B-IT）、4 基准（LoCoMo 1986 题、LME-S 300、ALFWorld 134、BCB-Hard 148）、26 指标（11 性能 + 15 效率）（339–358、3019–3088）。

| ID | 家族 | 写作 | 读取 | 管理（原文，2171–2280） |
| --- | --- | --- | --- | --- |
| M1 | Flat | encode + 入索引 | dense top-k | — |
| M2 | Flat | 分词 + BM25 | sparse top-k | — |
| M3 | Text | LLM 逐页 gist | LLM 选页再展开 | 文本去重 |
| M4 | Structural | LLM 写 note + 建语义链 | ANN + 链扩展 | 演化触发改邻居 |
| M5 | Structural | LLM 抽实体关系建 KG | KG+向量混合（RRF） | 惰性批量重建，期间用缓存图 |
| M6 | Hierarchical | 聚类 + LLM 摘要成**固定四层** | **collapsed-tree** 全层 top-k | 顶层去重 + 时间衰减，降级旧摘要 |
| M7 | Refinement | LLM 判轨迹 + 蒸馏策略 | 策略库 top-1 | 轨迹判分 + 策略去重 |
| M8 | Refinement | 经验聚成 skill bundle | **全部 bundle 预填进 prompt** | 合并/剪枝溢出 |
| M9 | Weight | LLM 造 QA + LoRA(r=8) | base+adapter 直接生成 | — |
| M10 | Activation | 全量 buffer | 全量拼接生成 | 超窗截断 |
| M11 | Activation | 轮次聚成 episode，留 25% token | 匹配质心，重 prefill episode | 聚类 + 预算 |

**流水线伪代码（据 2323–2326 的"固定 controller + 单变量 substrate"重写，非原文）**
```
每步（所有 substrate 共用同一 controller / prompt / aux-LLM / 记账口径）：
  write(x_t):  按该 substrate 的写策略落盘（M1/M2 零 LLM；其余可调 aux LLM）
  manage():    按该 substrate 策略去重/更新/重建（无管理动作的记 dash）
  read(q):     按该 substrate 读出条目/页/树节点/episode（collapsed-tree、KG hybrid、re-prefill…）
  answer:      M_θ(q, read(q), 同一模板) → 同一 judge 打分
  account:     write/read/manage 三阶段分别记 aux-LLM tokens 与 calls（26 指标，259–263）
```

**k 扫描（本题最关键的数字）**
- 设置：LoCoMo + QWEN3-8B，n=1986，`k∈{1,2,5,10,20}`，扫 M1/M2/M4/M6；ALFWorld + QWEN3-32B-AWQ，n=134，`k∈{1,2,3,4,5}`，扫 M1/M2/M4/M6/M7；NoMem 用同模板空检索块（352–355、2492–2493、1194–1195）。
- LoCoMo：**k=20 时每个 substrate 都高于 k=1**，跨 substrate 均值逐步上升（1195–1196、2580–2581）。
- ALFWorld：**符号翻转**，成功率随 k 下降；`M7 falls by about seven points between k=1 and k=5`，M1/M2 在 k=5 跌到 **NoMem 22.4% 以下**，M4 是唯一 k=5 不明显低于 k=1 的；平均步数略升（1197–1203、2582–2585）。32B 上 NoMem 22.4、M7 32.1、M1 27.6、M2 21.6、M5 23.1（770–779）。
- 机理（attention probe，QWEN3-8B + M1，上半层/头求和）：k 增大把注意力从 Context 抽向 Retrieved——LoCoMo `0.34→0.10` vs `0.05→0.66`；ALFWorld `0.19→0.17` vs `0.34→0.44`；Cue 质量在 k=1→5 也掉约 4%（1208–1224）。原文结论：**retrieval breadth 不是通用超参，是 regime-conditioned 的**（1225–1226）。

**路由（附录 E.3，正好回答 01 的分总层路由问题）**
- 可部署条件：router 只能读 query 与已拟合策略，**不能读 gold、不能读事后哪个 substrate 对**；对比对象是"最强单一固定 substrate"；报告的是 routed accuracy 而非 routing accuracy（3422–3431）。
- 四个 router：multi-class（TF-IDF/embedding）、25-NN、per-substrate outcome 二分类、预测问题类型；两个参考行：gold 类型、per-instance oracle（3438–3450）。
- 结果：per-substrate 路由 **0.671 vs 固定 M5 0.648**（+0.023，精确 McNemar p=0.032，5/5 折，223 对 179）；25-NN 0.650；multi-class 0.591/0.588；预测类型 0.613；gold 类型 0.689；**oracle 0.93**（3453–3508）。
- 稳健性：conversation-grouped 折 +0.013（p=0.22，3/5）；leave-one-conversation-out +0.001（p=0.96，5/10）——"The gain shrinks … and disappears …"（3556–3560）。**只能声称同会话问题级收益，明确不声称跨会话迁移**（3558–3560）。
- 目标形式比特征更重要：把"预测赢家"换成"每个 substrate 各自预测会不会答对"，0.588→0.671（3509–3514）；最优 router 只需一次 embedding、零 LLM 调用、零标注（3513–3514）。
- 组合（E.4）：2 个异质 substrate 比最强单体多 0.098–0.123 覆盖（三个对话基准）与 7.5 点（两个 agentic 基准）；3 个可补齐到全池的 63%（LoCoMo）/79%（LME-S）/54%（ALFWorld）/100%（BCB、MAB CR）；`M4, which is never the per-model performance winner, enters the LoCoMo, ALFWorld, and BCB-Hard portfolios because it solves instances the leaders miss`（3618–3625）。

**成本与扩展性（工程上最有用的三条）**
1. 层级本身不贵，**建树贵**：M6 在性能-延迟图上的延迟主要是一次性建树、被第一个 query 吸收，`steady-state per-query cost is comparable to the Flat baselines`（1166–1167）；M6 是惰性构建，write 只 embed+append（2630–2640）。
2. **预填式 substrate 在高深度崩**：M8 每次 read 把全部 skill bundle 预填，质量 0.32→0.51 但延迟约 1s→**约 98s**@262K；M4/M5/M10@262K 为 60–75s；只有 flat 索引 <10s（1231–1245）。M10 在 262K 时 buffer 超窗，截断只留最近的，反而丢掉被更新的旧事实（1246–1250）。
3. **管理型系统成本高**：aux-LLM 调用 MemGPT 2739 次/16.3h、Mem0 8984 次/11.8h、Zep 7624 次/23.1h（2669–2687）；M4 在 LME-S 上 234s 反而不如 M2 的 7.3s，M9 用 172s 只换到 P4=0.29（1178–1186）。

**局限（自报，6881–6894）**：排除 MemGPT/Mem0/Zep（策略不在单变量框架内）；M8/M11 是近似实现；agentic 基准只有 134/148 题、单次 greedy；judge 与辅助 LLM 同 provider，未对人工核验；路由增益是同会话 in-sample；主基准没有"后一轮依赖前一轮写下的记忆"（MemoryArena 补充只覆盖一个骨干两个域）。

### 2.3 CoMeT：模型内部记忆，对插件是边界而非零件

**它是什么**：一个**要改模型结构、要微调**的 Transformer 插件——每层把 global memory `G_i` 与 temporary memory `T_i` 前插到当前 chunk 的 hidden states，另有压缩 token 与 readout token（351–448、424–433）。global state 用低秩残差适配器 `RLA(X)=X+W_up(W_down X)`，rank=8；门控更新 `S_{τ+1}=g⊙S_τ+(1-g)⊙S̃`，`g=σ(W_g([S_τ;S̃]))`（515–564）。temporary 是**定容 FIFO 队列**，新进旧出（565–646）。两个记忆合起来充当下一 chunk 的"dynamic soft prompt"（36–37 行）。

**关键数字**：只给 Qwen3-4B 加 **3.95M 参数（0.098%）**（570–571）；3 epochs / 32k 训练（930–935）；1500 步微调后 1M token 内任意位置捞 passkey（1037–1041）；SCROLLS 平均 40.10（微调全注意力 42.23，记忆 2560 tokens）（876–885）；1M 上下文 21× 推理加速、10× 显存（186–192）；UQA 78.7（4k full-attn 51.3、xRAG 76.0）（976–1005）；Terminal-Bench CoMeT 20.27 vs 128k full-attn 21.33，Qwen3-8B，chunk 4096、memory 1024G+4096T（986–1012）。

**边界判断**：
- DSH 插件只能改"送进模型的文本/工具/上下文"，改不了逐层 hidden states、KV cache 或权重；CoMeT 还需要自定义 attention/kernel 与 layer-level pipeline parallelism（182–185、2700–2701）。**⇒ 对插件完全不可用**；它与 01 里"文本树"不是同一层的东西。
- 它自己承认没做外部记忆：`has not yet explored integration with episodic memory (test-time training) and external memory (such as notebooks and RAG-based knowledge bases)`（1604–1609）。**这恰好是插件的领地，等于作者把边界画给了我们。**
- 可借的只有**隐喻**（标【推断】）：常驻总述≈定容 global memory（有界、门控更新），叶层最近原文≈FIFO；但插件里的"gate"只能写成可解释的加权合并规则，不能是学出来的。

### 2.4 游戏 Agent 综述：树式合并、信号触发、遗忘

- 记忆二分：working memory（context extension / memory compression / active maintenance）+ long-term memory（consolidation / structuring / retrieval）（281–310、312–321）。
- **树式经验合并**原文：`To capture hierarchical relations, memories can be recursively clustered into a tree structure… the underlying idea is to let new experiences traverse the tree, merging with existing nodes or forming new branches, while recursively updating parent summaries`（475–479）；游戏域例子 GLoW 的 dual-scale world memory、MACLA 的 hierarchical procedural memory（480–483）。
- **signal-triggered consolidation** 原文段（391–401）：Generative Agents 按重要性累计过阈值才 pause+reflect；MemoryBank 按与目标的 salience 阈值提交；Voyager 用任务结果当信号（成功代码进 skill library，失败排除或降权）。
- **树检索两派**：从根逐层 top-k 下降 vs `collapse the hierarchy into a flat pool of summaries and retrieve based purely on semantic similarity`（523–526）。
- **开放挑战原文**（1824–1836）：从"存更多"转向真正的 world-model memory，三条原则——(i) Predictive dynamics、(ii) Structural compositionality、(iii) **`Selective consolidation and forgetting: long-term memory should decide what to keep and what to discard… while letting irrelevant or low-value details fade`**。**遗忘被明确写成未解问题，不是可抄的成熟零件。**

---

## 3. 对 `00-精读笔记.md` 的核验

### 3.1 一致（逐条给证据）

| 00 的条目 | 证据 | 判定 |
| --- | --- | --- |
| 标题表 4 条 | HORMA 1–2；HTM 1–2；CoMeT 1–2；综述 1 行（标题连字符差异：`Model-Based`） | 一致（综述标题少一个连字符） |
| HORMA = 文件系统式层级 + 带时间戳 note 引用 raw trajectories + `ls/grep/cd/cat` | 377–384、433–439、104–139 | 一致 |
| HORMA 用 GRPO 学导航、<1000 tok/query | 443–451、857–858 | 一致（RL 只训 retriever） |
| HORMA `Recursive Skill Refinement`、4 轮 63 技能 | 397–422、973–980 | 一致 |
| HTM 11 substrate / 3 骨干 / 4 基准 / 26 指标 | 242–244、339–349 | 一致 |
| HTM `retrieving more entries helps QA but hurts agentic decisions…attention shifts away…` | 245–249 | 一致（原文逐字） |
| HTM `no single substrate can simultaneously serve recall…action selection…graceful scaling` | 1259–1261 | 一致 |
| HTM `a substrate optimal for short sessions can thus become a liability` | 1256–1257 | 一致 |
| HTM `finer query-level routing remains largely open` | 257–258 | 一致 |
| HTM M6 lazy construction / top-level dedup + temporal decay / demote | 2630–2640 | 一致 |
| HTM M4 evolution-triggered rewrites；M5 周期重建+缓存图；M8 online skill-evolution | 2618–2620、2626–2627、2649–2650 | 一致 |
| 综述 `new experiences traverse the tree…recursively updating parent summaries`、`signal-triggered consolidation` | 475–479、394 | 一致（引文省略了句首 `the underlying idea is to let`，建议补省略号） |
| 综述把 `Selective consolidation and forgetting` 列为开放挑战 | 1832–1836 | 一致 |

### 3.2 更正 / 需精确化（4 条，务必改）

1. **CoMeT 是"同名不同物"：00 第 4 节把它列为"可直接复用的骨架"不成立。** 论文 CoMeT = 逐层 global/FIFO 记忆的**模型架构**，需要微调与自定义 kernel（339–448、1604–1609、2700–2701）；用 `add_document|vector store|T1|T2|T3|depth` 全文 grep，除 base64 乱码行外只命中 `30% depth`（passkey 位置，1516 行）与 `RAG-based knowledge bases`（自述未做外部记忆，1609 行），**没有任何"depth 0–2 树 / T1/T2/T3"机制**。§4.3 讲的是 `comet-memory 0.5.0` 这个包，与 ACL 论文是两个东西。00 标题表对论文的定性"模型内部记忆，非文本树"是对的，但 §4 的标题与归类会把实现者带偏：**论文 CoMeT 对 DSH 插件没有可抄零件，只有设计隐喻**。
2. **HORMA 的"原文回溯句柄"比 00 写的弱。** 00 §2 把它与 MemGPT/ReadAgent 并列为"原文回溯句柄"，但原文只证明 note 里带 `(D1:3)` 这种**可读标注**（1916–1945），没有给出"从标注解析回 raw 文件行"的动作或协议；动作空间只有 `ls/grep/cd/cat/select/done`（433–439）。⇒ 准确说法是"**语义可读的引用**，取原文仍需 agent 自行 grep"，不是机器可解析的 ID↔范围映射（那种能力 00 §5 归给 PageIndex 才对）。
3. **"HORMA 用 GRPO 学导航"要补主语与主次。** RL 只训轻量 retriever；manager 走 prompt 技能演化，不训（443–451、397–422）。且消融显示：Claude 作 manager+retriever 时仅加技能就把 ALFWorld 从 51.5 提到 73.9（804–820）；Qwen 4B 的 `64.9+29.1` 是 **skill+RL 相对无技能无 RL 基线的总增益**，其中 skill-only 40.3 → skill+RL 64.9（838–845）。00 §3.2 把它放进"可流动零件"时写"在线"，也要限定：**memory 在 episode 内在线构建；技能库是跨 task 的对比分析离线迭代**（399–422、973–980）。
4. **"ALFWorld k=1→5 掉约 7 点"需补主语。** 原文是 `M7 falls by about seven points between k=1 and k=5`（1197–1198），骨干 QWEN3-32B-AWQ；同段还说 M1/M2 在 k=5 跌破 NoMem 22.4%、M4 是唯一没明显掉的。不是"所有 substrate 平均掉 7 点"。

### 3.3 补强（00 未记、但对实现有用）

- **HTM E.3 是这批里唯一的 query-level router 实测**：per-substrate outcome 路由 0.671 vs 最强固定 0.648（同会话问题级，p=0.032）；换 conversation-grouped 只剩 +0.013（n.s.），leave-one-conversation-out +0.001（n.s.）（3453–3560）。⇒ 00 §6 反证 1"跨塔概括层是空白"依旧成立，但**"如果要做跨树路由，天花板在哪、增益有多脆"现在有实测锚点**：oracle 0.93，可部署 router 只拿到 +0.023。
- **M6 成本模型**（00 §6 反证 3 只写了"流动 vs 缓存冲突"）：HTM 实测层级**稳态几乎免费、建树一次性贵**（1166–1167、2630–2640）。⇒ "流动塔"的主要代价不是每查询层级导航，而是**重建动作**，这支持 01 §7.3 的"静默期/批量窗口"（【推断】）；但 HTM 只从管理策略角度做 periodic rebuild（M5，2626–2627），**没有从缓存成本角度论证**静默期。
- **18 条现成技能**（HORMA 表 9–11，各 6 条，1558–1722），例如：Temporal Precision Anchoring、Verbatim Quote Preservation、Retrieval Path Redundancy、Negative Evidence Handling、Causal Chain Preservation、Entity-Centric File Organization、Cross-Reference Comparative Facts、Implement Retrieval Coverage Diagnostics、Goal-Object Spatial Pinning、Failed-Action Loop Detection、Multi-Step Plan Persistence、Preserve Object Identity Chains、Receptacle State Persistence、Appliance Interaction Failure Detection。**这是整批资料里最可直接 prompt 化的零件**，00 完全没提。
- **写侧失败五类**（1827–1828）+ **must include `memory_prompt_improvement`**（1837–1839）给了"技能→写侧 prompt 改写"的闭环格式，可直接搬成插件里的"压缩 prompt 修订记录"。
- **综述还有两条 00 漏引的开放挑战原则**：Predictive dynamics、Structural compositionality（1824–1831）。对分总层"总述视图"的启示：总述应带**对未来的预测/结构关系**，而不只是过去摘要（【推断】）。
- **00 §1 的过程性补正**："全部抽到正文（无扫描版空文本）"成立，但**抽取不是无损的**：CoMeT 公式与图内文字为 `<latexit>` 乱码（410–620），HORMA 图 1 为碎片，宽表逐列抽取易错位。以后引用这些文件必须沿正文句子核。

---

## 4. 面向 DSH 插件的实现映射

### 4.1 数据结构与字段（在 bgx666 单树表上扩展；字段名建议）

| 字段 | 作用 | 依据 |
| --- | --- | --- |
| `tree_id` | 多树分区键；替代只靠 `session_id` | 00:111 记录 bgx666 `PRIMARY KEY(session_id,id)` |
| `path` | 虚拟路径（`/tree/{id}/entities/people/...`），供 `ls/cd` 用；**不落地成真实文件** | HORMA 图 1（104–139）+ 附录 E（1916–1945） |
| `kind` | `entity/date/topic/event/note/raw`；同一条事实可多路径冗余 | HORMA end_003（1636–1641） |
| `citations[]` | `{raw_ref, session_id, turn_id, quote, quote_hash}`；`raw_ref` 必须机器可解析（比 HORMA 的 `(D1:3)` 更强） | HORMA 1916–1945 + 00 §5 PageIndex 映射零件 |
| `content_md` | 给 LLM 读的 note 正文（分段 + 行内引用 + `Original Quote` 块） | HORMA 附录 E + end_002（1627–1634） |
| `source_ids[]` | 父节点 → 子节点/叶消息的回指，支撑下钻与审计 | 00:100 双时态+episode 溯源 |
| `valid_at/invalid_at/superseded_by` | 软失效，**不硬删** | 综述把选择性遗忘列为未解（1832–1836）；00 §5 graphiti 零件 |
| `tier`、`importance`、`access_count` | 冷热与信号触发用；只改元数据不改结构 | 01 §8.1 ③ |
| `diagnostics` | 检索返回的诊断对象，见 4.4 | HORMA exo_003（1715–1722） |

### 4.2 工具面（HORMA 动作 → DSH 工具）

| HORMA | 建议 DSH 工具 | 参数 | 返回约束 |
| --- | --- | --- | --- |
| `ls` | `flow_tree_ls(path?, depth?)` | 路径/树/深度 | 稳定排序（按 tree_id,path），否则破坏前缀缓存 |
| `grep` | `flow_tree_grep(pattern, scope?)` | 关键词/正则 + 树范围 | 返回命中节点 ID + 命中行摘要 |
| `cat` | `flow_tree_cat(node_id, range?)` | 节点/行范围 | 只返回被请求片段，≤700 字符/条 |
| `select` | `flow_tree_select(node_ids[])` | 证据节点 | 写入本轮 `C_t`，去重 |
| `done` | `flow_tree_done()` | — | 终止并返回证据+诊断 |
| （无） | `flow_tree_map()` | — | 路由视图（树级画像），见 4.5 |
| （无） | `flow_tree_overview(tree_id)` | 树 ID | 总述视图，按需、带版本号 |

工具数建议 ≤6（HORMA 只有 4 命令 + 2 终止动作，433–439）；不要把 `overview` 塞进每次调用。

### 4.3 触发时机（对齐 01 §8.1 四类事件）

| 01 维度 | 建议触发 | 依据/约束 |
| --- | --- | --- |
| ① 垂直上浮 | 保留 bgx666 的 9/3/8 固定阈值（00:80–82） | 最成熟；HORMA 也是固定 10 轮检索上限 |
| ② 结构自适应 | **静默期 + 批量窗口**，别逐消息触发 | HTM M5 周期重建 + 缓存图（2626–2627）；M6 惰性构建把成本吸收到首查（2630–2640） |
| ③ 时间冷热 | 只改 `tier/importance`，不动 topology | 01 §8.1 原判断；HTM M6 temporal decay（2639） |
| ④ 跨树迁移 | **第一版不做** | 四篇无任何跨树迁移先例；HTM 的 portfolio 是"多 substrate 并存 + 理想选择器"，不是迁移（3568–3627） |
| 新增：信号触发 | 任务完成/失败、用户显式"记住"、重要度累计过阈值 | 综述 signal-triggered consolidation（394–401）；HORMA 用任务结果分流 D_exo/D_end（399–410） |

### 4.4 检索预算与 regime 切换（本条是本文最重要的设计约束）

- **两个 profile**：`qa`（用户问答/闲聊）→ `k=5–20`，允许宽召回；`agentic`（工具循环/执行中）→ `k=1–2`，优先写深度的蒸馏而非宽检索。依据：LoCoMo 跨 substrate 均值随 k 每步上升、k=20 时每个 substrate 都高于 k=1；ALFWorld 则相反，均值在 k=1 之后每一档都低于 k=1（1195–1203、2580–2585）；且这是 attention 机制而非某个 substrate 的问题（1208–1226）。
- **regime 判定不得调 LLM**：HTM 说"部署服务本来就知道自己在答长文还是跑 agent loop，按 regime 路由零成本"（3516–3517）。DSH 里可用**廉价可观测信号**（本回合是否有 tool_call / 是否处于执行循环 / 用户消息类型）判定（【推断】）。
- **每次检索硬上限**：目标 ≤1000 tokens/query（HORMA 857–858），工具调用 1–2 次为默认、上限 4–5（HORMA 实测 4.43–5.53 Ncall，但那是有 RL 且按步计，插件没有 RL 不要模仿）；返回条数按 regime 定，绝不做 M8 式"全部 bundle 预填"（那在 262K 是 98s，1235–1239）。
- **写侧优先**：manager 用强模型；若压缩质量不够，加检索工具救不回来（947–958）。写侧 prompt 直接插入 HORMA 技能清单（1558–1722），预期收益最大且零训练（804–820 的技能消融）。

### 4.5 prompt 位置与前缀缓存影响

| 内容 | 放哪 | 变更频率 | 缓存影响 |
| --- | --- | --- | --- |
| 路由视图（树级画像：`tree_id + 一句话画像 + 时间范围 + 活跃度 + 预估下钻代价`） | **system prompt 末尾的独立段**（或紧随 system 的稳定块） | 仅建树/合树/归档时 | 低频变更 → 前缀基本稳定；**必须整段替换、稳定排序**，否则每次渲染顺序变化都击穿缓存（【推断】） |
| 总述视图 | 工具返回 / UI 面板，**不进 system** | 按需、带版本号 | 不污染前缀；支持 01 §8.2"不得回写路由" |
| 检索结果（`C_t`） | 当轮 tool result 消息 | 每轮 | 不进前缀，安全；HORMA 主 agent 只吃 `C_t`（438–439） |
| 写侧技能库 | manager 的写 prompt（压缩事务内） | 低频 | 与主对话前缀无关 |
| 节点卡 UI | 前端按需拉取 | 随时 | 与模型上下文无关（bgx666 已如此，00:84） |

- **建树/重组必须塞进压缩事务**：HTM M6 把建树成本记在**第一个 query** 上（1166–1167）；DSH 若在用户可见的对话回合里触发重建会直接造成延迟尖峰。建议在 `beginRun/commitRun` 事务内完成，失败则 `rollback`（bgx666 已有此机制，00:85）；这不改变"首查付费"的事实，只是把它藏进原本就慢的压缩回合。
- **多树渲染**：`renderNodeBlocks`（bgx666 `text.js:205`，见 00:112）只渲染单树 `roots`，多树必须重写且输出顺序稳定（按 `tree_id` 排序），否则前缀缓存失效。

### 4.6 失败模式与可观测性

- 写侧五类失败（HORMA 1827–1828）→ 守卫：写后回读校验（facts never written / overwritten summaries）、路径白名单（wrong file read）、双索引+BM25 兜底（grep misses）、预算裁剪必须留标记（truncation，正好复用 `NODE_MARKER` 思路，00:85）。
- 读侧诊断（HORMA exo_003，1715–1722）：工具返回必须带 `{searched, matched, coverage_gap, truncated}`，让模型能区分"记忆里没有"和"有但没检索到"——这是防"假阴性回答"的最小机制。
- 管理侧：M10 的教训是**截断会丢掉被更新的旧事实**（1246–1250）→ 必须有 `valid_at/superseded_by` 双时态，不能只靠窗口截断。
- 去重放在**写侧**（M3 text dedup / M7 strategy dedup / M8 merge+prune，表 4），不要放读侧。

### 4.7 CoMeT 的不可用边界（写进设计文档，避免返工）

- 不可用：需要改逐层 hidden states / KV cache / 权重 + 自定义 kernel（339–448、2700–2701）；DSH 插件层拿不到这些接口。
- 可借的隐喻（【推断】）：分总层 = 有界 global memory（门控、定容、别无限长）；近端上下文 = FIFO；"gated update" 在插件里落成**重要性加权合并 + 旧节点降级**，不做学习式门控。
- 它自认没做外部记忆（1604–1609）→ 插件方向不存在"被论文做完了"的风险。

### 4.8 对 01-构思对齐 的三条输入

1. **支持 01 §8.2 硬规矩**：可部署 router 只能读 query+policy（3422–3431），总述视图不是合法路由特征；且路由实测增益只有 +0.023（同会话）→ 把总述回写路由的收益预期定低、风险定高（【推断】）。
2. **支持 01 §8.1 拆四类调度器**：HTM 里四种触发对应四种成本曲线——M4 写时即时改写、M5 周期重建、M6 首次读惰性建、M8 写时持续演化（2618–2650）；同一份数据四种维护策略的成本差一个量级（1s vs 98s@262K，1238）。混在一个调度器里必然分不清成本归因。
3. **给 01 §7.3"静默期"补一个先例与一个缺口**：先例 = M5 周期重建+缓存图、M6 惰性建树；缺口 = 两篇都**没有从前缀缓存成本角度论证**，所以静默期的缓存收益仍是【推断】，需要 DSH 侧实测。

---

## 5. 事实边界

1. **未读部分**：HORMA 参考文献（1106–1221）；Harness 附录逐指标表（表 16–20 等只核了标题与个别数字）、附录 C/D/F/G 大部；CoMeT 参考文献（1654+）；综述 §5–§8 及多智能体部分。本文对未读区域不做任何断言。
2. **抽取损伤**：CoMeT 公式/图内文字为 `<latexit>` 乱码（410–620）；HORMA 图 1 为碎片（104–139）；Harness 图 2 行内断行；宽表逐列抽取易错位（HORMA 表 1、Harness 表 1/2）。本文数字只引正文有对应句子的地方；表格数字引用时已尽量选有行标签的块。
3. **未核到**：HORMA 导航 agent 的 system prompt / 输出格式（附录 D 只有答题、技能发现、judge prompt，1725–1908）；note 引用 → raw 文件的反查协议；`D#:#` 的官方定义（按 LoCoMo `dia_id` 惯例推断，Harness 3059 只证明 `dia_id` 术语存在）；HORMA 63 条技能全清单（只给 4 轮→63 条、附录给 18 条示例）；CoMeT 的 ACL 2026 录用信息（正文仅 arXiv v2）；综述的 arXiv 2404 首版与 ACM CSUR June 2026 版本差异未逐版对比。
4. **论文自报、未复现**：HORMA 全部数字（Claude Sonnet 4.5 主骨干、4×H200 训 GRPO、LoCoMo 7 conv/1089 QA 训练、LongMemEval 零样本 OOD）；HTM 全部数字（单次 greedy、ALFWorld 134 / BCB 148 / LME-S 300 的小样本、judge 与辅助 LLM 同 provider 无人工核验、router 只在 LoCoMo+QWEN3-8B）；CoMeT 全部数字（UQA 为真实电商数据、正文未说明可获取，Terminal-Bench 用 iflow-cli）；综述是综述归纳，本身无新实验。
5. **我的推断清单**（不进事实层）：`D1:3`=LoCoMo dia_id；图 1 目录拼接；regime 检测用"本回合是否有 tool_call"；路由视图放 system 末尾可用整段替换保缓存；静默期的缓存收益；"gate/FIFO"隐喻到插件的映射；技能 prompt 在 DSH 上的可迁移收益（HORMA 证据支持但未在 DSH 环境验证）。
6. **本文与 00/01 的关系**：本文只补四篇与纠错，不改变 00 的三条反证；第 3.2 节第 1 条（CoMeT）与 00 §4 的"可复用骨架"表述冲突，建议以本文为准并回改 00 的归类。

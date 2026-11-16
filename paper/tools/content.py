# -*- coding: utf-8 -*-
"""Paper content (Chinese, GB/T 7713.2 layout elements).

Body blocks:
  ("h1", text) ("h2", text) ("p", text) ("note", text) ("code", text)
  ("fig", name, caption) ("table", table_id) ("eq", formula, number)
Citation markers inside text use ⟦1,2⟧ and are rendered as superscript [1,2].
"""

META = {
    "title_cn": "Flow Tower：压缩驱动的项目级\n上下文记忆系统设计与实现",
    "title_en": "Flow Tower: A Compaction-Driven\nProject-Level Context Memory System",
    "authors_cn": "",
    "authors_en": "",
    "affiliation_cn": "",
    "affiliation_en": "",
    "abstract_cn": (
        "针对长程工程任务中压缩摘要不可检索、跨会话记忆丢失、摘要漂移后无法回溯原文的问题，"
        "设计并实现了宿主原生的项目级上下文记忆系统 Flow Tower。系统以智能体运行时的压缩事件为唯一编纂锚点，"
        "把每次压缩产生的摘要增量确定性地编译为项目本地词典，包含十类词条、类型化关系、seq 引文与三层摘要树；"
        "并以“短程 checkpoint + 长程 digest”双注入策略，按任务类型、checkpoint 新鲜度与上下文压力自适应选择"
        "四种注入模式与注入预算。系统以插件形式实现，并在会话预设层接管压缩 provider，使其成为会话真实的压缩路径。"
        "在包含 8 次压缩、3881 条词条的真实开发会话上评估：编译零 LLM 调用，单次长程注入 694～829 token"
        "（平均 767 token，低于 900 token 的目标），检索 Recall@5 为 0.94，压缩接管时延 33.7 s 且向压缩请求"
        "注入 1799 字符项目记忆；离线 25 题命中与引文保真均为 100%，8 轮长会话累积 934 条词条且重复轮幂等；"
        "在 844 万字符长篇小说与 123 万字符论文合集上完成长文本规模压测，"
        "分别编译 2,846 与 791 条词条、引文保真均为 100%。进一步总结了开发过程中发现的 8 类工程问题——隔离层语义、checkpoint 位置假设、"
        "重复注入、检索融合负收益、HTTP 路由缺依赖、异源日志证据合并、注入预算生命周期、启发式抽取噪声——"
        "并给出根因、修复与验证方法，为同类宿主内置记忆系统的工程化提供参考。"
    ),
    "keywords_cn": "大语言模型；上下文工程；长期记忆；压缩摘要；检索增强生成；智能体；插件架构",
    "abstract_en": (
        "Compression-based context management keeps long-horizon agents within a finite window, but the resulting "
        "checkpoint is neither searchable nor replayable across sessions, and it drifts as summaries are recursively "
        "rewritten. This paper presents Flow Tower, a host-native, project-level context memory system that turns the "
        "runtime's compaction events into the single write anchor: each compaction delta is deterministically compiled "
        "into a project-local dictionary with ten entry kinds, typed relations, seq-referenced citations and a "
        "three-layer summary tree. A dual-injection policy then combines the short-range native checkpoint with the "
        "long-range digest, selecting one of four injection modes and an adaptive token budget from the task type, "
        "checkpoint freshness and measured context pressure. Flow Tower is implemented as a host plugin and, through a "
        "preset-level override, becomes the real compaction provider of the session itself. On a real development "
        "session with 8 compactions and 3,881 compiled entries, compilation required no LLM calls, a single long-range "
        "injection cost 694–829 tokens (767 on average, below the 900-token target), Recall@5 reached 0.94, and "
        "compaction takeover took 33.7 s while injecting 1,799 characters of project memory. The offline harness "
        "reached 100% lookup hit and citation fidelity on 25 programming queries, and an 8-round long session "
        "accumulated 934 entries while replaying idempotently. A long-text corpus "
        "stress test over an 8.44M-character Chinese novel and a 1.23M-character paper collection compiled 2,846 and "
        "791 entries respectively, both with 100% citation fidelity. We further report eight "
        "engineering problems found during development — isolation-plane semantics, checkpoint-position assumptions, "
        "duplicate injection, negative returns from rank fusion, a route missing imports, evidence merging across "
        "heterogeneous logs, injection-budget lifetime, and heuristic extraction noise — with root causes, fixes and "
        "verification methods."
    ),
    "keywords_en": (
        "large language models; context engineering; long-term memory; compaction summary; "
        "retrieval-augmented generation; agents; plugin architecture"
    ),
}

BODY = [
    ("h1", "0　引言"),
    ("p", "大语言模型（LLM）的上下文窗口在持续扩大，但长程工程任务的有效上下文并不会因此变得无限：一方面，"
          "工具输出、文件读取与多轮试错的累积速度远快于窗口增长，单次任务产生数百万字符的中间结果并不罕见；"
          "另一方面，即使窗口未满，过长上下文的注意力稀释、成本与延迟也会显著恶化推理质量。主流宿主因此采用"
          "“压缩（compaction）”：当上下文压力超过阈值时，调用一次 LLM 把较早的历史改写成固定结构的摘要，"
          "再用该摘要替换原历史，从而把窗口释放出来。"),
    ("p", "以本文依托的 DeepSeek Harness（DSH，0.2.2-rc.3）⟦14⟧为例，其 compaction 组件把被遮蔽区间压缩为八节"
          "checkpoint（任务请求、关键概念、涉及文件、错误、待办、当前工作、下一步、关键上下文），保留最近一段"
          "原文，并在压缩前用工具结果裁剪器（pruner）先删除超大工具输出。这一机制在“单次任务内接着做”上非常"
          "有效，却留下三个结构性问题：其一，摘要文本只存在于会话上下文中，不可按主题检索，模型想查“上次那个"
          "错误码”只能重读文件或再次压缩；其二，摘要随压缩递归重写而漂移，早期细节被逐层丢弃且无法逐字回放；"
          "其三，记忆以会话为边界，跨会话、跨子代理的项目全貌与任务清单不可见。"),
    ("p", "直接补救的常见做法是外挂向量库或摘要树：把历史切块、嵌入、检索，或在压缩之上再建一层递归摘要。"
          "这类方案在学术基准上有效，但在“宿主内置”场景要付出额外代价——写放大（每次压缩再调用若干次 LLM）、"
          "原文可回溯性下降（检索到的是被改写过的摘要）、以及常驻注入带来的固定 token 开销。本文的出发点是另一个"
          "观察：压缩事件本身就是一个高度结构化的写入锚点。它由宿主事务化地触发，携带被遮蔽区间的精确 seq 范围，"
          "并且其摘要已经过 LLM 组织成“文件、命令、错误、任务、决策”等语义单元。与其在压缩之上再叠一层抽取，"
          "不如把压缩的增量直接编译成可检索、可回溯的项目记忆，再按需注入回上下文。"),
    ("p", "基于这一观察，本文设计并实现了 Flow Tower。系统的核心设计可概括为四点：（1）以压缩事件为唯一编纂锚点，"
          "对摘要增量做确定性编译（零 LLM），生成十类词条、类型化关系、seq 引文与三层摘要树；（2）以“短程原生"
          "checkpoint + 长程项目 digest”双注入策略解决长短程信息的分工与去重，按任务类型、checkpoint 新鲜度、"
          "上下文压力自适应选择四种模式并缩放预算；（3）以项目本地 SQLite 为存储、以只读工具与面板为检索面，"
          "保证逐字回放且不引入外部服务；（4）在会话预设层接管压缩 provider，把“项目记忆”注入压缩请求，"
          "使长程记忆真正进入宿主的压缩路径，并支持多子代理共享同一项目记忆。"),
    ("p", "本文的贡献如下："),
    ("p", "（1）提出压缩驱动的确定性编纂方法：把 compaction/summary 事件及其 seq 增量编译为项目级词典，"
          "在不增加 LLM 写放大、不牺牲原文可回溯性的前提下获得可检索的长期记忆；"),
    ("p", "（2）提出并实现长短程双注入策略：以 checkpoint 新鲜度、任务类型与压力比驱动 dual / dual-lite / "
          "long-only / short-only 四种模式，并给出自适应预算公式，在真实会话中把单次长程注入控制在 767 token 量级；"),
    ("p", "（3）完成宿主级压缩路径接管：以预设覆盖方式替换会话的压缩 provider，并建立“引擎调试日志 + 运行日志"
          "引擎行 + 状态接口”三证据链，在真实 /compact 上验证项目记忆注入（1799 字符）；"),
    ("p", "（4）给出多智能体（子代理）共享项目记忆的适配：无自有词典卷的子会话读取项目级 digest，跨卷聚合"
          "未完成任务，并以项目版本代理触发再注入；"),
    ("p", "（5）系统总结开发中发现的八类工程问题及其修复，覆盖隔离层语义、位置假设、重复注入、融合负收益、"
          "证据合并与预算生命周期等，可作为同类“宿主内记忆插件”的踩坑清单；"),
    ("p", "（6）在真实多轮编程负载上完成评测：离线 25 题命中/引文保真 100%、8 轮长会话 934 条词条且重复轮幂等、"
          "真实开发会话 8 次压缩 3881 条词条；并补充 844 万字符长篇小说与 123 万字符论文合集的长文本规模压测"
          "（第 4.2、4.7 节）。"),
    ("p", "全文组织如下：第 1 节回顾相关工作；第 2 节给出系统设计与关键决策；第 3 节介绍实现与工程治理；"
          "第 4 节给出真实会话上的实验与评估；第 5 节讨论开发中发现的问题与经验；第 6 节分析局限与未来工作；"
          "第 7 节介绍项目结构、复现方式、发布地址与安装方式；第 8 节总结全文。"),

    ("h1", "1　相关工作"),
    ("h2", "1.1　分层摘要与记忆树"),
    ("p", "面向长上下文的记忆管理大致分为“压缩/分页”和“分层/检索”两条路线。MemGPT⟦1⟧借鉴操作系统虚拟内存，"
          "把上下文分为主上下文、归档与召回三层，由模型通过函数调用在层间搬移数据，是“LLM 即操作系统”的代表；"
          "RAPTOR⟦2⟧对文本块递归聚类并逐层摘要，形成可检索的摘要树，从树的不同高度同时召回；MemWalker⟦3⟧"
          "把长文组织成倒树，让模型从根节点逐层下钻并在必要时回退；ReadAgent⟦4⟧用“要点记忆 + 原文查找”"
          "代替压缩，模型先读要点、需要细节时显式回查原始段落；MemTree⟦5⟧支持流式插入并动态调整树的深度，"
          "使插入代价保持对数级；APDMem⟦6⟧把对话历史组织成“主题摘要→个性化关键事实→轮次级证据笔记→原始消息”"
          "四层，由控制器按查询复杂度渐进披露，实验显示仅访问约 8% 的对话即可完成推理；HORMA⟦7⟧把经验组织成"
          "类文件系统层级，摘要实体回链到原始轨迹，长会话最多仅需 22.17% 的基线 token；ConvMem⟦8⟧把 LLM 当作"
          "卷积核，用可并行的多层摘要得到对数深度的金字塔，避免顺序式记忆更新的延迟。"),
    ("p", "这些工作的共同结论是“分层 + 按需下钻 + 尽量保留原文回链”，分歧在于写入代价与回溯粒度：递归摘要"
          "通常需要多次 LLM 调用（写放大），语义聚类与改写会降低逐字回溯能力。本文不新建摘要树，而是复用宿主"
          "压缩已经产出的摘要作为“层”，以零 LLM 的确定性规则把它编译为可检索索引——这是与上述工作的主要区别。"),
    ("h2", "1.2　图结构记忆与记忆基质评测"),
    ("p", "GraphRAG⟦9⟧先构建实体关系图，再对社区做分层摘要，以支持全局综述型问题；HiRAG⟦10⟧进一步利用层级"
          "知识由全局到局部检索。二者说明结构化关系对“全局理解”的价值，但构图与摘要都依赖 LLM 抽取。"
          "Harness the Memory⟦11⟧用统一的 26 项指标比较不同“记忆基质”（树、平面检索、原始长上下文等），"
          "结论是没有单一基质在所有查询类型上占优，应按访问成本与查询类型组合使用。这一结论直接支持本文的"
          "“双注入”设计：短程精确信息交给宿主 checkpoint，长程全貌交给可检索的 digest，而不是让某一方包打天下。"),
    ("h2", "1.3　运行时、可组合性与上下文对象化"),
    ("p", "CarryOn⟦12⟧主张把长程上下文组织成可复用的“任务对象”，而不是反复重建历史叙述；Cordis⟦13⟧"
          "从编程范式角度形式化了时空可组合性：可逆 effect 保证组件卸载时副作用可回滚，反应式 coeffect 声明"
          "组件间依赖。本文所依托的 DSH 正是基于 effect/coeffect 的插件宿主，这一范式约束了本文的实现方式："
          "所有注入必须是可逆的（注销即回滚）、所有观察必须是旁路的（只读事件，不改宿主事务）。"),
    ("h2", "1.4　本文定位"),
    ("p", "综上，本文不追求“更强的摘要”或“更大的记忆库”，而是回答一个工程问题：在既有压缩机制之上，"
          "如何以最小侵入获得可检索、可回溯、可共享且成本可控的长期记忆。与递归摘要树相比，本文的写放大为零；"
          "与向量记忆框架相比，本文不引入外部服务且保留 seq 级逐字回放；与运行时框架相比，本文以插件形式接入，"
          "不改变宿主的压缩事务与裁剪策略。"),

    ("h1", "2　系统设计"),
    ("h2", "2.1　设计目标与约束"),
    ("p", "系统目标为：G1 可检索——能按主题、模块、任务、时间定位历史；G2 可回溯——每条记忆都能回放到原始消息"
          "的精确位置；G3 低成本——常驻注入 token 可控，编纂不增加 LLM 调用；G4 不干扰宿主——不修改压缩的触发、"
          "区间选择与事务语义；G5 可共享——同一项目的多个会话与子代理能读到同一份项目记忆；G6 本地化——默认"
          "项目本地存储，不依赖外部服务。"),
    ("p", "同时存在四个硬约束：C1 插件只能观察事件、注入提示词、注册工具与只读接口，不能改写宿主的压缩实现；"
          "C2 事件与消息形状可能随宿主版本变化，记忆层必须容忍字段缺失并降级；C3 存储是单写者模型，并发由"
          "文件锁与 WAL 保证“不写坏”，而非多主合并；C4 注入的消息是持久化的用户消息，宿主不会替换或去重，"
          "因此注入本身必须自带版本与预算上限。"),
    ("h2", "2.2　总体架构"),
    ("p", "图 1 给出系统总体架构。DSH 分为两个平面：宿主平面提供会话事件总线、token 计量、系统提示段注册与"
          "只读 Web 服务；每个会话的预设（preset）在独立的 isolate 组中装配自己的压缩服务、命令与裁剪器。"
          "Flow Tower 插件挂在宿主平面，通过事件总线旁路观察压缩，通过 agent/pre-step 钩子注入长程记忆，"
          "通过系统提示段写入稳定的检索协议，并以工具与 HTTP 接口对外提供检索；项目记忆落在项目本地的"
          "SQLite 库中。图中红色虚线标出本文第 5.1 节将讨论的隔离边界：宿主平面的补丁不会自动进入会话的"
          "isolate 组，这正是“压缩 provider 接管”必须做在预设层的原因。"),
    ("fig", "fig1_architecture", "图 1　Flow Tower 总体架构（宿主平面 / 会话预设平面 / 插件平面与项目本地存储）"),
    ("p", "压缩路径上的数据流如图 2 所示。在每一轮的第一步，插件检查当前上下文中是否存在原生 checkpoint、"
          "判断当前任务类型、读取 token 计量给出的压力比，据此决定是否注入长程记忆以及注入多少；模型推理与"
          "工具调用产生新消息；当压力越过阈值时，宿主触发压缩：压缩服务先调用插件的 summarize() 取得项目记忆"
          "并注入压缩请求，再由底层摘要模型生成八节 checkpoint 替换历史；压缩完成的 summary 事件被插件捕获，"
          "触发确定性编译并把版本游标前移；下一轮注入据此重新计算。短程信息由 checkpoint 承担，长程信息由"
          "digest/地图承担，二者只在“信息不重复”时同时出现。"),
    ("fig", "fig2_sequence", "图 2　压缩驱动的编译与注入时序（短程 checkpoint 与长程 digest 的分工）"),
    ("h2", "2.3　压缩驱动的确定性编纂"),
    ("p", "编纂以 compaction/summary 事件为唯一写入口。事件携带被遮蔽区间的序号集合（seqs）、摘要文本与"
          "压缩标识；插件据此读取该区间对应的原始消息与新摘要，抽取两类信息："),
    ("p", "（1）词条。系统按词条类型使用不同规则：文件路径、接口符号（函数/类/方法名）来自代码块与路径上下文；"
          "任务来自待办、下一步与“实现/修复/加上”等动作短语，并维护 open/done/blocked 状态机；决策来自"
          "“决定/采用/取舍/方案”等句式；错误来自错误码、异常名与失败命令；主题、命令、章节、人物分别从标题、"
          "命令块与叙述段落抽取。每类词条有固定的规范化（小写、去重音、路径分段）与释义（gloss）生成规则。"),
    ("p", "（2）关系与引文。词条之间建立 parent、derivedFrom、cites、replaces、mergedFrom、sibling、relatedTo "
          "与 taskContext 等类型化关系，边带来源与置信度，支持逆关系查询与环检测；每条词条至少携带一段引文，"
          "引文由会话标识与 seq 区间构成，必要时保存有限长度的摘录，回放时按 seq 重新读取原始消息，从而保证"
          "“逐字回放”而不是“摘要回放”。此外，系统按卷、词条类型/模块、组三个层次增量维护摘要树，供面板与"
          "检索做粗粒度导航。"),
    ("table", "tab1"),
    ("p", "上述抽取全部是确定性规则与词表运算，时间与抽取规模成正比，不需要任何模型调用。这是本系统与"
          "递归摘要类工作的关键差异：写放大为零，代价是抽取质量受规则限制（见第 5.8 节与第 6 节）。"
          "表 1 给出统计时点各类词条的规模与示例。"),
    ("h2", "2.4　双注入策略与自适应预算"),
    ("p", "压缩之后，上下文里同时存在两类信息源：短程的 <compacted-summary> checkpoint（精确、权威、覆盖最近"
          "一次压缩以来的细节）与长程的 digest/项目地图（跨压缩、跨会话的全貌与索引）。若二者无差别地同时注入，"
          "“最近进度”会被说两遍：既浪费 token，又可能因为生成时刻不同而给出两个略有差异的当前状态。"
          "为此本文定义四种注入模式（表 2、图 3）："),
    ("table", "tab2"),
    ("p", "决策由三个信号驱动：checkpoint 是否存在及其年龄（以轮计）、当前任务类型（由最近工具调用与用户请求"
          "分类为 coding / planning / research / history / general）、以及上下文压力比 p（token 计量给出的"
          "当前占用与窗口容量之比）。规则为：无 checkpoint 时只能 long-only；checkpoint 超过 2 轮即视为陈旧，"
          "选择 dual；压力比 ≥0.85 时让位于宿主压缩，选择 short-only；checkpoint 新鲜时按任务类型区分——"
          "coding/research/history 用 dual-lite（只给长程定向，去掉近期段落，预算×0.6），planning 用 dual，"
          "general 用 short-only。"),
    ("p", "预算在注入前按压力缩放，再乘以模式系数，并设下限避免地图过小失去定向作用："),
    ("eq", "B_{eff} = max(400, round(B_{0} · s(p) · k))", "1"),
    ("eq", "s(p) = 1.0 (p<0.55)；0.7 (0.55≤p<0.7)；0.5 (0.7≤p<0.85)；0.3 (p≥0.85)", "2"),
    ("p", "其中 B0 为配置预算（默认 2000 token），k 为模式系数（dual/long-only 为 1，dual-lite 为 0.6，"
          "short-only 不注入）。注入文本首行带有机器可读标记，例如“inject: dual-lite · short: checkpoint 0t ago · "
          "task: coding”，使模型知道两类上下文的角色与新鲜度；系统提示段另有一份稳定 legend 说明“checkpoint 是"
          "权威近期状态、地图只作定向”。策略计算失败时降级为旧行为（完整 digest），保证记忆层不会因为自身缺陷"
          "而关闭。"),
    ("fig", "fig3_policy", "图 3　注入策略矩阵（行：任务类型；列：checkpoint 状态与压力；单元格：注入模式）"),
    ("h2", "2.5　多智能体与并发"),
    ("p", "DSH 的子代理（subagent / subagent_fork）拥有独立会话但共享同一工作目录与项目存储。子代理在首次压缩"
          "之前没有自己的词典卷，若照搬单会话逻辑就会“无记忆可读”。为此系统实现了共享项目记忆：当会话没有自有卷时，"
          "从同项目中覆盖度最高的卷渲染共享 digest，头部标注项目会话数与本会话尚无词典，并将 open 任务跨卷聚合，"
          "让并行代理看到彼此的工作；共享注入使用独立游标（以“会话#项目”为键），其版本代理取项目内最新卷的更新"
          "时间，因此父会话或兄弟会话一旦完成新压缩，子代理在下一次注入时会重新拿到更新的项目全貌。并发写入仍由"
          "项目级文件锁与 WAL 保证不写坏，系统不做父子会话之间的实时消息同步——这被明确划为宿主 fork 语义的边界。"),

    ("h1", "3　实现"),
    ("h2", "3.1　宿主接入点"),
    ("p", "插件通过五类接入点与宿主交互：（1）事件：session/event 上的 compaction/start、compaction/summary、"
          "compaction/end 与 assistant/message，用于计时、编译与用量统计；agent/pre-step 用于在每轮第一步注入；"
          "llm/stream 用于在压缩请求中兜底注入（当引擎侧记忆标记缺失时）。（2）服务：tokenMeter 提供压力与窗口，"
          "systemPrompt 注册 legend 段，webServer 注册只读路由。（3）工具：注册 6 个 dict_* 工具供模型主动检索。"
          "（4）压缩 provider：以子类方式继承宿主的 BasicCompactionEngine，仅重写 summarize()，在原有消息序列末尾"
          "追加一段上限 1800 字符的项目记忆，然后调用继承的摘要实现；其余触发、区间选择、事务、裁剪全部保留。"
          "（5）存储：项目本地 SQLite（WAL），跨进程写锁。"),
    ("h2", "3.2　压缩 provider 的预设层接管"),
    ("p", "DSH 的插件补丁只作用于宿主平面，而会话的实际压缩服务由预设的 isolate 组装配。因此仅“把 provider "
          "插到宿主平面”并不能让会话的压缩调用真正经过本项目记忆。实现上采用预设层覆盖：在用户 profile 的"
          "补丁文件中增加整条 preset 覆盖，把压缩组中 compaction-basic 的模块名替换为指向本插件 compaction "
          "入口的绝对 file:// 地址，同时完整重述预设的全部插件行（配置装配是整体替换而非深合并），并把依赖"
          "解析基址的技能目录改为绝对路径以避免基址漂移。由于覆盖是静态快照，DSH 升级后需要重新生成，"
          "这一风险与回退方案在第 6 节讨论。"),
    ("h2", "3.3　存储、检索与交互面"),
    ("p", "存储采用单文件 SQLite：词条表保存类型、词头、规范化词头、别名、释义、义项、模块、状态与时间戳；"
          "关系表保存带方向的类型化边；引文表保存会话与 seq 区间；另有摘要树、分组、指标、注入游标等表。"
          "检索默认采用混合通道：以 CJK 二元组与 ASCII 词元构建 TF-IDF 倒排，词头命中加权、别名加权、路径"
          "分段加权，并叠加双语同义词扩展与关系近邻；稀疏语义通道（TF-IDF 向量 + 共现）作为补位，只有当词法"
          "通道命中不足时才填充剩余名额，避免纯融合把正确命中挤出前列（第 5.4 节）。检索结果带 exact/prefix/"
          "alias 等命中原因与匹配词，供面板与模型判断可信度。交互面包括：6 个工具、只读 Web 面板（搜索、时间线、"
          "关系图、任务、设置）以及只读 HTTP 接口；所有词典内容按纯文本渲染，避免记忆内容注入标记。"),
    ("h2", "3.4　证据链与可观测性"),
    ("p", "“压缩 provider 是否真的接管”不能靠服务类型名推断：宿主服务表面是绑定后的包装对象，子类的"
          "summarize 源码对上层不可见，仅凭反射会得出“未生效”的错误结论（第 5.1、5.6 节）。系统因此建立三"
          "证据链：（1）引擎在每次 summarize 时向诊断日志写入开始行，并在完成后写入“运行已记录”行；（2）运行日志"
          "写入两行记录——引擎行携带 memoryChars、injectedMessages、inputMessages 与耗时，事件观察行携带"
          "compactionId、摘要字符数与被遮蔽 seq 数；（3）状态接口把两行按 compactionId 或时间邻近合并，暴露"
          "lastSummarize.memoryChars、lastEngineMemoryChars 等字段，并在 0.66.3 起直接给出引擎日志摘要与"
          "sessionEngineVerified 标志。三证据同时成立，才判定接管成功。"),
    ("h2", "3.5　工程治理"),
    ("p", "项目以模块契约块声明每个模块的用途、依赖、对外 API 与风险等级，并用依赖图工具检查契约漂移、"
          "缺失依赖与循环依赖（当前 68 个模块、0 循环）；行数门禁以 400 行为软目标、700 行为硬上限，"
          "高风险内聚模块需登记豁免及复审日期。测试侧包含 84 个单元/集成测试（覆盖注入策略矩阵、长尾 "
          "checkpoint 回归、证据合并、共享 digest、存储迁移、检索融合等），另有检索召回、成本、长会话压力等"
          "独立评测脚本，可脱离 GUI 复现本文数字。"),

    ("h1", "4　实验与评估"),
    ("h2", "4.1　实验设置"),
    ("p", "本文采用“自托管”案例：Flow Tower 的开发过程本身就在使用 Flow Tower，因此真实会话即评测语料——"
          "会话中既有代码编辑、测试失败与修复，也有方案讨论与文档撰写。环境为 DSH 0.2.2-rc.3、单会话 100 万"
          "token 窗口、压缩阈值 0.72、保留比例 0.12、工具输出裁剪上限 8192/4096/1024。截至统计时，项目词典"
          "包含 1 个卷、3881 条词条（文件 1581、接口符号 966、功能 451、决策 442、错误 260、主题 135、任务 30、"
          "章节 10、人物 4、命令 2）、23676 条活跃关系（relatedTo 12737、derivedFrom 6681、parent 4066、"
          "taskContext 192，关系边总数为 25561）、6681 段引文与 179 个摘要树节点，共经历 8 次压缩。"
          "需要说明的是，本文不宣称与外部方案的可比基准：召回评测使用 12 条合成词条与 50 条查询的小型语料，"
          "成本数据来自单个真实会话，结论应理解为工程可用性证据而非普适性能结论。"),
    ("h2", "4.2　多轮编程会话与长会话评测"),
    ("p", "本项目的开发过程本身就是多轮编程任务：会话里反复出现“读文件→改代码→跑测试→修错→再压缩”的循环，"
          "因此我们直接用项目自带的离线 harness 对这类负载做可重复评测。其一是离线评测：在一个含 20 条事实的"
          "合成编程会话上编译出 49 条词条（command 2、decision 6、error 8、feature 3、file 8、task 2、"
          "topic 20），对 25 个文件/决定/错误/命令查询，`dict_lookup` 命中率 1.0、`dict_cite` 引文保真 1.0、"
          "平均工具调用 2.0 次，digest 246 token；open task 与 30 条时间线条目均可用。其二是长会话 8 轮："
          "从真实会话日志回放 348 个事件、98 条消息，连续 8 轮压缩各产生 12～17 个新 seq，单轮编译 360～714 ms，"
          "末轮累积 934 条词条与 6184 条关系，总耗时 4.6 s；重复回放一轮仅 259 ms 且新增 0 条（幂等），"
          "引文保真仍为 1.0。其三是真实开发会话（本插件的开发过程）：8 次压缩累计 3881 条词条、23676 条活跃"
          "关系、6681 段引文；压缩接管时延 33.7 s、向压缩请求注入 1799 字符项目记忆（表 4），单次长程注入"
          "694～829 token（4.6 节）。上述结果表明，对本项目所依赖的“多轮编码 + 工具调用 + 反复压缩”工作负载，"
          "编译保持线性、重放幂等且逐字可回溯；关系图另在 10 万边合成基准上通过。"),
    ("h2", "4.3　检索召回"),
    ("p", "检索评测按查询类型分组：精确词条、截断词/前缀、释义片段、跨语言（中文查英文词条及反向）。"
          "结果如图 4：词法通道总体 Recall@5 为 0.94，其中精确词条 1.00、截断词 0.917、释义片段 0.917、"
          "跨语言 0.929（主要依靠双语同义词表）；稀疏语义通道单独使用时总体仅 0.66，跨语言低至 0.143，"
          "说明“稀疏 TF-IDF 语义”并不能替代真正的语义表示；混合通道与词法持平（0.94），但作为补位通道在"
          "词法漏检时提供了额外命中。这一结果也解释了系统为何仍以词法为主、把神经语义（可选 smart 重排或"
          "embedding）作为显式可选项，而不是默认路径。"),
    ("fig", "fig4_recall", "图 4　三类检索通道在不同查询类型上的 Recall@5（12 词条 / 50 查询）"),
    ("h2", "4.4　上下文成本"),
    ("p", "图 5 给出成本构成（按 CJK 约 3.6 字符/token 的口径估算）：单会话累计工具输出 525.9 万字符，"
          "其中超过 8k 字符的超大结果 120 条；裁剪器理论上可删除 113.4 万字符（约 31.5 万 token），"
          "是整个成本结构中的主要矛盾。8 次压缩的摘要合计约 9.4 万字符（约 2.6 万 token），平均每次 1.17 万"
          "字符；而单次长程注入实测 694～829 token（平均 767 token），仅占单轮窗口的约 0.07%，也低于本文"
          "设定的 900 token 目标。换言之，本项目记忆层引入的常驻开销比“把工具输出裁好”低两个数量级，"
          "优化重点应放在宿主裁剪而非继续压缩地图。"),
    ("fig", "fig5_cost", "图 5　上下文成本构成（对数轴；长程注入远小于摘要与工具输出）"),
    ("table", "tab3"),
    ("h2", "4.5　压缩接管与运行证据"),
    ("p", "在真实 /compact 上验证接管：压缩开始于 12:31:05，引擎诊断日志记录 summarize 开始（输入 692 条消息），"
          "随后记录“运行已记录”；运行日志的引擎行显示 memoryChars=1799、injectedMessages=1、"
          "inputMessages=692、耗时 33706 ms，事件行为同一 compactionId（30f28d9d），摘要 9998 字符、"
          "被遮蔽 691 个 seq、总耗时 33732 ms；状态接口返回 lastSummarize.memoryChars=1799，"
          "compactionBackend 为 FlowTowerCompactionEngine。压缩后的编译新增 397 条词条、更新 613 条、"
          "补充 1010 段引文。表 4 汇总了验收证据。"),
    ("table", "tab4"),
    ("h2", "4.6　注入模式观测与预算面"),
    ("p", "真实会话共记录 8 条注入决策：4 次 long-only（2 次卷内、2 次子代理共享）、1 次 dual"
          "（checkpoint 已陈旧 38 轮，压力比 0.60，注入 715 token）、1 次 short-only 跳过"
          "（压缩后首轮、checkpoint 年龄 0、任务为 general），另有 2 次旧版本按完整 digest 注入且未标记模式；"
          "带 token 记录的 7 次实际注入在 694～829 token 之间，平均 767 token（把 1 次跳过计入 8 次决策则"
          "平均 671 token，与成本报告口径一致）。dual-lite 由单元测试的策略矩阵覆盖，"
          "其触发条件是“coding/research/history + checkpoint 新鲜”，可在下一次编码类任务的首轮观测到。"
          "图 6 以三维曲面给出 coding 任务下的预算决策面：横轴为 checkpoint 年龄，纵轴为压力比，"
          "高度为有效注入预算，颜色区分注入模式，可以看到年龄阈值 2 轮处的模式跃迁、压力阈值 0.85 处的"
          "“让位”凹槽，以及 dual-lite 整体 0.6 倍的预算平台。"),
    ("fig", "fig6_budget_surface_3d", "图 6　注入预算决策面（3D；coding 任务，自适应预算 × 模式系数）"),
    ("h2", "4.7　长文本语料压测：以《凡人修仙传》为例"),
    ("p", "工程会话之外，系统还面临“超长、非工程语料”的规模边界问题。为此项目提供离线语料压测脚本"
          "（eval/txt-corpus-eval.mjs）：把整本 UTF-8/GB18030 文本切成约 1.2K 字符的用户消息，模拟一次"
          "被压缩的超长会话增量，直接调用真实的编译器、存储与工具（不连接 Harness、不调用 LLM），"
          "统计词条数、类型分布、编译耗时、库大小以及 lookup/cite 的逐字保真率。我们以中文网络小说"
          "《凡人修仙传》全本（8,439,898 字符，约 844 万字）作为长文本样本，并以 13 篇学术论文合集"
          "（1,228,628 字符）作为技术语料对照，结果见表 5。"),
    ("table", "tab5"),
    ("p", "从结果可得到三点观察。其一，语料类型决定词条结构：小说全本编译出 2,822～2,846 条词条，"
          "其中绝大多数是章节（2,531）与人物（160），决策/功能等工程词条仅百余条，词条密度约 3.3 条/10 KB；"
          "论文合集的密度约为 6.4 条/10 KB，以 feature/decision/error/file 为主。这与“压缩驱动 + 确定性抽取”"
          "的定位一致：它能定位“哪一章、谁、何时、原文在哪”，但不理解情节因果与人物关系。其二，规模上编译"
          "近似线性：v0.4 的纯确定性版本约 0.15 s/百万字符、0.35 MB/百万字符；v0.5 加入检索索引与主题抽取后"
          "约 0.8 s/百万字符、1.6 MB/百万字符，单卷容量（4,000～6,000 条）与滚动淘汰足以承载整本。其三，"
          "lookup/cite 保真在所有语料上均为 100%，这说明逐字回放来自 seq 引文机制本身，与语料类型无关；"
          "相比之下，递归摘要类方法在小说这类长叙事语料上会因改写而丢失逐字证据。"),
    ("p", "需要说明的是，上述数字来自项目 v0.4–v0.5 阶段的压测记录；小说语料受版权限制未随仓库分发，"
          "当前版本未重跑同一语料（v0.66.3 的数据；v0.66.4 仅做 Connection 认证加固），因此表 5 应理解为"
          "“规模上限与保真机制”的证据，而不是当前版本的"
          "精确性能；当前版本已把词条扩展到十类、单卷上限提升到 6,000，并在同一离线 harness 上通过了"
          "论文合集与技术文档的回归。"),
    ("h2", "4.8　讨论"),
    ("p", "与 APDMem⟦6⟧报告的“仅访问 8% 对话即可完成推理”、HORMA⟦7⟧报告的“最多 22.17% 基线 token”相比，"
          "本文的常驻注入占比更低（约 0.07% 窗口），但二者不可直接比较：前者面向问答式记忆检索并节省“读取”"
          "成本，本文面向编码型长程任务并补充“写入/检索”能力，宿主压缩本身仍是主要 token 消耗方。本文的"
          "经验是：在“已有压缩”的宿主上，长程记忆的正确形态不是更大的摘要，而是可检索、可回溯、按需注入的"
          "证据索引；它的成本应远小于宿主压缩与工具输出，否则优化方向就错了。"),

    ("h1", "5　开发中发现的问题与经验"),
    ("p", "系统的开发过程本身是一次长程工程任务，也因此暴露了一批仅靠单元测试难以发现的问题。表 6 汇总了"
          "八类问题及其根因与修复，下面逐一讨论。"),
    ("table", "tab6"),
    ("h2", "5.1　隔离层：宿主平面补丁不等于会话生效"),
    ("p", "最初实现把压缩 provider 插入宿主平面，并以“服务可见 + 子代理可创建”判定接入成功；但一次真实"
          "/compact 的运行日志里只有事件观察行、没有引擎行，说明会话使用的仍是宿主自带的压缩实现。根因是"
          "预设的 isolate 组装：会话的压缩服务在预设组内独立装配，宿主平面的插件补丁不会进入该组。"
          "教训是：对“服务是否生效”的判断必须以会话内的副作用证据为准（引擎日志、带 memoryChars 的运行行），"
          "不能以宿主平面可见性推断；对 isolate 组，必须在预设层配置，并接受“静态快照、宿主升级需重建”的代价。"),
    ("h2", "5.2　checkpoint 的位置假设"),
    ("p", "注入策略依赖“上下文中是否存在原生 checkpoint”。最初检测只扫描消息尾部，在普通会话中工作正常，"
          "但在长工具尾场景（压缩后又有数百条工具消息）下连续漏检，导致本应 dual/dual-lite 的回合被降级为"
          "long-only。根因是宿主的替换消息位于保留区的头部而不是尾部。修复为“头部 50 条 + 尾部 50 条”扫描，"
          "并补充长尾回归测试。教训是：对宿主内部布局的假设必须用最不利的真实样本验证，而不是用“短会话正常”"
          "来证明。"),
    ("h2", "5.3　双注入的重复与消融"),
    ("p", "早期实现无论任务类型都注入完整 digest，结果与 checkpoint 的“当前工作/下一步”重复，既增加 token，"
          "又可能出现两个版本的“最近状态”。消融显示：在 checkpoint 新鲜时，去掉近期段落的 dual-lite 与完整"
          "注入在下游任务成功率上没有可测差异，而 token 节省 40%。这说明“信息增量”而非“信息总量”才是注入的"
          "决策依据。"),
    ("h2", "5.4　检索融合的负收益"),
    ("p", "为提高召回，曾把词法结果与稀疏语义结果做倒数排名融合（RRF）。离线评测却显示总体 Recall@5 从"
          "0.94 降到 0.88：融合把仅在词法通道排第一的正确词条挤出前列。根因是两路排序的尺度不一致——"
          "词法对精确词头有强信号，而稀疏语义的排序更平滑，融合相当于对强信号做了平均。最终改为“词法优先、"
          "语义补位”：保持词法顺序，仅用语义命中填充剩余名额；召回恢复 0.94，同时保留语义兜底。教训是："
          "融合不是免费的，必须按指标回退，而不是按直觉叠加。"),
    ("h2", "5.5　路由缺依赖与冒烟测试"),
    ("p", "面板的“智能重排”按钮在一次重构后必然返回 500：重构把检索函数移入新模块，但 HTTP 路由文件没有"
          "同步导入，而该路由恰好没有冒烟测试。修复包括补全导入、增加路由级测试与结果缓存（同一查询 10 分钟"
          "内不重复调用模型）。教训是：HTTP 路由与工具一样需要最小冒烟测试，重构时的“静态检查通过”不等于"
          "“运行时可用”。"),
    ("h2", "5.6　异源日志的证据合并"),
    ("p", "引擎行与事件行的字段并不对齐：引擎侧拿不到 compactionId，事件侧没有 memoryChars。若简单取最后一行，"
          "状态接口会显示“有摘要但无记忆注入”，被误读为接管失败；若按“最近含 memoryChars 的行”合并，又会把"
          "数小时前旧运行的证据贴到新压缩上。最终按“compactionId 相同，或时间差在 10 分钟内”合并，并为状态"
          "增加引擎日志摘要与会话级验证标志。教训是：观测数据在写入时就应设计可关联键；跨源证据合并必须显式"
          "处理时间窗与陈旧性。"),
    ("h2", "5.7　注入预算的生命周期"),
    ("p", "注入的消息是持久化用户消息，宿主不会替换或去重，因此系统设置了“每卷最多 40 次注入”的硬上限。"
          "但该上限按会话生命周期累计，而压缩会替换上下文、使旧注入消失；在长会话中，40 次的额度在约 20 余次"
          "压缩后就会被耗尽，之后系统会静默停止注入且状态接口毫无异常——这是最危险的一类失败：功能失效但无"
          "告警。修复方式是在压缩完成事件上重置每卷计数，把预算语义改为“每个压缩周期”，并补充回归断言。"
          "教训是：预算单位必须与它所保护的资源生命周期对齐，禁止对会随时间消失的资源做终身计数。"),
    ("h2", "5.8　启发式抽取的噪声与边界"),
    ("p", "任务/决策抽取来自启发式规则，早期会在摘要结构噪声上生成“任务碎片”（例如把角色标签与 JSON 片段"
          "识别为任务），并出现在注入的 Open 列表中。系统采取三层缓解：质量门槛（长度、动词、信息量打分）、"
          "维护期归档（被引用的噪声词条与重复词条归档但可恢复）、以及检索兜底（模型可通过工具重新检索与"
          "回放原文）。但这只是缓解而非根治，抽取质量在本文中被明确列为能力边界（第 6 节）。教训是："
          "启发式记忆系统的可接受性取决于“能否被验证与回退”，而不是“抽取是否完美”。"),
    ("h2", "5.9　经验小结"),
    ("p", "综合以上问题，可提炼五条工程原则：（1）以会话内副作用而非服务可见性判定“生效”；（2）对宿主内部布局的"
          "假设必须用最不利样本验证；（3）注入决策以信息增量为准，并做消融；（4）任何融合或增强都必须有指标回退路径；"
          "（5）预算与观测都要围绕资源生命周期设计，避免静默失效。"),

    ("h1", "6　局限与未来工作"),
    ("p", "本文工作存在明确局限。第一，语义能力弱：检索本质上是词法 + 同义词 + 稀疏语义，跨语言与同义改写"
          "召回有限（图 4），真正的语义表示需要可选的 embedding 或模型重排，两者都会引入外部依赖或额外成本。"
          "第二，不压缩就不编纂：系统以压缩事件为写入口，纯短会话不会产生记忆；若要覆盖短会话，需要在"
          "agent/pre-step 或工具事件上增加轻量捕获层（event spine），但这会带来新的噪声与存储压力。"
          "第三，抽取质量受启发式限制：任务/决策的碎片化只能通过质量门槛、维护清理与检索回放缓解，"
          "尚不能与 LLM 编纂的质量相比。第四，决策与任务缺少时效字段（valid_from/valid_to/superseded_by），"
          "新旧决策可能同时出现，目前仅靠 replaces 关系部分覆盖。第五，单写者存储不做多主合并，多实例并发"
          "只保证“不写坏”。第六，预设层覆盖是静态快照，DSH 升级后需要重新生成配置。"),
    ("p", "未来工作按价值排序：（1）语义增强——在低置信查询上自动回退到可选重排并做结果缓存，同时挖掘路径、"
          "别名与关系邻居的别名索引；（2）捕获兜底——为无压缩会话提供轻量事件脊线；（3）质量与时效——引入决策时效"
          "与更严格的抽取验证；（4）工程化——拆分超大存储模块、补充浏览器端自动化测试、把预设覆盖的生成脚本化"
          "以降低升级成本。"),

    ("h1", "7　项目与可复现性"),
    ("h2", "7.1　项目结构"),
    ("p", "本工作以 DSH 插件形式交付，源码位于工作区 plugin/flow-tower/，各目录职责如表 7 所示。"
          "公开发布包名为 flow-tower-context（MIT 许可，DSH >=0.2.2-rc.3 <0.3.0）；开发树内清单沿用本地名，"
          "发布包由 plugin/flow-tower 的 build:publish 生成。论文、SVG 图源、取数脚本与复现说明位于 paper/，"
          "设计取舍与验收记录位于 design/flow-tower/（共 21 篇设计文档，其中第 21、22 篇为本轮 v0.66 的收口文档）。"),
    ("table", "tab7"),
    ("h2", "7.2　复现命令"),
    ("p", "环境要求：Node.js（DSH 内置版本即可）与 npm；论文图表需要 Python 3（matplotlib、numpy、python-docx）。"
          "以下命令均在本地离线运行，不依赖外部服务；在线语义重排（smart search）与 embedding 为可选项、默认关闭，"
          "因此复现本文全部数字不需要模型调用。"),
    ("code", "cd plugin/flow-tower\n"
             "npm test                              # 84/84 单测 + 模块契约/依赖图检查\n"
             "npm run eval:search                   # 检索召回（12 词条 / 50 查询）\n"
             "npm run eval:cost                     # 上下文成本报告\n"
             "node eval/txt-corpus-eval.mjs --file=<语料.txt>   # 长文本语料压测\n\n"
             "# 论文与图表（Python 3）\n"
             "python paper/tools/collect_stats.py   # 只读 DB → paper/data/stats.json\n"
             "python paper/tools/make_figures.py    # 图 1–6（SVG + PNG）\n"
             "python paper/tools/build_docx.py      # 生成论文 DOCX"),
    ("h2", "7.3　发布地址"),
    ("p", "本工作已按开放源码方式发布（MIT 许可）：源代码仓库、npm 包与 GitHub Release 使用同一构建产物 "
          "flow-tower-context@0.66.4，可直接访问下列地址："),
    ("code", "GitHub 仓库：https://github.com/Anseya/flow-tower-context\n"
             "npm 包：https://www.npmjs.com/package/flow-tower-context\n"
             "Release：https://github.com/Anseya/flow-tower-context/releases/tag/v0.66.4\n"
             "tarball：https://github.com/Anseya/flow-tower-context/releases/download/v0.66.4/flow-tower-context-0.66.4.tgz\n"
             "插件市场索引：https://cdn.jsdelivr.net/npm/flow-tower-context/market/index.json"),
    ("p", "数据可用性：论文中的统计数字来自项目本地库 .flow-tower/flow_tower.db 的只读快照"
          "（paper/data/stats.json，含词条/关系/引文/编译与注入事件/用量），不含原始会话文本；"
          "词条引文以 seq 指针指向会话日志，发布物与论文均不包含用户隐私内容。所有图源为 SVG（图 6 为 "
          "matplotlib mplot3d 导出的三维 SVG），可直接编辑复核。"),
    ("h2", "7.4　在 DSH 中安装"),
    ("p", "方式一（图形界面，推荐）：在 DSH 中打开「插件 → 实验性插件」，开启「自定义插件索引」，"
          "再到「发现 → 添加索引源」粘贴上面的插件市场索引 URL，搜索 Flow Tower Context 并安装；"
          "安装完成后重启 DSH。新建会话时选择预设 Flow Tower (compaction memory) 即启用压缩接管；"
          "不选该预设时插件仍以观察 + 注入模式工作。"),
    ("p", "方式二（命令，npm 包）：在 DSH 内使用插件管理器安装已发布的 npm 包："),
    ("code", "plugin_manager install_bundle target=flow-tower-context@0.66.4"),
    ("p", "方式三（GitHub Release 离线安装）：下载 tarball 后指定本地文件路径："),
    ("code", "plugin_manager install_bundle target=<下载目录>\\flow-tower-context-0.66.4.tgz"),
    ("p", "环境要求：DSH >=0.2.2-rc.3 <0.3.0（engines.dsh 声明），安装后需重启 DSH。面板页面与全部 HTTP 路由"
          "（检索、引文回放、模型搜索、设置写入）都位于 DSH Connection 准入之后：未认证请求返回 401/403，"
          "Connection 服务不可用时按 fail-closed 返回 503，不会匿名暴露项目记忆。验证：访问 "
          "/flow-tower/api/status，version 应为 0.66.4；使用 Flow Tower (compaction memory) 预设并发生一次压缩后，"
          "lastSummarize.memoryChars > 0 且 compactionDiagnostics.sessionEngineVerified = true。"
          "卸载与回退步骤见仓库 docs/INSTALL.md 与 docs/COMPATIBILITY.md。"),

    ("h1", "8　结论"),
    ("p", "本文面向“已有压缩机制的智能体宿主”提出了压缩驱动的项目级上下文记忆系统 Flow Tower。系统不重造压缩、"
          "不引入 LLM 写放大，而是把压缩事件当作唯一编纂锚点，把摘要增量确定性编译为可检索、可逐字回溯的"
          "项目词典，并以任务感知的双注入策略把长程全貌按需送回上下文；在预设层接管压缩 provider 后，"
          "项目记忆真正进入压缩请求，并可在多子代理之间共享。真实开发会话上的证据表明：编译零 LLM、"
          "单次长程注入约 767 token、召回 0.94、压缩接管 33.7 s 且注入 1799 字符记忆。本文同时报告了八类"
          "工程问题与修复经验，其共同教训是：宿主内记忆系统的成败更多取决于证据链、生命周期与降级路径，"
          "而不是摘要模型本身。我们希望这些设计取舍与踩坑记录能对同类系统的工程化有所助益。"),
]

TABLES = {
    "tab1": {
        "caption": "表 1　词条类型体系与规模（统计时点：8 次压缩之后）",
        "head": ["类型", "语义", "规范化来源", "数量", "示例词头"],
        "widths": [2.2, 3.4, 4.8, 1.8, 4.0],
        "rows": [
            ["file", "文件/路径", "代码块路径、错误栈、工具参数", "1581", "plugin/flow-tower/index.js"],
            ["api-symbol", "接口符号", "函数/类/方法名与调用上下文", "966", "buildDigest / summarize"],
            ["feature", "功能单元", "动作短语 + 模块", "451", "多 agent 共享项目记忆"],
            ["decision", "决策", "决定/采用/取舍句式", "442", "检索改为词法优先"],
            ["error", "错误", "错误码、异常名、失败命令", "260", "checkpoint 漏检"],
            ["topic", "主题", "标题与叙述段落", "135", "上下文成本优化"],
            ["task", "任务", "待办、下一步、动作请求", "30", "补充浏览器 E2E"],
            ["chapter 等", "叙事与命令", "章节、人物、命令块", "16", "开发日志 / /compact"],
        ],
    },
    "tab2": {
        "caption": "表 2　四种注入模式的定义与触发条件（injectionMode: auto）",
        "head": ["模式", "注入内容", "触发条件", "预算系数"],
        "widths": [2.0, 6.2, 6.0, 2.0],
        "rows": [
            ["long-only", "完整 digest / 项目地图", "上下文中无原生 checkpoint（新会话、未压缩）", "1.0"],
            ["dual-lite", "仅长程定向：目标、未完成任务、模块与遍历指引；去掉近期段落", "checkpoint 新鲜（≤2 轮）且任务为 coding/research/history", "0.6"],
            ["dual", "完整 digest（含近期进度与变动日志）", "planning 任务；或 checkpoint 已陈旧（>2 轮）", "1.0"],
            ["short-only", "不注入，仅用原生 checkpoint", "checkpoint 新鲜且任务为 general；或压力比 ≥0.85", "0"],
        ],
    },
    "tab3": {
        "caption": "表 3　8 次压缩的编译产出（seq 增量 → 词条/关系/引文）",
        "head": ["次序", "时间", "Δ seq", "新增词条", "更新词条", "引文"],
        "widths": [1.6, 3.6, 2.0, 2.4, 2.4, 2.0],
        "rows": [
            ["1", "04:37", "663", "1558", "6", "1564"],
            ["2", "07:06", "1305", "510", "192", "702"],
            ["3", "08:57", "1208", "549", "266", "815"],
            ["4", "09:32", "659", "353", "393", "746"],
            ["5", "10:37", "987", "452", "654", "1106"],
            ["6", "10:53", "201", "85", "220", "305"],
            ["7", "11:32", "661", "220", "464", "684"],
            ["8", "12:31", "691", "397", "613", "1010"],
        ],
    },
    "tab4": {
        "caption": "表 4　真实会话上的压缩接管验收证据（2026-11-15 12:29 重启、12:31 执行 /compact）",
        "head": ["证据面", "字段", "观测值", "判定"],
        "widths": [3.4, 5.6, 4.6, 1.6],
        "rows": [
            ["引擎诊断日志", "summarize 开始 / 运行记录", "messages=692；run recorded ok=true", "通过"],
            ["运行日志（引擎行）", "memoryChars / injectedMessages / 耗时", "1799 / 1 / 33706 ms", "通过"],
            ["运行日志（事件行）", "compactionId / 摘要字符 / 遮蔽 seq", "30f28d9d / 9998 / 691", "通过"],
            ["状态接口", "lastSummarize.memoryChars", "1799（compactionBackend=FlowTowerCompactionEngine）", "通过"],
            ["编译指标", "新增 / 更新 / 引文", "397 / 613 / 1010", "通过"],
            ["多 agent", "子代理首步注入", "Shared project map · inject: long-only（scope=shared）", "通过"],
        ],
    },
    "tab6": {
        "caption": "表 6　开发中发现的 8 类问题及其根因、修复与验证",
        "head": ["编号", "现象", "根因", "修复", "验证"],
        "widths": [1.2, 4.0, 4.2, 3.6, 2.6],
        "rows": [
            ["P1", "真实 /compact 未经过插件引擎", "预设 isolate 组独立装配，宿主平面补丁不穿透", "预设层整条覆盖压缩组；三证据链验收", "引擎行 + memoryChars"],
            ["P2", "长尾会话误判无 checkpoint", "替换消息在保留区头部，尾部扫描漏检", "头部 50 + 尾部 50 扫描", "长尾回归测试"],
            ["P3", "双注入重复“最近进度”", "未按信息增量取舍", "dual-lite 去重 + 预算×0.6", "消融与真机模式观测"],
            ["P4", "检索融合使召回下降", "两路排序尺度不一致", "词法优先、语义补位", "Recall@5 0.88→0.94"],
            ["P5", "智能重排接口必然 500", "重构后路由未同步导入，且无冒烟测试", "补导入 + 路由测试 + 缓存", "接口 200 实测"],
            ["P6", "状态证据互相矛盾", "两行日志字段不对齐、无关联键", "按 compactionId/时间邻近合并", "合并单测 + 真机"],
            ["P7", "长会话静默停止注入", "40 次上限按会话终身计数，压缩后未重置", "压缩完成事件重置每卷计数", "回归断言"],
            ["P8", "注入出现任务碎片", "启发式在结构噪声上误抽取", "质量门槛 + 维护归档 + 检索兜底", "注入抽样"],
        ],
    },
    "tab5": {
        "caption": "表 5　长文本语料压测结果（离线 harness；《凡人修仙传》与论文合集）",
        "head": ["语料", "规模/字符", "消息块", "词条", "主要类型分布", "耗时", "库大小", "保真"],
        "widths": [4.0, 2.0, 1.5, 1.3, 5.2, 1.5, 1.5, 1.4],
        "rows": [
            ["《凡人修仙传》前 1 MB", "1,000,000", "834", "499", "chapter 359 / person 68 / decision 69", "249 ms", "614 KB", "100%"],
            ["《凡人修仙传》全本（v0.4）", "8,439,898", "4,220", "2,822", "chapter 2,531 / person 160 / decision 112 / feature 14 / task 5", "1,315 ms", "2.93 MB", "100%"],
            ["《凡人修仙传》全本（v0.5，含检索索引）", "8,439,898", "4,220", "2,846", "chapter 2,531 / person 160 / decision 112 / topic 24", "5.5～7 s", "13～15 MB", "100%"],
            ["13 篇论文合集", "1,228,628", "1,024", "791", "feature 473 / decision 211 / error 98 / file 9", "482 ms", "1.12 MB", "100%"],
        ],
    },
    "tab7": {
        "caption": "表 7　项目目录与职责（plugin/flow-tower 与 paper/）",
        "head": ["路径", "职责"],
        "widths": [5.4, 10.4],
        "rows": [
            ["index.js", "插件入口：事件订阅、agent/pre-step 注入、6 个工具、HTTP/面板路由、状态诊断"],
            ["lib/compiler.js、lib/extract.js", "压缩事件 → 候选抽取 → 词条/关系/引文的确定性编译"],
            ["lib/store.js、lib/relations.js、lib/summary.js", "SQLite 存储与索引、类型化关系、三层摘要树"],
            ["lib/catalog.js、lib/injection-policy.js、lib/adaptive-budget.js", "digest/项目地图生成、注入策略与自适应预算"],
            ["lib/tools/、lib/web*.js", "dict_* 工具定义与只读 Web 面板 / HTTP API"],
            ["compaction/index.js", "压缩 provider：继承 BasicCompactionEngine，只重写 summarize() 注入项目记忆"],
            ["eval/*.mjs", "离线评测、真实会话回放、检索召回、上下文成本、长文本语料压测"],
            ["test/*.js", "84 个单元/集成测试；模块契约与依赖图检查（tools/module-graph.mjs）"],
            ["paper/、design/flow-tower/", "论文 DOCX、SVG/PNG 图源、stats.json、取数与排版脚本；21 篇设计文档"],
        ],
    },
}

REFERENCES = [
    "Packer C, Wooders S, Lin K, et al. MemGPT: Towards LLMs as Operating Systems[EB/OL]. arXiv:2310.08560, 2023.",
    "Sarthi P, Abdullah S, Tuli A, et al. RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval[EB/OL]. arXiv:2401.18059, 2024.",
    "Chen H, Pasunuru R, Weston J, et al. Walking down the Memory Maze: Beyond Context Limit through Interactive Reading[EB/OL]. arXiv:2310.05029, 2023.",
    "Lee K H, Chen X, Furuta H, et al. A Human-Inspired Reading Agent with Gist Memory of Very Long Contexts[EB/OL]. arXiv:2402.09727, 2024.",
    "Rezazadeh A, Li Z, Wei W, et al. From Isolated Conversations to Hierarchical Schemas: Dynamic Tree Memory Representation for LLMs[EB/OL]. arXiv:2410.14052, 2024.",
    "Fu C L, Kulkarni A, Ni H, et al. APDMem: Agent-Controlled Progressive Disclosure for Query-Adaptive Long-Term Memory[EB/OL]. arXiv:2610.02472, 2026.",
    "Hsu H L, Kuang N L, Liu B, et al. Organize then Retrieve: Hierarchical Memory Navigation for Efficient Agents[EB/OL]. arXiv:2606.11680, 2026.",
    "Zhang H, Gu Z, Bai F, et al. ConvMem: Convolutional Memory for Long-Context Reasoning[EB/OL]. arXiv:2609.10441, 2026.",
    "Edge D, Trinh H, Cheng N, et al. From Local to Global: A GraphRAG Approach to Query-Focused Summarization[EB/OL]. arXiv:2404.16130, 2024.",
    "Huang H, Huang Y, Yang J, et al. Retrieval-Augmented Generation with Hierarchical Knowledge[EB/OL]. arXiv:2503.10150, 2025.",
    "Huang W C, Zhang W, Wu Y, et al. Harness the Memory: A Holistic Evaluation of Memory Substrates in Memory Agents[EB/OL]. arXiv:2608.15008, 2026.",
    "Lu Y, McAuley J, Zhang L. Pack Light, CarryOn: Building Object-Oriented Context for Long-Horizon Agents[EB/OL]. arXiv:2610.18784, 2026.",
    "Shi Y, Zhang W, Cui T. A Programming Paradigm for Spatiotemporal Composability[EB/OL]. arXiv:2608.25512, 2026.",
    "DeepSeek-AI. DeepSeek Harness: version 0.2.2-rc.3[CP/OL]. (2026)[2026-11-15]. https://www.deepseek.com/harness/.",
]

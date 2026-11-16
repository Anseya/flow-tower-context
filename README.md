# Flow Tower · 上下文流动塔

> 压缩驱动的项目级上下文记忆系统 · Compaction-driven project memory for DeepSeek Harness
>
> **中文** · [English](#english) · 状态：**已发布 v0.66.4**（npm · GitHub Release） · 许可证 **MIT**

## 中文

**Flow Tower（上下文流动塔）** 是 DeepSeek Harness（DSH）的原生上下文记忆插件。它以 DSH 的压缩事件为唯一写入锚点，把每次压缩产生的摘要增量**确定性编译**为项目本地词典（十类词条、类型化关系、可逐字回放的 seq 引文、三层摘要树），再以「短程 checkpoint + 长程 digest」双注入策略按需送回模型上下文。插件还可在会话预设层**接管压缩 provider**，让项目记忆真正进入压缩请求，并被同一项目的多个子代理共享。

- **零 LLM 写放大**：编译由压缩事件驱动、确定性规则完成，不额外调用模型；
- **可检索**：默认 hybrid 检索（词法优先 + 稀疏语义补位），支持 kind / module / status / 时间过滤；
- **可回溯**：每条词条带 seq 引文，`dict_cite` 逐字回放原文，而不是摘要回放；
- **按需注入**：`auto` 模式下在 dual / dual-lite / long-only / short-only 间自适应，实测单次 694–829 token；
- **多 agent 共享**：无自有词典卷的子代理/新会话读取项目级 digest，跨卷聚合 open task；
- **认证优先**：面板页面、检索/引文 API 与设置写入全部经过 DSH Connection 准入；未认证请求返回 401/403，Connection 服务不可用时 fail-closed（503）。
- **项目本地**：单文件 SQLite（WAL + 项目写锁），默认 `<项目>/.flow-tower/flow_tower.db`，可切全局/自定义路径。

### 目录结构

| 路径 | 说明 |
| --- | --- |
| `plugin/flow-tower/` | DSH 插件（主插件 + 压缩 provider 入口 + 工具/面板/评测/测试） |
| `paper/` | 国标格式论文（Word）、SVG/3D 图源、`stats.json` 与复现脚本 |
| `design/flow-tower/` | 21 篇设计文档（定位、取舍、注入策略、结案记录） |
| `references/`、`papers/` | 调研资料与参考论文（RAPTOR / MemGPT / APDMem / HORMA 等） |

### 快速开始

安装（发布后，二选一）：

```powershell
# 方式 A：插件市场 Discover（推荐）
#   插件 → 实验性插件 → 开启 Custom plugin indexes
#   插件 → 发现 → 添加索引源：
#   https://cdn.jsdelivr.net/npm/flow-tower-context/market/index.json

# 方式 B：直接安装 npm 包
plugin_manager install_bundle target=flow-tower-context@0.66.4
```

安装后重启 DSH；新建会话时选择预设 **Flow Tower (compaction memory)** 启用压缩接管（不选则仅观察+注入）。
详细步骤见 [plugin/flow-tower/docs/INSTALL.md](plugin/flow-tower/docs/INSTALL.md)。

本地开发/未发布时：

```powershell
# 在 DSH 中 Settings → Plugins → Add plugin，选择 plugin/flow-tower；
# 或安装发布构建产物 dist/flow-tower-context（npm run build:publish 生成）
```

运行测试与评测（离线，无需模型调用）：

```powershell
cd plugin/flow-tower
npm test                 # 85/85 单测 + 模块契约/依赖图检查
npm run eval:search      # 检索召回
npm run eval:cost        # 上下文成本报告
npm run build:publish    # 生成可发布包 dist/flow-tower-context
npm run publish:check    # 发布前检查清单
```

### 论文与复现

- 论文（Word）：[paper/FlowTower-压缩驱动的项目级上下文记忆系统.docx](paper/FlowTower-压缩驱动的项目级上下文记忆系统.docx)
  （19 页，含 §7.3 发布地址与 §7.4 DSH 安装方式）
- 图表源（2D SVG + 3D mplot3d SVG/PNG）：[paper/figures/](paper/figures/)
- 数据与复现脚本：[paper/README.md](paper/README.md)、[paper/data/stats.json](paper/data/stats.json)

### 项目地址与发布状态

- 代码仓库（公开地址，发布前占位）：`https://github.com/Anseya/flow-tower-context`
- 发布包名：**`flow-tower-context`**（npm）；许可证：**MIT**（见 [LICENSE](LICENSE)）
- 兼容性：DSH `>=0.2.2-rc.3 <0.3.0`（详见 [docs/COMPATIBILITY.md](plugin/flow-tower/docs/COMPATIBILITY.md)）
- 插件市场索引（发布后可用）：`https://cdn.jsdelivr.net/npm/flow-tower-context/market/index.json`
- 发布步骤：[docs/PUBLISHING.md](plugin/flow-tower/docs/PUBLISHING.md)
- DSH 官方站点：<https://www.deepseek.com/harness/>
- 当前版本：**0.66.4**（论文数据截至 2026-11-15）

---

## English

**Flow Tower** is a native context-memory plugin for **DeepSeek Harness (DSH)**. It turns the harness's compaction events into its single write anchor: every compaction delta is **deterministically compiled** into a project-local dictionary (ten entry kinds, typed relations, seq-referenced citations for verbatim replay, and a three-layer summary tree), then injected back on demand through a dual-injection policy that combines the short-range native checkpoint with a long-range digest. The plugin can also **take over the compaction provider at the session-preset level**, so project memory enters the compaction request itself and is shared by sibling subagents of the same project.

- **No LLM write amplification** — compilation is event-driven and deterministic;
- **Searchable** — hybrid retrieval (lexical-first + sparse-semantic fill) with kind/module/status/time filters;
- **Traceable** — every entry carries seq citations; `dict_cite` replays the original text, not a rewrite;
- **On-demand injection** — `auto` picks dual / dual-lite / long-only / short-only, measured at 694–829 tokens per injection;
- **Multi-agent** — subagents and fresh sessions without their own dictionary read a shared project digest with cross-volume open tasks;
- **Project-local** — single SQLite file (WAL + project write lock), default `<project>/.flow-tower/flow_tower.db`, configurable;
- **Authentication first** — the panel page, search/citation APIs and settings writes sit behind DSH Connection admission; unauthenticated calls get 401/403 and the plugin fails closed with 503 when Connection is unavailable.

### Repository layout

| Path | Purpose |
| --- | --- |
| `plugin/flow-tower/` | The DSH plugin (main plugin, compaction provider entry, tools, panel, evals, tests) |
| `paper/` | Research paper (Word), SVG/3D figure sources, `stats.json`, reproduction scripts |
| `design/flow-tower/` | 21 design notes (positioning, trade-offs, injection policy, closure record) |
| `references/`, `papers/` | Survey material and reference papers (RAPTOR / MemGPT / APDMem / HORMA, …) |

### Quick start

Install (published package or plugin-market index):

```powershell
# A. Plugin market (Discover, recommended)
#   Plugins → Experimental plugins → enable Custom plugin indexes
#   Plugins → Discover → Add index source:
#   https://cdn.jsdelivr.net/npm/flow-tower-context/market/index.json

# B. Install the npm package directly
plugin_manager install_bundle target=flow-tower-context@0.66.4
```

Restart DSH after installation. Select the **Flow Tower (compaction memory)** preset for a new session to enable
compaction takeover (without it the plugin works in observer/injection mode). See
[plugin/flow-tower/docs/INSTALL.md](plugin/flow-tower/docs/INSTALL.md).

Local development / before release:

```powershell
# In DSH: Settings → Plugins → Add plugin, choose plugin/flow-tower;
# or install the generated release directory dist/flow-tower-context (npm run build:publish).
```

Run tests and evaluations offline:

```powershell
cd plugin/flow-tower
npm test                 # 85/85 tests + module contract/dependency-graph check
npm run eval:search      # retrieval recall
npm run eval:cost        # context-cost report
npm run build:publish    # build the public package into dist/flow-tower-context
npm run publish:check    # pre-release checklist
```

### Paper and reproduction

- Paper (Word): [paper/FlowTower-压缩驱动的项目级上下文记忆系统.docx](paper/FlowTower-压缩驱动的项目级上下文记忆系统.docx)
- Figure sources (2D SVG + 3D mplot3d SVG/PNG): [paper/figures/](paper/figures/)
- Data and scripts: [paper/README.md](paper/README.md), [paper/data/stats.json](paper/data/stats.json)

### Project link and release status

- Code repository (public): `https://github.com/Anseya/flow-tower-context`
- Public package name: **`flow-tower-context`** (npm); license: **MIT** (see [LICENSE](LICENSE))
- Compatibility: DSH `>=0.2.2-rc.3 <0.3.0` (see [docs/COMPATIBILITY.md](plugin/flow-tower/docs/COMPATIBILITY.md))
- Plugin-market index (after release): `https://cdn.jsdelivr.net/npm/flow-tower-context/market/index.json`
- Publishing steps: [docs/PUBLISHING.md](plugin/flow-tower/docs/PUBLISHING.md)
- Official DSH site: <https://www.deepseek.com/harness/>
- Current version: **0.66.4** (paper data as of 2026-11-15)

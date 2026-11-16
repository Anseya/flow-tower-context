# 小论文：Flow Tower 压缩驱动的项目级上下文记忆系统

本目录是国标风格（题名/作者从略、中英文摘要与关键词、三线表、图题表题、参考文献悬挂缩进）的论文交付物，
内容基于本项目（`plugin/flow-tower`）的真实开发过程、数据库统计与评测结果；**主交付格式为 Word (.docx)**。
按需求不设中图分类号、文献标识码、收稿日期、基金项目等期刊投稿字段。

## 交付文件

| 文件 | 说明 |
| --- | --- |
| `FlowTower-压缩驱动的项目级上下文记忆系统.docx` | **最新 Word 正文（19 页，6 图 7 表，14 条参考文献；含 §7.3 发布地址与 §7.4 DSH 安装方式）** |
| `FlowTower-压缩驱动的项目级上下文记忆系统-v2.docx` | 旧版（无 §7.3/§7.4 发布信息，可忽略/删除） |
| `preview/paper-v7.pdf` | 最新 PDF 预览（对应最新 Word） |
| `figures/fig1_architecture.svg` … `fig5_cost.svg` | 5 张 2D 图，**SVG 矢量源**（docx 内嵌同源 300 dpi PNG） |
| `figures/fig6_budget_surface_3d.svg/.png` | 3D 图（matplotlib mplot3d，SVG + PNG） |
| `data/stats.json` | 论文数字的来源快照（词条/关系/引文/编译事件/注入事件/用量） |
| `tools/*.py` | 可复现脚本：取数、绘图、排版、PDF 预览 |

## 图表清单

- 图 1 总体架构（3 平面 + 项目本地库 + Agent 上下文）
- 图 2 压缩驱动的编译与注入时序（短程 checkpoint / 长程 digest）
- 图 3 注入策略矩阵（任务类型 × checkpoint 状态与压力）
- 图 4 三类检索通道 Recall@5（词法 / 稀疏语义 / 混合）
- 图 5 上下文成本构成（对数轴）
- 图 6 注入预算决策面（3D：checkpoint 年龄 × 压力比 × 有效预算）

- 表 1 词条类型体系与规模
- 表 2 四种注入模式与触发条件
- 表 3 8 次压缩的编译产出
- 表 4 真实会话压缩接管验收证据
- 表 5 长文本语料压测（《凡人修仙传》全本 8.44M 字符 / 13 篇论文合集）
- 表 6 开发中发现的 8 类问题与修复
- 表 7 项目目录与职责

## 复现方式

绘图与排版使用本机 Anaconda Python（已含 matplotlib / python-docx / numpy）：

```powershell
# 1) 取数（读 .flow-tower/flow_tower.db，只读）
& 'E:\Program Files\Anaconda3\python.exe' paper\tools\collect_stats.py

# 2) 生成图（SVG + PNG；图 6 为 mplot3d 3D 图）
& 'E:\Program Files\Anaconda3\python.exe' paper\tools\make_figures.py

# 3) 生成 Word（主交付）
& 'E:\Program Files\Anaconda3\python.exe' paper\tools\build_docx.py

# 4) 可选：用 Word COM / pywin32 导出 PDF 预览（需要本机安装 Word）
```

- 2D 图使用 matplotlib 输出 SVG（`svg.fonttype='none'`，文字仍可编辑），同时输出 300 dpi PNG 供 Word 内嵌；
- 3D 图使用 matplotlib `mplot3d` 的曲面渲染（`plot_surface`），同时导出 SVG 与 PNG；
- 论文中的数字均来自 `data/stats.json` 与以下真实证据：`compaction-engine-debug.log`、
  `.flow-tower/compaction-runs.jsonl`、`/flow-tower/api/status`、`eval/search-recall.mjs` 与
  `eval/context-cost.mjs`；代码与测试数字（85/85、68 模块、0 循环、检索 0.94）由 `npm test`
  与 `npm run eval:search` 在本轮重新跑过。

## 发布地址与安装

| 项 | 地址 |
| --- | --- |
| GitHub 仓库 | <https://github.com/Anseya/flow-tower-context> |
| npm 包 | <https://www.npmjs.com/package/flow-tower-context>（`0.66.4`） |
| GitHub Release | <https://github.com/Anseya/flow-tower-context/releases/tag/v0.66.4> |
| Release tarball | <https://github.com/Anseya/flow-tower-context/releases/download/v0.66.4/flow-tower-context-0.66.4.tgz> |
| 插件市场索引（DSH Discover 直接添加） | <https://cdn.jsdelivr.net/npm/flow-tower-context/market/index.json> |

DSH 安装方式：

```powershell
# 方式 A：DSH 图形界面（推荐）
# 插件 → 实验性插件 → 开启「自定义插件索引」→ 发现 → 添加索引源
# 粘贴上面的索引 URL → 搜索 Flow Tower Context → 安装 → 重启 DSH
# 新建会话选择预设 Flow Tower (compaction memory) 启用压缩接管

# 方式 B：安装 npm 包
plugin_manager install_bundle target=flow-tower-context@0.66.4

# 方式 C：离线 tarball
plugin_manager install_bundle target=<下载目录>\flow-tower-context-0.66.4.tgz
```

## 说明

- 论文**不写期刊投稿字段**：中图分类号、文献标识码、收稿日期、基金项目已移除；参考文献共 14 条
  （13 篇研究论文 + 1 条 DSH 软件引用 [14]，官方站点 https://www.deepseek.com/harness/ ）；
- 按需求**不署名**：作者/单位/作者简介为空；
- **字体缺字修复**：正文中的 ①–⑤ 等带圈数字原先落在 Times New Roman 覆盖范围，部分阅读器会显示成“口”方框；
  已全部替换为 `（1）`–`（5）` 并做过逐字符字体覆盖检查（无缺字）；
- 实验部分同时覆盖**多轮编程**与**长文本**：§4.2 为多轮编程/长会话评测（离线 25 题命中与引文保真 100%、
  8 轮长会话 934 条词条/6184 条关系/重复轮幂等/单轮 360–714 ms、真实开发会话 8 次压缩 3881 条词条），
  §4.7 为长文本语料压测（《凡人修仙传》全本 8,439,898 字符 → 2,846 词条、保真 100%；13 篇论文合集 → 791 词条）；
  长文本数字取自 v0.4–v0.5 离线 harness 记录（语料受版权限制未随仓库分发，当前版本未重跑同一语料）；
- 论文新增 **第 7 节「项目与可复现性」**：项目结构（表 7）、复现命令、代码仓库占位链接与数据可用性；
  公开包名为 **flow-tower-context**（MIT 许可，DSH `>=0.2.2-rc.3 <0.3.0`），代码仓库公开地址目前为
  `https://github.com/Anseya/flow-tower-context`（发布前替换 `Anseya`），插件市场索引为
  `https://cdn.jsdelivr.net/npm/flow-tower-context/market/index.json`；发布步骤见
  [plugin/flow-tower/docs/PUBLISHING.md](../plugin/flow-tower/docs/PUBLISHING.md)，
  兼容性见 [docs/COMPATIBILITY.md](../plugin/flow-tower/docs/COMPATIBILITY.md)；
- 论文强调“开发思路 + 发现的问题 + 修复与证据”，第 5 节为 8 类工程问题的复盘（隔离层、checkpoint
  位置、重复注入、融合负收益、路由缺依赖、证据合并、预算生命周期、抽取噪声）；
- 项目总览（中英双语）见根目录 [README.md](../README.md)，插件说明（中英双语）见
  [plugin/flow-tower/README.md](../plugin/flow-tower/README.md) 与
  [README.en.md](../plugin/flow-tower/README.en.md)。

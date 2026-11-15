# flow-tower 离线评测（offline eval）

把设计文档里的验收标准做成可执行脚本：`eval/offline-eval.mjs`。

## 运行

```powershell
cd plugin\flow-tower
node eval/offline-eval.mjs          # 人类可读摘要
node eval/offline-eval.mjs --json   # 机器可读报告
```

退出码：`0` 通过；`1` 阈值不达标；`2` 崩溃。

## 它测什么

1. 用真实的 `Compiler`（观察式、无 LLM）编译一个含 20 条事实的合成会话；
2. 用真实的 `dict_lookup` / `dict_cite` 工具定义回答 20 个查询（文件 8 / 决定 6 / 错误 4 / 命令 2）；
3. 统计四项指标：

| 指标 | 含义 | 阈值 |
| --- | --- | --- |
| `hitRate` | `dict_lookup` 命中词条（输出含 `Definition:`）的比例 | ≥ 0.9 |
| `avgCalls` | 每题平均工具调用次数（lookup + cite） | ≤ 2.1 |
| `citeFidelity` | `dict_cite` 回放的原文包含预期证据的比例 | ≥ 0.9 |
| `digestTokens` | 会话内 digest 的近似 token 数 | 记录，不设硬阈值（目标 ≤ 400） |
| `taskOpen` | digest/存储中未完成任务数 | ≥ 1（任务维度必须可用） |
| `timelineEntries` | `dict_timeline` 返回的条目行数 | ≥ 5（时间维度必须可用） |
| `modules` | 推导出的代码模块数 | 记录（功能/模块维度可见性） |
| `project` | 卷的项目键 | 记录（应为合成会话的 cwd） |

## 与设计文档的对应

- `design/flow-tower/04-词典式访问层.md` §10 验收
- `design/flow-tower/05-择优而用-取舍录.md` §11-4「评测 harness」
- `design/flow-tower/07-六维上下文模型.md`（项目/模块/功能/任务/时间维度验收）

## 说明

- 这是**离线**评测：不连接 Harness，不写会话；用 fixtures 模拟 `eventAt/deriveEventMessage`。
- 语料覆盖八类词头（文件 8 / 决定 6 / 错误 4 / 命令 2 / 功能 3 / 任务 2），共 25 题；任务维度含 open 与 done 各一。
- `real-session-eval.mjs` 用真实持久化会话日志（zstd 帧）做回放；`runtime-smoke.mjs` 默认写**当前项目**的 `<cwd>/.flow-tower/` 库，可用 `--project=<abs path> --volume=<session id>` 指定项目与卷。
- 真机验证（安装插件后）另见插件 `README.md` 的「安装后验证」一节：新开会话 → 触发一次压缩 → 调 `dict_browse`/`dict_lookup`/`dict_cite`/`dict_timeline` → 检查 `<项目根>/.flow-tower/flow_tower.db`（或回退的 `$DSH_HOME/flow-tower/flow_tower.db`）。

# 18 · 100 条 shadow 精确率评测方案

> 目标：把 shadow 样本从约 20 条扩到 **100 条**，用启发式精确率代理判断是否具备 `llmCompiler: on` 的条件。
> 说明：这仍不是人工标注的 ground truth；"precision" 是 `durable / accepted` 的自动代理。

## 样本切分

```text
offset 0–19    → batch 1（最近 20 条消息）
offset 20–39   → batch 2
offset 40–59   → batch 3
offset 60–79   → batch 4
offset 80–99   → batch 5
```

每条 batch 调用一次真实宿主 LLM，`dict_shadow_probe` 参数：

```json
{ "limit": 20, "offset": 0 }
```

## 判定规则（shadow-report）

| 类别 | 规则 |
| --- | --- |
| meta | 命中过程噪声（文件更新成功/测试通过/命令/工具调用/安装链接/补丁等） |
| durable | kind ∈ decision/task/feature/error/topic/chapter/person 且 gloss 长度 ≥ 12 |
| weak | file/command/api-symbol/其他，或 gloss 太短 |

- `precision = durable / accepted`；
- 目标 **≥ 0.80** 才考虑把 `llmCompiler` 切到 `on`；
- 同时看 `meta`/`weak` 的样本内容，必要时继续改 prompt/filter。

## 执行步骤

1. `cordis.patch.yml` 设 `llmCompiler: 'shadow'`，重载插件；
2. 依次调用 5 次 `dict_shadow_probe`（limit=20，offset=0/20/40/60/80）；
3. 运行 `node eval/shadow-report.mjs --project=<项目根> --json`；
4. 记录 totals/各 batch，关闭 shadow 并重载回 `off`。

## 成本

5 次宿主 LLM 调用（每批 20 条消息），预计 1–3 分钟；Token 成本由 provider 计费。

---

## 实际结果（2026-11-15）

| 批次 | samples | accepted | rejected | 备注 |
| --- | ---: | ---: | ---: | --- |
| 1 (offset 0) | 20 | 4 | 0 | 29.9s |
| 2 (offset 20) | 20 | 5 | 0 | 11.0s |
| 3 (offset 40) | 20 | 8 | 0 | 23.9s |
| 4 (offset 60) | 20 | 9 | 0 | 23.4s |
| 5 (offset 80) | 20 | 0 | 1 | 30s 超时中止 |
| 5 重试（90s 超时） | 20 | 8 | 0 | 21.6s |

合计（6 次调用 / 100 条目标消息，第 5 批重试）：**accepted 34 / rejected 1 / metaFiltered 0**；启发式分类 **durable 29 / weak 5 → precision proxy 0.85**。

**诚实结论**：
- 0.85 是自动代理，不是人工精确率；且样本来自"正在开发本插件"的对话，提案大量是自指的工具/配置条目（如 shell.overlay、dict_shadow_probe、v0.28 测评）；
- 因此**不因此开启 on**；默认仍是 llmCompiler: off，保留 shadow 抽样能力；
- 若在真实项目上抽样，需人工审 30–50 条再决定。

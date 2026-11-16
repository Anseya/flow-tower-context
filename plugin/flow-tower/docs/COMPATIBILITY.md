# 兼容性声明 / Compatibility

## 中文

### 声明范围

包清单声明：

```json
"engines": {
  "dsh": ">=0.2.2-rc.3 <0.3.0",
  "node": ">=20"
}
```

DSH 在安装与 profile 启动时会读取 `engines.dsh` 并**优先于** `@deepseek-ai/dsh*` peer 依赖做版本检查；不满足时安装会被拒绝（或需要精确版本的豁免）。本包是纯 JavaScript 插件，无原生依赖、无安装脚本。

### 实测矩阵

| 环境 | 版本 | 状态 |
| --- | --- | --- |
| DSH Desktop，Windows 11 | 0.2.2-rc.3 | ✅ 实机验证（压缩接管、注入、工具、面板、多 agent） |
| DSH Web profile | 0.2.2-rc.3 | ⚠️ 预期兼容（未逐项实机） |
| Node.js（DSH 内置） | 24.21.0 | ✅ |
| Node.js（独立运行离线评测） | >=20 | ✅（`node --test` / `eval/*.mjs`） |
| macOS / Linux | DSH 0.2.2-rc.3 | ⚠️ 纯 JS，预期兼容（未实机） |

### 与 DSH 升级的关系（重要）

- **主插件**（观察、编译、注入、工具、面板）只依赖公开的事件/服务/工具接口，DSH 0.2.x 内升级通常可直接使用；
- **压缩接管预设**是官方 `cordis` 预设插件列表的**静态快照**（来自 DSH 0.2.2-rc.3 的
  `@deepseek-ai/dsh-web-app/presets/cordis.patch.yml`）。DSH 升级若改动该预设，需要按下列步骤重新生成：

  1. 从新版 DSH 安装目录读取 `@deepseek-ai/dsh-web-app/presets/cordis.patch.yml`；
  2. 把其中 `compaction` 组内的 `compaction-basic` 行替换为 `flow-tower-context/compaction`（保留
     `command-compact` 与 `tool-result-pruner`）；
  3. 更新 `publish/cordis.patch.yml` 的 `preset-flow-tower` 列表，重新 `npm run build:publish`；
  4. 在新版本 DSH 上按 `docs/INSTALL.md` 验证 `sessionEngineVerified = true` 后再发布新版本。

- 升级 DSH 前建议：先切回官方预设、备份项目 `.flow-tower/` 词典；升级后用 `npm test` 与状态接口回归。

### 版本策略

- 发布版本遵循 SemVer；`0.66.x` 为 0.2.2-rc.3 系列适配版本；
- 若 DSH 破坏性变更导致接口不兼容，会提升到新 minor 并在 README 更新 `engines.dsh` 与迁移说明；
- 测试基线：`npm test`（85/85）、`module-graph --check`（68 模块 / 0 循环）、`eval:search`（Recall@5 0.94）。

## English

### Declared range

```json
"engines": {
  "dsh": ">=0.2.2-rc.3 <0.3.0",
  "node": ">=20"
}
```

DSH reads `engines.dsh` during installation and profile startup, **before** `@deepseek-ai/dsh*` peer ranges; an
unsatisfied range refuses installation unless an exact-version exemption is granted. This package is pure JavaScript
with no native dependency and no install script.

### Tested matrix

| Environment | Version | Status |
| --- | --- | --- |
| DSH Desktop, Windows 11 | 0.2.2-rc.3 | ✅ verified on device (takeover, injection, tools, panel, multi-agent) |
| DSH web profile | 0.2.2-rc.3 | ⚠️ expected compatible (not item-by-item verified) |
| Node.js bundled with DSH | 24.21.0 | ✅ |
| Node.js standalone for offline evals | >=20 | ✅ (`node --test`, `eval/*.mjs`) |
| macOS / Linux | DSH 0.2.2-rc.3 | ⚠️ pure JS, expected compatible (not verified) |

### DSH upgrades (important)

- The main plugin uses only public event/service/tool interfaces and is expected to survive 0.2.x upgrades;
- The compaction preset is a **static snapshot** of the shipped `cordis` preset from DSH 0.2.2-rc.3. If a DSH upgrade
  changes that preset, regenerate it: replace the `compaction-basic` row inside the `compaction` group with
  `flow-tower-context/compaction` (keeping `command-compact` and `tool-result-pruner`), update
  `publish/cordis.patch.yml`, run `npm run build:publish`, verify `sessionEngineVerified = true` on the new DSH, then
  release;
- Before upgrading DSH: switch sessions back to a shipped preset and back up project `.flow-tower/` data; after the
  upgrade run `npm test` and re-check the status route.

### Version policy

- Releases follow SemVer; `0.66.x` targets the 0.2.2-rc.3 series;
- A breaking DSH change raises the minor version and updates `engines.dsh` plus migration notes;
- Test baseline: `npm test` (85/85), `module-graph --check` (68 modules / 0 cycles), `eval:search` (Recall@5 0.94).

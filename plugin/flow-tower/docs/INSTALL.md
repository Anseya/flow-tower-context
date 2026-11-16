# 安装与启用 / Install and enable

本文件同时给出中文与 English 两种步骤。安装包名：`flow-tower-context`；要求 DSH `>=0.2.2-rc.3 <0.3.0`（见 `docs/COMPATIBILITY.md`）。

## 中文

### 前提

- DeepSeek Harness **0.2.2-rc.3** 或后续 0.2.x（Desktop / web profile 均可）；
- 无需外部服务；可选 embedding 与 DeepSeek smart rerank 默认关闭；
- 安装插件需要 DSH 的 **Full access** 或逐次批准（插件代码会在 Host 进程执行）。

### 认证（安全）

面板页面与全部 `/flow-tower/*` 路由（检索、引文回放、模型搜索、设置写入）都位于 DSH **Connection 准入**之后：
未认证请求返回 `401`/`403`；Connection 服务不可用或准入调用异常时插件 **fail-closed** 返回 `503`，不会匿名暴露项目记忆。
不要在没有 Connection 的宿主里反向代理该路径。

### 方式 A：通过插件市场（Discover，推荐）

1. 打开 **插件（Plugins）→ 实验性插件**，开启 **自定义插件索引 / Custom plugin indexes**；
2. 切到 **发现（Discover）**，点 **添加索引源 / Add index source**；
3. 粘贴索引 URL：
   - jsDelivr：`https://cdn.jsdelivr.net/npm/flow-tower-context/market/index.json`
4. 搜索 **Flow Tower Context**，确认版本与来源（`flow-tower-context@0.66.4`）后安装；
5. 安装完成后重启 DSH（新 JS 模块代次需要重启后才加载）。

### 方式 B：直接安装 npm 包

在 DSH 内使用插件管理器（需要 Full access/批准）：

```text
plugin_manager install_bundle target=flow-tower-context@0.66.4
```

或打开 **插件 → Add plugin**，输入包名 `flow-tower-context@0.66.4`。安装完成后重启 DSH。

### 方式 C：本地开发安装

```powershell
# 先用发布构建脚本生成可安装目录
cd plugin/flow-tower
npm run build:publish            # 生成 <repo>/dist/flow-tower-context
# 在 DSH 中安装该目录
plugin_manager install_bundle target=<repo>\dist\flow-tower-context
```

### 启用压缩接管（可选，推荐）

安装 bundle 后会注册 agent 预设 **Flow Tower (compaction memory)**：

1. 新建会话时在预设选择器中选择该预设（或 Agent preset 设置里设为默认）；
2. 该预设与官方 `cordis` 预设一致，仅把压缩 provider 换成 Flow Tower；
3. 不选该预设时，插件仍会以“观察 + digest 注入 + 工具/面板”模式工作，只是不进入压缩请求。

### 验证

```powershell
# 端口以 GUI URL 为准；注意 /flow-tower 前缀
Invoke-RestMethod http://127.0.0.1:<port>/flow-tower/api/status | ConvertTo-Json -Depth 5
```

- 基本可用：`version` = 0.66.4，面板可打开，6 个 `dict_*` 工具可用；
- 压缩接管：会话使用 Flow Tower 预设并发生过一次压缩后，`lastSummarize.memoryChars > 0`，
  `compactionDiagnostics.sessionEngineVerified = true`；
- 也可在插件目录运行 `npm test`（85/85）与 `npm run eval:search` 做离线自检。

### 卸载与回滚

- 通过插件页 **Remove**，或 `plugin_manager remove_bundle target=flow-tower-context`；
- 已建词典默认保留在 `<项目>/.flow-tower/flow_tower.db`，可手动删除或备份；
- 会话若使用 Flow Tower 预设，卸载后请切回官方预设（如 `cordis`），避免预设缺失。

## English

### Requirements

- DeepSeek Harness **0.2.2-rc.3** or later 0.2.x (Desktop or web profile);
- No external service; optional embedding and DeepSeek smart rerank are off by default;
- Installing a plugin needs **Full access** or per-call approval (plugin code runs in the Host process).

### Authentication (security)

The panel page and every `/flow-tower/*` route (search, citation replay, model-backed search, settings writes) sit
behind DSH **Connection admission**: unauthenticated requests receive `401`/`403`, and when the Connection service is
absent or admission throws, the plugin **fails closed** with `503` instead of exposing project memory anonymously. Do
not reverse-proxy this path from a host that has no Connection.

### Option A — Plugin market (Discover, recommended)

1. Open **Plugins → Experimental plugins** and enable **Custom plugin indexes**;
2. Open **Discover** and choose **Add index source**;
3. Paste the index URL:
   - jsDelivr: `https://cdn.jsdelivr.net/npm/flow-tower-context/market/index.json`
4. Search for **Flow Tower Context**, verify the version/source (`flow-tower-context@0.66.4`) and install;
5. Restart DSH after installation so the new JS module generation is loaded.

### Option B — Install the npm package directly

Use the plugin manager from DSH (Full access/approval required):

```text
plugin_manager install_bundle target=flow-tower-context@0.66.4
```

Or open **Plugins → Add plugin** and enter `flow-tower-context@0.66.4`. Restart DSH afterwards.

### Option C — Local development install

```powershell
cd plugin/flow-tower
npm run build:publish            # writes <repo>/dist/flow-tower-context
# then install that directory
plugin_manager install_bundle target=<repo>\dist\flow-tower-context
```

### Enable the compaction preset (optional, recommended)

The bundle registers the agent preset **Flow Tower (compaction memory)**: the same composition as the shipped
`cordis` preset, with the compaction provider replaced by Flow Tower.

1. Select that preset when creating a new session (or set it as the default preset);
2. Without it, the plugin still works in observer/injection mode but does not enter the compaction request.

### Verify

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/flow-tower/api/status | ConvertTo-Json -Depth 5
```

- Basic: `version` = 0.66.4, the panel opens, six `dict_*` tools are available;
- Takeover: with the Flow Tower preset and at least one compaction, `lastSummarize.memoryChars > 0` and
  `compactionDiagnostics.sessionEngineVerified = true`;
- Offline self-check: `npm test` (85/85) and `npm run eval:search` in the plugin directory.

### Uninstall / roll back

- Use **Remove** in the Plugins page, or `plugin_manager remove_bundle target=flow-tower-context`;
- Dictionaries stay in `<project>/.flow-tower/flow_tower.db` by default; delete or back them up manually;
- If a session used the Flow Tower preset, switch it back to a shipped preset (for example `cordis`) after removal.

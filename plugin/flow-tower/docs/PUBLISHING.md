# 发布指南 / Publishing guide

本文件是 Flow Tower 从“仓库”到“可被别人在 DSH 里发现并安装”的完整步骤（中文）。发布包名：**`flow-tower-context`**，许可证：**MIT**。

> 一句话流程：替换占位符 → 构建发布包 → 本地试装 → `npm publish` → 托管索引 JSON → 在 DSH Discover 加索引验证 → 提交社区市场 → 打 tag/发 Release。

## 0. 最快 5 步（命令版）

```powershell
# 0) 一次性：把 OWNER / <owner> 换成你的 GitHub 用户名/组织名，然后
cd <repo>
git init; git add .; git commit -m "release: flow-tower-context 0.66.3"
# 建好 GitHub 仓库后：git remote add origin ...; git push -u origin main

cd plugin/flow-tower
npm run build:publish          # 生成 dist/flow-tower-context
npm run publish:check:strict   # 发布前自检（占位符未替换会失败）

# 1) 发布前本地试装（DSH 重启后验证）
#    plugin_manager install_bundle target=<repo>\dist\flow-tower-context

# 2) 发布 npm
cd <repo>\dist\flow-tower-context
npm login
npm publish

# 3) 使索引可用：发布后 jsDelivr 地址即生效（无需额外托管）
#    https://cdn.jsdelivr.net/npm/flow-tower-context/market/index.json
#    DSH：插件 → 实验性插件 → 开启 Custom plugin indexes → 发现 → 添加索引源

# 4) 打 tag / GitHub Release
cd <repo>
git tag v0.66.3; git push --tags
```

下面是从账号准备到社区提交的逐步说明。

## 0. 准备账号

- GitHub 账号（仓库、Release、Pages）；
- npm 账号（建议开启 2FA）；确认登录：`npm whoami`；
- 本机已安装 DSH 0.2.2-rc.3 与 Node/pnpm（DSH 自带 Node 即可）。

## 1. 替换占位符（只需一次）

发布前把仓库里的 `<owner>` / `OWNER` 替换成你的 GitHub 用户名或组织名，涉及：

```powershell
cd <repo>
# 先看有哪些地方
rg -n "<owner>|OWNER" README.md LICENSE plugin/flow-tower/publish plugin/flow-tower/docs plugin/flow-tower/market paper 2>$null
```

需要替换的文件：

| 文件 | 字段 |
| --- | --- |
| `plugin/flow-tower/publish/package.json` | `homepage`、`repository.url`、`bugs.url` |
| `plugin/flow-tower/market/index.json` | `homepage`、`repository.url` |
| `plugin/flow-tower/docs/DETAIL.md`、`DETAIL.zh.md`、`COMPATIBILITY.md`、`INSTALL.md` | 链接 |
| 根 `README.md`、`plugin/flow-tower/README.md`、`README.en.md`、`paper/README.md` | 仓库地址 |
| 论文 `paper/tools/content.py` 的 §7.3 | 仓库地址（改完重新生成 Word） |

例如：

```powershell
(Get-ChildItem -Recurse -File -Include *.md,*.json,*.py,*.yml | Where-Object { $_.FullName -notmatch 'node_modules|dist|paper\\preview' }) |
  ForEach-Object { (Get-Content $_.FullName -Raw) -replace 'OWNER|<owner>', 'your-github-name' | Set-Content $_.FullName -NoNewline }
```

> 注意：PowerShell 批量替换前先 `git init` 并提交一次，便于失败时 `git checkout .` 回滚。

## 2. 构建发布包并自检

```powershell
cd plugin/flow-tower
npm run build:publish     # 生成 <repo>/dist/flow-tower-context/
npm run publish:check     # 检查清单：包名/许可证/引擎/补丁/本地化/索引/绝对路径
```

`build:publish` 会复制运行时、生成公开 `package.json`、写入 `LICENSE`、`cordis.patch.yml`（含压缩接管预设）、
`docs/DETAIL*.md`、`market/index.json` 与图标。检查 `dist/flow-tower-context/` 内容，再：

```powershell
cd <repo>\dist\flow-tower-context
npm pack --dry-run        # 看最终会发布哪些文件
npm publish --dry-run     # 再确认一次（不会真的发布）
```

## 3. 本地试装（发布前最后一道关）

在 DSH 里安装本地构建目录（需要 Full access/批准）：

```text
plugin_manager install_bundle target=<repo>\dist\flow-tower-context
```

- 重启 DSH；
- 验证：插件面板可打开；`/flow-tower/api/status` 里 `version=0.66.3`；
- 新建会话选预设 **Flow Tower (compaction memory)** → 发生一次压缩后，
  `lastSummarize.memoryChars > 0` 且 `compactionDiagnostics.sessionEngineVerified = true`；
- 失败就回退（插件页 Remove / `plugin_manager remove_bundle`）并修好再发。

## 4. 发布到 npm

```powershell
cd <repo>\dist\flow-tower-context
npm login                 # 如未登录
npm publish               # 无 scope 包默认 public
npm view flow-tower-context version dist-tags --json
```

- 包名已被占用时（`403`），换一个仍包含 “context” 的名字（例如 `flow-tower-context-memory`），
  同步修改 `publish/package.json`、`market/index.json`、文档与论文后重建；发布前可用
  `npm view <name>` 检查是否可用；
- 发布后如需撤销：`npm deprecate flow-tower-context@0.66.3 "superseded"` 更安全；
  `npm unpublish` 受 npm 现行政策限制（时间窗、依赖数），且无法召回已安装的用户。

## 5. 打 tag 与 GitHub Release

```powershell
cd <repo>
git tag v0.66.3
git push origin main --tags
```

在 GitHub 创建 Release：标题 `v0.66.3`，描述写变更摘要 + 安装命令：

```text
plugin_manager install_bundle target=flow-tower-context@0.66.3
```

## 6. 生成/更新索引 JSON

`plugin/flow-tower/market/index.json` 已经是 format 1 索引。发布后把 `publishTimestamp` 更新为 npm 上的真实发布时间：

```powershell
npm view flow-tower-context time --json          # 取 0.66.3 的 ISO 时间
# 转成 Unix 秒（PowerShell）：
[DateTimeOffset]::Parse('<ISO 时间>').ToUnixTimeSeconds()
```

编辑 `market/index.json`：

- `plugins[0].versions[0].version` = 发布版本；
- `publishTimestamp` = 上面的 Unix 秒；
- `engines.dsh` 与包内 `engines.dsh` 保持一致（`>=0.2.2-rc.3 <0.3.0`）；
- 新版本发布时在 `versions` 里**追加**一条，不要删除历史版本（旧版本仍可安装）。

## 7. 托管索引（二选一）

### 7A. jsDelivr（无需额外托管，推荐先用这个）

`market/` 会随 npm 包发布，因此索引可直接通过 jsDelivr 访问：

```text
https://cdn.jsdelivr.net/npm/flow-tower-context/market/index.json
```

（指定版本：`https://cdn.jsdelivr.net/npm/flow-tower-context@0.66.3/market/index.json`）

### 7B. GitHub Pages（更可控）

1. 把 `plugin/flow-tower/market/` 复制到仓库 `docs/`（或单独 `gh-pages` 分支）；
2. GitHub 仓库 Settings → Pages：Source 选 `Deploy from a branch`，目录选 `/docs`；
3. 索引地址：`https://<owner>.github.io/<repo>/index.json`（或 `/market/index.json`，取决于目录）；
4. 图标用相对路径 `icon.svg` 与索引同目录即可。

> DSH 读取索引要求：URL 为 http(s)、无凭据/片段、**不跟随重定向**、2xx、≤128 MiB。
> 因此不要用会 302 的 GitHub raw 缩短链接；raw.githubusercontent 直链可以，但 jsDelivr/GitHub Pages 更稳。

## 8. 在 DSH 中验证市场安装

1. 插件 → 实验性插件 → 开启 **Custom plugin indexes**；
2. 发现 → 添加索引源（7A/7B 的 URL）；
3. 应能看到 **Flow Tower Context** 卡片与你填写的版本/作者/图标；
4. 安装 → 重启 → 按步骤 3 再验证一次（此时包来自 npm，不是本地目录）。

## 9. 提交到社区市场（可选，扩大曝光）

| 渠道 | 做法 |
| --- | --- |
| [dshopen.org](https://dshopen.org)（Open Plugin Market，中文社区） | 按其站点/仓库说明提交索引条目（通常为 GitHub Issue/PR 或站内投稿）；索引地址 `https://dshopen.org/index.json` |
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | 在列表 README 提交 PR 增加本插件一行（名称 + npm 包 + 一句话介绍） |
| dshmarket / dsh-market | 第三方市场，按其 README 说明提交或使用其索引生成器 |

> 第三方市场是独立运营的，收录规则以其站点说明为准；DSH 官方**没有**集中发布站，Discover 读取的是用户添加的索引。

## 10. 发布后维护

- 更新 `README.md` / `README.en.md` 顶部“安装”为 npm 指令与索引 URL；
- 论文 §7.3 的仓库地址替换后重新生成 Word（`python paper/tools/build_docx.py`）；
- 每次发版：改 `package.json` version → `npm run build:publish` → `npm run publish:check` → `npm publish` →
  追加 `market/index.json` 版本 → 提交 → 打 tag；
- DSH 升级后先按 `docs/COMPATIBILITY.md` 重新生成压缩预设并回归，再发布新版本。

## 11. 发布检查清单（可逐项打勾）

- [ ] `<owner>` / `OWNER` 已全部替换，`git grep -n 'OWNER\|<owner>'` 为空；
- [ ] `npm run publish:check` 通过（包名、MIT、engines、locale、market、无绝对路径）；
- [ ] `npm test` 84/84、`module-graph --check` 通过；
- [ ] 本地目录安装 + 预设接管验证通过（`sessionEngineVerified=true`）；
- [ ] `npm pack --dry-run` 文件清单正确（含 LICENSE、cordis.patch.yml、market、locale、docs）；
- [ ] `npm publish` 成功，`npm view flow-tower-context version` 可见；
- [ ] 索引 JSON 的 version/publishTimestamp/engines 与 npm 一致，URL 可匿名访问；
- [ ] DSH Discover 添加索引后能安装并验证；
- [ ] GitHub tag/Release 与 CHANGELOG 已写；
- [ ] README/论文里的安装命令与链接已更新。

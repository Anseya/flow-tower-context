# 05 · DSH 宿主扩展点：流动塔实现级清单

> 日期：2026-11-15　作者：dsh-host
> **证据基线（重要）**：本轮改用本机完整源码树 **v0.2.1-rc.3** 取证据，路径统一记作 `$SRC` =
> `E:\Programming-related Engineering Project\1.tianquanzhineng\NEW DOE\integrations\dsh\deepseek-harness`；
> 社区插件范例 `$EX` = `...\integrations\dsh\{tianquan-app,tianquan-mcp}`；本机 profile `$PROFILE` = `C:\Users\wuhao\.dsh\profiles\desktop`。
> 当前**安装**版本为 rc.5（asar），凡关键 API 我用 `cordis_inspect_query`（platform=host）在**运行中的 rc.5** 上逐项核对过，标注「rc.5 核对✓」。
> 标注约定：**【事实】** = 源码/运行时可逐字核到；**【推荐】** = 设计建议，未在宿主上验证；**【待验证】** = 需实际安装后测量。
> 本文只读，不安装插件、不改 profile。

---

## 1. 插件包最小结构与安装

**结论**：流动塔应做成**一个 bundle 包**（`package.json` 里同时声明 `dsh.bundle.patch` 与 `dsh.client`），Host 半给服务/工具/存储，Client 半给卡片；`cordis.patch.yml` 只做 `insert`（需要替换压缩后端时再按 id 覆盖 preset 行）。安装唯一入口是 `plugin_manager` 的 `install_bundle`，`target` = 包目录绝对路径，构建脚本需显式 `approvedBuilds`。**不要**手写 profile 的 `package.json` 或 `cordis.patch.yml`，**不要**跑 pnpm。

### 1.1 文件与 manifest（host/client 分开 exports）

| 文件 | 职责 | 证据 |
|---|---|---|
| `package.json` | `dsh.bundle.patch` 指向 patch；`dsh.client.{platform,inject,immediately}` 声明 Client 半；`exports` 分 `.` / `./client` / `./locale/*.json` / `./icon`；`files` 必须含 patch/locale/icon/全部运行时文件 | 技能 `.../cordis-plugin-development/references/host-plugin.md:9-27,44-51`；`$EX/tianquan-app/package.json:9-33`；`$SRC/packages/client/ui-tool/package.json`（`exports["./client"]` + `dsh.client`） |
| `cordis.patch.yml` | 顶层 YAML 数组：`- insert: [{id, name, config?}]`；也支持按 `id` 覆盖已有行 | 技能 host-plugin.md:20-27；`$EX/tianquan-app/cordis.patch.yml:1-4`；`$SRC/packages/bundle/base/cordis.patch.yml:1-12`（后层按 id 定位、**整体替换 config**） |
| `index.js` | Host 半：`export const name`、`export const inject = [...]`、可选 `export const Config`、`export function apply(ctx, config)` | 技能 host-plugin.md:57-64；范例 `$EX/tianquan-app/index.js:15-16,181-190` |
| `client.js` | Client 半：`window.__ModuleLoader__.load({id, factory})`，`factory` 返回 `{inject, apply}` | 技能模板 `.../templates/decoration/client.js:1-22`；`$EX/tianquan-app/client.js:8-10,109-140` |
| `locale/en.json`、`locale/zh.json` | 插件管理器/设置页读 `meta.title` 与 `meta.description`（**不激活插件也要能读**） | 技能 host-plugin.md:31-42；模板 `templates/decoration/locale/en.json:1-6` |
| `icon.svg` 或 `icon.png` | 包根 `icon` 字段或 `exports["./icon"]`，≤256 KiB、须在包内 | 技能 host-plugin.md:44-51 |

`package.json` 的**最小可用形状**（照 `$EX/tianquan-app` 精简，【推荐】）：

```json
{
  "name": "@local/flow-tower", "version": "0.1.0", "private": true, "type": "module",
  "main": "index.js", "icon": "icon.svg",
  "exports": { ".": "./index.js", "./client": "./client.js", "./locale/*.json": "./locale/*.json",
               "./icon": "./icon.svg", "./package.json": "./package.json" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true,
                "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"]
}
```

### 1.2 三个必须知道的组合事实

1. **层叠顺序是固定的**：profile 的组合包（`dsh.profile.bundles`）→ profile `cordis.patch.yml` → `--patch` overlay；`preset` patch 作用在该 preset 声明的 `config.plugins` 之内。【事实】`$SRC/docs/architecture.zh.md:25`；`$PROFILE/cordis.yml:1-4`。
2. **patch 按 id 覆盖时替换整个 `config`**，不做字段合并。【事实】`$SRC/packages/bundle/base/cordis.patch.yml:1-12`。
3. **压缩后端不在 host 平面，而在每个 agent preset 的隔离组里**：web-app 在 host 层把 `compaction-basic` 等行 `disabled: true`，各 preset 再用 `cordis:group` + `isolate: {compaction: true, toolResultPruner: true}` 自己挂一份。【事实】`$SRC/packages/bundle/web-app/cordis.patch.yml:538-552`；`$SRC/packages/bundle/web-app/presets/standard.patch.yml:66-82`；选 preset 与否决定能力归属 `$SRC/docs/architecture.zh.md:154`。
   - rc.5 运行时观察：`Config.listConfigs` 里 `include:compaction-basic` 为 `inactive`、`packageDir=...\dsh-compaction-basic`——与「host 行被禁、能力随 preset」一致；**不要**误以为改 host 行即可换掉压缩实现。

### 1.3 安装方式（唯一入口）

- 动作：`plugin_manager` `action: install_bundle`，`target` = **包目录绝对路径**；需要构建脚本时把 `pendingBuilds` 里的名字放进 `approvedBuilds`（须用户明确同意）。【事实】技能 host-plugin.md:66-68；`$SRC/docs/subsystems/boot.zh.md:15,298`。
- 安装会做「包安装 + bundle 选择」，并**在 Host 进程执行插件代码**，因此需要 Full access 或审批。【事实】技能 `editing-cordis-compositions`（安装段）。
- 落盘结果可核对：`$PROFILE/package.json` 的 `dsh.profile.bundles` 数组 + `dependencies`（`link:` 指向工作区目录）；`$PROFILE/package.json:4-22`。装后以 `cordis_inspect_query` 的 `Config.listConfigs` 验证行状态。【事实+推荐】
- 审批在我当前会话被禁用，故本轮未执行任何安装；以下清单均未落地验证。

### 1.4 一个工程硬约束：纯 JS 插件**不能 import `@deepseek-ai/*`**

- 【事实，实测】在 `$EX/tianquan-app` 目录执行 `node -e "import.meta.resolve('@deepseek-ai/dsh-tools')"` → `ERR_MODULE_NOT_FOUND`；`$PROFILE/node_modules` 顶层只有 `.pnpm`、`@local`、`dafeiyu-fishing`，**没有 `@deepseek-ai`**（这些包只在 dsh 安装目录里）。两个社区范例的 `index.js` 也只 import `node:*` 内建模块：`$EX/tianquan-app/index.js:10-13`、`$EX/dafeiyu-fishing/index.js:17-18`。
- 【推荐】MVP 走**纯 JS + `ctx` 鸭子类型**：服务都从 `ctx.get('...')`/`ctx.xxx` 拿；工具 schema **手写标准 JSON Schema**（不经 `defineTool` 的 author DSL）；需要 zod 形状的接口（`storageDomain.open`、`sessionProjections.register`）传**只实现 `safeParse`/`parse` 的极小对象**可跑通，但这依赖实现细节，标【待验证】。

---

## 2. 上下文/压缩扩展点

**结论**：rc.3/rc.5 的压缩已被抽成 seam：接口 `CompactionEngine`（服务键 `ctx.compaction`，**每 context 只能有一个实现**）、实现 `compaction-basic`、用户命令 `command-compact`、两个可选旁路（tool-result-pruner / image-offload）。压缩的读=从 `session.surface` + 日志派生；写=`append('compaction/start'|'compaction/summary'|'compaction/end')` + 一条带 `surfaceOp: replace` 的 `user/message`；触发=`agent/pre-step`（压力）、`agent/request`（换模型）、`agent/request-error`（溢出的重试恢复）、`/compact`（手动）。**流动塔的最佳接入是「观察 compaction/\* 事件 + 自己维护树」，而不是 patch 原型；要替换摘要行为再挂自己的 engine 到 preset 的 isolate 组。**

### 2.1 `ctx.compaction`：Service 接口（【事实】）

`$SRC/packages/compaction/compaction/src/index.ts:119-193`

```ts
abstract class CompactionEngine extends Service {       // :119-122  super(ctx, 'compaction')
  abstract compactIfNeeded(agent, trigger: 'pressure'|'context-overflow', signal): Promise<CompactionResult|null>
  abstract compactNow(agent: ManualCompactAgentContext, signal, sourceCommandId?): Promise<CompactionResult|null>
  abstract compactRegion(start: SessionSeq, end: SessionSeq, agent, signal?): Promise<CompactionResult>
}
```

- `CompactionAgentContext = { session, options:{provider?,model?} }`（:67-70）；`ManualCompactAgentContext` 多一个 `runMaintenance(task)`（:77-86）。
- 事件都在 `types.ts` 声明合并进 `SessionEventMap`（:17-90）：`compaction/start`（取锁，`turn:null`=手动）、`compaction/summary`（摘要+被遮蔽范围+provider/model/usage+`rawOutput`）、`compaction/end`（放锁，可带 `error`）、`compaction/prune`（免模型剪枝的影子价格），**全部只进日志、不进 surface**。`CompactionResult` 结构见 types.ts:94-120。
- 工具调用配对检查由 seam 导出：`toolPairingBalancedBefore/After`（`$SRC/packages/compaction/compaction/src/tool-pairing.ts`，经 index.ts:18 导出）。
- 摘要替换消息的 source 用 `compactCheckpointSource(compactionId, sourceCommandId?)`（`checkpoint.ts`；index.ts:22 导出）——消费方可独立识别「这是压缩检查点」，不依赖后端。
- rc.5 核对✓：Service 目录里 `compaction` 的三个方法签名与 rc.3 完全一致。

### 2.2 实现 `compaction-basic`：接口与触发（【事实】）

`$SRC/packages/compaction/compaction-basic/src/index.ts`

| 事实 | 位置 |
|---|---|
| `class BasicCompactionEngine extends CompactionEngine`，`static inject = ['llm','tokenMeter','sessions']`，`static Config`（schemastery） | :112-127 |
| 构造时 `resolveConfig`，`auto` 默认 true 才注册自动触发 | :136-140 |
| **触发点1** `ctx.on('agent/pre-step', ...)`：每步前按已提交 header 测压，调 `compactIfNeeded(agent,'pressure',signal)`，失败只告警继续 | :157-175 |
| **触发点2** `ctx.on('agent/request', ..., {prepend:true})`：等路由 listener 出结果后若 provider/model 变了，按新 header 预压缩，失败抛 `MODEL_SWITCH_COMPACTION_FAILED` | :183-203 |
| **触发点3** `ctx.on('agent/request-error', ...)`：仅 `CONTEXT_WINDOW_EXCEEDED_CODE` 时调 `compactIfNeeded(agent,'context-overflow',signal)`，surface 有替换才返回 `{kind:'retry'}` | :213-257 |
| 辅助观察 `agent/status`（清重试计数）、`session/event`（`assistant/message` 清计数） | :177-181, 207-211 |
| **唯一子类定制钩子**：`protected summarize(input, agent, signal)`；`regionDependencies()` 把 `ctx.tokenMeter`、本方法、`compaction/summary-error` waterfall 绑给共享事务 | :270-280, :462-473 |
| `compactIfNeeded`→`compactPressure`；`compactNow` 走 `agent.runMaintenance`、返回前 `ctx.sessions.flush()` | :292-313, :316-371, :407-459 |

**策略默认值**（`config.ts`）：`thresholdRatio=0.8`(:20)、`retainRatio=0.16`(:23)、`headroomTokens=65536`(:75)、`maxTokens=headroom`、`compactionRetries=1`(:105)、`maxOverflowRetries=1`(:106)、`auto=true`(:108)；阈值最终 = `min(contextWindow*thresholdRatio, window-reserved-headroom)`（:153-217）。**可配置项按模型覆盖**（`modelPolicies[]`，:244-262）。

**读写闭环**（`region.ts`，这是「如何拿到历史/如何写回」的权威答案）：

- 选范围：`selectCompactableRange(session, measurement, retainTokens)` —— 从 surface 头开始、尾部保留 priced 尾巴、绝不切断 tool-call/result 对（:117-155）。
- 事务：`compactSurfaceRegion(...)` —— `append('compaction/start')` → `prepareCompaction`（读 `ctx.tokenMeter.measure(session)` + `buildSummarizationInput`）→ 异步摘要（可重试恢复）→ `commitCompactionBody` → `append('compaction/end')`；手动路径 flush（:173-276）。
- **摘要正文**：`session.append('compaction/summary', {...})`，随后 `session.append('user/message', checkpointMessage, { surfaceOp: {op:'replace', startSeq, endSeq}, sourceEventSeqs: [startSeq, summarySeq, ...shadowedSeqs] })`（:491-509）。**这就是「写回」的全部动作，没有任何其它 surface 变化**。
- **历史读取**（前缀缓存友好）：`systemHead`（surface[0] 的 `system/message`）+ `session.requestHeader()?.tools` + 每个 shadowed seq 的 `session.deriveEventMessage(session.eventAt(seq))`（:544-563，buildSummarizationInput）。整体请求还可用 `session.deriveMessages()`（`$SRC/packages/core/agent-loop/src/agent.ts:721`）。
- **摘要消息 framing**：`summarizer.ts:22-71`（`<compacted-summary>` 包裹 + CHECKPOINT_PREAMBLE）、`:120-181`（`ctx.llm.stream({..., purpose:'compaction', sessionId})`，复用系统提示词/工具/前缀缓存）、`:188-194`（`frameSummary`）。
- **压缩检查点会打断请求序列**：替换属于 surface content 变化，`request/header` 会按 `series`/`change` 重新记录（`agent.ts:664-684`）。【事实】

### 2.3 手动触发与命令（【事实】）

`/compact` 只依赖 seam，不依赖后端：`$SRC/packages/compaction/command-compact/src/index.ts:67` 调 `ctx.compaction.compactNow(invocation.agent, signal, commandId)`；注册命令见 :101-106（`ctx.commands.register`）。**任何插件也可以在自己的工具/定时器里直接调 `ctx.compaction.compactNow/compactRegion`**（需同一 context 有 provider）——这是流动塔「主动整理」的最稳入口。

### 2.4 上下文注入的三条正规通道（【事实】）

| 通道 | API | 落点 | 证据 |
|---|---|---|---|
| 系统提示词（会话内稳定前缀） | `ctx.systemPrompt.section({name, order, text})` | `system/message` surface 节点 0 / 后续替换 | `$SRC/packages/core/system-prompt/src/index.ts:483-492`；`getSectionOrder` 具名槽 :136-170；`docs/architecture.zh.md:116` |
| 运行时上下文快照（每步可变的窄上下文） | `ctx.systemPrompt.context({name, order, text, required?})` | 由 agent-loop 落成一条 `user/message` 快照（`source.kind:'runtime-context'`），内容变化才重写 | system-prompt :518-527；`$SRC/packages/core/agent-loop/src/runtime-context.ts:119-168`；order 槽 :175-184 |
| 直接给下一步塞一条消息 | `agent.inject(userMessage)`（不唤醒）、`agent.followup`（唤醒）、或 `agent/pre-step` waterfall 改 `messages` | 下一次获准请求；`agent/pre-step` 是 waterfall，必须 `next()` 并展开 decision | `$SRC/packages/core/agent-loop/src/agent.ts:180-182`；`agent.ts:289-299`；`docs/architecture.zh.md:163`；`docs/capability-seams.zh.md:721` |

**可直接照抄的范例**：`time-context` 在 `agent/pre-step` 里 `prepend:true` → `await next()` → 展开 decision 并在尾部追加 `createUserMessage({source:{kind:'time-context',form:'snapshot',sections}})`
（`$SRC/packages/context/time-context/src/index.ts:199-243`），并用 `ctx.sessionProjections.register` 折叠日志算增量（:158-197）。
**注意**：`agent.preStep` 默认决策里已把 runtime-context 快照拼进 messages（`agent.ts:289-299`）；`agent/request` **不能改消息**，只能改调用配置（技能 practices.md:18）。

### 2.5 流动塔的接入方案（【推荐】，按稳定性排序）

| 方案 | 做法 | 优点 | 代价/限制 |
|---|---|---|---|
| **A. 观察式建树（首选）** | 只 `ctx.on('session/event')` 看 `compaction/summary`（含 `shadowedSeqs`、summary 内容）；原文仍在 append-only 日志里，用 `session.eventAt(seq)` 取原文写自己的库 | 零 patch、不与 compaction-basic 抢服务；树是纯派生缓存 | 摘要选什么范围由 basic 策略决定；多塔形状受限；无法自定义摘要 prompt |
| **B. 观察 + 主动压缩** | A + 自己的工具/命令里调 `ctx.compaction.compactNow/compactRegion(start,end)` | 可主动「上浮/合并」窗口 | 受 compaction lock；`compactNow` 要求 agent idle（内部走 `runMaintenance`，`compaction-basic/src/index.ts:407-459`） |
| **C. 替换 engine（仅当要自定义摘要）** | 在 preset 的 `isolate.compaction` 组里 `disabled` 掉 compaction-basic 行、插入自己的 engine 行（`CompactionEngine` 子类，或 `ctx.provide('compaction', duck)`）；也可子类化 `BasicCompactionEngine` 只覆盖 `summarize` | 完全控制摘要与范围；`compaction/*` 事件仍被现有 UI/计量消费 | 必须改 preset 声明（见 §7）；引擎与消费者须同 realm（`docs/architecture.zh.md:154`） |

---

## 3. 工具注册

**结论**：模型可见能力统一注册到 `ctx.tools`；生产级写法用 `defineTool`（author DSL → JSON Schema + 严格校验 + 输出 schema/render + 展示回调），但**它来自 `@deepseek-ai/dsh-tools`，纯 JS 插件拿不到**，因此流动塔 MVP 应**手写等价 JSON Schema 对象**直接 `ctx.tools.register({...})`。

- 数据结构（【事实】，`$SRC/packages/core/tools/src/contracts.ts:26-102`）：`ToolDefinition extends ToolSchema`，`ToolSchema = {name,description,parameters:Record<string,unknown>,deferLoading?}`；必填 `output: {schema: JsonSchemaNode, render(args,value): ContentBlock[], presentationMeta?}`；`execute(args, exec)`；可选 `presentCall(args)→ToolCallView`、`presentResult(args,result)→ToolResultView`、`projectContent`、`finalizeContent`、`timeoutMs`、`isConcurrencySafe`。
- 注册/查询接口（rc.5 核对✓）：`ctx.tools.register(definition)→disposer`、`restrict/guard/get/schemas/execute/presentAs`（service `tools`；`$SRC/packages/core/tools/src/index.ts`）。
- **真实注册片段**：
  - `todo_write`：`$SRC/packages/todo/tool-todo/src/index.ts:136-212`（`defineTool` + parameters DSL + output.schema + render + execute + presentCall + 11 行“写入 session 日志”）。注意它同时演示了 `ctx.sessionProjections.register<'todos'...>({key,stateSchema,init,apply,wire,stateVersion})`（:124-135）与 `inject=['tools','sessionProjections']`（:23）。
  - 5 个 session 查询工具：`$SRC/packages/experimental/tool-session-query/src/index.ts:57-122`（`systemPrompt.section` 写工具用法说明 + 批量注册 + `TEXT_OUTPUT={schema:{type:'string'},render}` + `timeoutMs`）。
- author DSL 的「必填」写法是**逐属性 `required: true`**（隐式开放对象根），不是 JSON Schema 的 `required:[]`（【事实】`$SRC/packages/core/tools/src/schema.ts:97-107`）；`defineTool` 编译与软校验逻辑 :555-633。手写 JSON Schema 时请用标准 `{type:'object',properties,required:[...],additionalProperties:false}`，避免与 DSL 混淆。
- 工具的分类/展示：`ToolCallView`（generic/terminal/diff）与 `ToolResultView`（generic/terminal/diff/search/read/web）定义在 `$SRC/packages/core/tools/src/presentation.ts`，Client 侧 `presentCall` 只是可选提示；真正的自定义卡片走 §5 的 keyed slot。【事实】

---

## 4. 持久化

**结论**：官方推荐路径是 `ctx.storage`（hub）→ `ctx.storageDomain`（类型化领域，需 zod schema）→ `storage-json`（默认后端，根目录 `dshHomePath('storages')`）或 `storage-sqlite`（可选后端）。**有 SQLite 先例**：`dsh-storage-sqlite`（后端）与 `dsh-session-query-sqlite`（session 检索后端，FTS5）。但纯 JS 插件的现实做法是**直接用 `node:sqlite` 自带库**（bgx666 先例，见 `design/flow-tower/00-精读笔记.md` 的 bgx666 存储段：单库 `$DSH_HOME/memory-tree/memory_tree.db`），代价是放弃领域校验与 `domain/changed` 事件。

### 4.1 存储栈事实

- 三层：hub `ctx.storage`（后端注册表 + 数据形态挂载）→ provider `storage-json`/`storage-sqlite`（拥有介质）→ form `ctx.storageDomain`（`DomainSpec`/`Domain` API）。【事实】`$SRC/docs/subsystems/storage.zh.md:5-24,26-47`；源码 `$SRC/packages/storage/storage-domain/src/spec.ts:34-147`。
- 领域声明：`defineDomain({name,version,layout?,compatibleVersions?,invalidRecords?,global?,tables})` + `domainTable<K,V>(zodSchema)`；`Domain` 句柄提供 `global.get/set`、`table(name).get/entries/keys/put/update/delete/deleteMany`；写链顺序：后端持久化 → 内存 → `domain/changed` 事件。【事实】spec.ts:88-147；`storage.zh.md:97-153`。
- 真实范例：`workspace`（`$SRC/packages/workspace/workspace/src/spec.ts:76-84` 声明；`src/index.ts:200` `ctx.storageDomain.open(...)`）、`schedule`（`$SRC/packages/schedule/schedule/src/index.ts:149`）、`session-projection-cache`（`$SRC/packages/session/session-projection-cache/src/index.ts:119` + `spec.ts:100` 用 `layout:'per-record'`）。
- 路由：`storage-domain` 的 Config `backend` 指定默认后端、`routes` 按领域名覆盖；base 组合把 json 根目录设为 `dshHomePath('storages')`、domain 默认 `backend: json`。【事实】`$SRC/packages/bundle/base/cordis.patch.yml:179-190`。

### 4.2 SQLite 先例

- `dsh-storage-sqlite`：注册后端名 `sqlite`，Config `{path, journalMode='wal'}`；每 unit 一张 `key/value` STRICT 表；`ctx.effect(()=>{register; return close})` + `ctx.provide(storageBackendServiceKey('sqlite'), backend)`。【事实】`$SRC/packages/storage/storage-sqlite/src/index.ts:23-48,50-167`。
- `dsh-session-query-sqlite`：`ctx.sessionQuery` 的 SQLite FTS5 实现（包描述），base 默认 `path: ':memory:', openAt: never`（搜索默认不启用，由后续 patch 层覆盖）。【事实】`$SRC/packages/session-query/session-query-sqlite/package.json`；`$SRC/packages/bundle/base/cordis.patch.yml:149-161`。
- 注意：base **没有**默认挂 sqlite backend（只挂 json）；要用 `ctx.storageDomain` 走 sqlite，你的 bundle patch 需 `insert` 一个 `storage-sqlite` 行（+ 可选 `storage-domain` routes），或让 `open` 显式指定后端。（【事实】base patch 全文无 `storage-sqlite` 行；【推荐】由此推出。）

### 4.3 流动塔的存储建议

- 【推荐】表设计沿用 00 号笔记的结论：`tower_id + session_id` 复合分区；节点表、原文外置表（append-only）、run/事务表、审计表；节点 ID 带树前缀。
- 【推荐】两条路线：
  1. **`node:sqlite` 自有库**（MVP，纯 JS 可做）：`$DSH_HOME/flow-tower/flow_tower.db`，WAL，自己的 schema_version/迁移；与 bgx666 同类。
  2. **`ctx.storageDomain` 正式化**（需要 zod 或鸭子 `safeParse`）：领域名如 `flow_tower`，`layout:'single'` 或 `per-record`，靠 `domain/changed` 推给 Client 投影。
- 硬规矩（技能 practices.md:7,21）：**会话日志是唯一真源**，插件自己的库只能是「派生缓存 + 原文外置」；**不要**往 session 里 append 自定义事件类型（未知类型只有在信封带 `ignorable:true` 时才被接受，而 live `Session.append()` 不能设置该标记，会导致会话无法重开）。

---

## 5. Web UI：Client 插件怎么挂卡片、Host 怎么推数据

**结论**：Client 半是「`package.json` 声明 `dsh.client` + `exports["./client"]` 导出 `__ModuleLoader__` 包」；渲染只能通过 **slot**：聊天行用 `conversation.chat.node`（keyed），工具卡片用 `tool.call.toolview`（keyed by 工具名），侧栏入口用 `sidebar.panellist`、主面板用 `main`。Host→Client 数据优先用 **session projection 的 `wire.view`**（Client 用标准 prop `useProjection` 读取），自定义接口再用 `ctx.webServer.register` 起 HTTP 路由。**禁止** iframe 塞宿主 UI、禁止 import 宿主 Client 包、禁止自己写 DOM。

### 5.1 Client 模块与 manifest（【事实】）

- 扫描规则：包在 `package.json` 声明 `dsh.client`（`platform:'web'`、可选 `inject`、`immediately`），并在 `exports["./client"]` 导出构建产物；`ctx.clientModules` 组合 `__DSH_BOOT__` 图。【事实】`$SRC/docs/subsystems/client-modules.zh.md:92-98`；`$SRC/packages/client/ui-tool/package.json`。
- 加载格式：`window.__ModuleLoader__.load({id:'<包名>', factory:(require)=>{...; return {inject, apply}}})`，React 用 `require('react')`。【事实】`$EX/tianquan-app/client.js:8-15,109-140`；技能模板 `templates/decoration/client.js:1-22`。

### 5.2 Slot 注册（【事实】+【推荐】）

- 生命周期：`ctx.slots.inject(ownerKey, () => ctx.slots.register(spec, Component))`；owner 折叠时注册随 effect 移除、重挂时重跑。注册到未声明 slot 或重复声明别人的 child 会在激活时失败。【事实】`$SRC/docs/subsystems/slots.zh.md:17-26`；范例 `slots.zh.md:27-50`、`$EX/tianquan-app/client.js:128-135`。
- 目标 slot（流动塔可选）：

  | 需求 | slot | 证据 |
  |---|---|---|
  | 聊天里的一张卡（会话流） | `conversation.chat.node`（keyed，如 `key:'tool-call'`；也可用 `ctx.uiConversation.events.register` 自定义 kind） | `$SRC/docs/subsystems/slots.zh.md:144-163`；技能 practices.md:37 |
  | 自己工具的执行卡片 | `tool.call.toolview`（keyed，key=wire 工具名；owner props 含 phase/callId/toolName/args/result、`useDisclosure`、`openFile`、`loadImage`） | `$SRC/packages/client/ui-tool/src/client/contract/slots.ts:26-30,58-88`；注册范例 `.../ui-tool/src/client/apply.ts:34-42` |
  | 侧栏入口 / 主面板 | `sidebar.panellist` / `main` | `$EX/tianquan-app/client.js:128-135` |
  | 会话头部按钮 | `conversation.session.header.actions`（list） | `slots.zh.md:33-49` |
- 标准 props（不必自己造 hook）：`useSession/useProjection/useSessions`、`useConversation/useChat` 等由 adapter 按 scope 提供（`slots.zh.md:87-104`）。
- 样式：只用主题 token `--dsw-alias-*`；可以照抄上游组件 markup/CSS 但**不要 require 宿主 Client 包**（否则宿主一改就白屏）。【事实】技能 practices.md:34-35。

### 5.3 Host→Client 两条数据通道（【事实】/【推荐】）

1. **session projection + wire（首选）**：Host 用 `ctx.sessionProjections.register({key, stateSchema, init, apply, wire:{viewSchema, view, summary}})`) 把会话派生值折出来；`wire` 让它对 Client 可见，Client 在 slot 组件里用 `useProjection` 读取（见 `$SRC/docs/subsystems/session-projection.zh.md:33,66-77,133,321`；标准 prop 见 `slots.zh.md:97`；技能 practices.md:38 明确「Client 需要会话派生值时声明 `wire.view`」）。【推荐】流动塔把「塔列表+窄画像+节点摘要」做成 projection unit，卡片订阅 `selector` 只取用到的切片。
2. **自定义 HTTP 路由**：`ctx.webServer.register({kind:'prefix', path:'/flow-tower', handler})`，Client 用 `fetch('/flow-tower/api/...')`（同源）。范例：`$EX/tianquan-app/index.js:181-190`（含 `ctx.effect(register)` 与 `webServer = ctx.webServer ?? ctx.get('webServer')` 的兼容写法），Client 侧 `client.js:16`。服务契约 rc.5 核对✓：`webServer` 有 `getOrigin/register/registerUpgrade/registerFallback/tapIndex/collectIndexInjections/renderIndex`。
- 下钻工具的结果本身也能喂卡片：工具的 `output.presentationMeta` 会持久进 `tool/result.meta`，Tool view 可从 `block.meta` 读（`contracts.ts:16-23,151-164`）。

---

## 6. 最小可行插件骨架（【推荐】文件清单 + 职责 + 代码形状）

```
flow-tower/
├ package.json          # §1 形状：dsh.bundle.patch + dsh.client + exports + files + icon
├ cordis.patch.yml      # insert 自己的 Host 行（MVP 两行：flow-tower、可选 flow-tower-preset 覆盖）
├ index.js              # Host 入口：name / inject / apply；装配 store + tools + 观察器 + prompt 上下文
├ lib/store.js          # node:sqlite 打开/迁移/事务；原文外置与节点表（纯 JS）
├ lib/tree.js           # 建树/上浮/选取/渲染窄视图（纯函数，可单测）
├ lib/tools.js          # 手写 JSON Schema 的工具定义：flow_tower_list / flow_tower_read / flow_tower_drill
├ client.js             # Client：__ModuleLoader__ + slot 注册（tool.call.toolview 或 conversation.chat.node）
├ locale/en.json        # {"meta":{"title":"Flow Tower","description":"..."}}
├ locale/zh.json        # 同上中文
└ icon.svg
```

```js
// index.js —— Host 半骨架（纯 JS，不 import @deepseek-ai/*）
export const name = 'flow-tower'
export const inject = ['tools', 'systemPrompt']                  // 必备服务进 inject；可选服务用 ctx.get() 取，别进 inject
// 不导出 Config（纯 JS 无 schemastery）；需要可调参数时再从 apply(ctx, config) 的 row config 读默认值

export function apply(ctx) {
  const store = openStore()                                       // node:sqlite，$DSH_HOME/flow-tower/*.db
  ctx.effect(() => () => store.close(), 'flow-tower.store')

  // 1) 观察压缩结果 → 原文外置 + 建树（不抢 compaction 服务）
  ctx.on('session/event', (session, event) => {
    if (event.type === 'compaction/summary') ingestCompaction(store, session, event)
  })
  // 2) 窄路由视图进运行时上下文（每步快照，内容不变不重写）
  ctx.systemPrompt.context({ name: 'flow-tower:router', order: 200,
    text: () => renderRouterView(store) })                        // 极窄：tower_id | 画像 | 时间 | 代价
  // 3) 下钻/巡检工具（手写 JSON Schema）
  for (const def of buildTools(store)) ctx.tools.register(def)
  // 4) 可选：原文外置的 HTTP 查询口（给 Client 卡片）
  ctx.get('webServer')?.register({ kind: 'prefix', path: '/flow-tower', handler: makeHandler(store) })
}
```

```js
// client.js —— Client 半骨架
window.__ModuleLoader__.load({ id: '@local/flow-tower', factory: (require) => {
  const React = require('react')
  function FlowTowerCard(props) { /* 用 props.useProjection?.(...) 或 fetch('/flow-tower/api/...') */ }
  return { inject: ['slots'], apply(ctx) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
      { name: 'tool.call.toolview', key: 'flow_tower_drill' }, FlowTowerCard))
  } }
}})
```

- 若还要**替换摘要**：再加 `lib/engine.js`（`CompactionEngine` 子类，或直接 `ctx.provide('compaction', {...})`），并在 preset 声明里把 `compaction-basic` 行 `disabled` + 插入本包（§7）；**这是唯一需要改 preset 声明的地方**。
- 安装后验证顺序（【推荐】）：`Config.listConfigs` 看自己的行是否 active → 新开一个 session（旧 session 保留旧插件版本，技能 `editing-cordis-compositions` 明确）→ 调一次工具 → 触发一次 `/compact` → 查卡片与 DB 内容 → `session/event` 里能看到 `compaction/*`。

---

## 7. 稳定扩展点 vs 必须 patch vs 内部 API

**结论**：rc.5 里 01 号文档 §8.3 列的 5 处硬编码，**没有一处需要 patch 宿主代码**：前 4 处是 bgx666 插件自身的实现硬编码（DSH 并没有「只能一棵树」的限制），第 5 处是唯一真正的架构约束——「每个 context 一个 `ctx.compaction` provider」——用 **preset 的 `isolate` 组 + 行级 patch** 即可解决（官方机制）。bgx666 的 `Base.prototype.summarize/compactIfNeeded` 包裹法在本版本属于不可依赖的实现细节：源码里抽象类是 `CompactionEngine`、实现类 `BasicCompactionEngine`，`summarize` 是 `protected` 方法（`compaction-basic/src/index.ts:112,270`），安装包是压缩后的 `lib/index.js`，名称与形状都不承诺稳定。

### 7.1 稳定扩展点清单（可直接依赖，rc.5 核对✓）

| 能力 | 扩展点 | 证据 |
|---|---|---|
| 注册工具/守卫/限制 | `ctx.tools.register/restrict/guard/schemas` | Service 目录 `tools`；contracts.ts:26-102 |
| 系统提示词段落/变量 | `ctx.systemPrompt.section/context/tools/variable/assemble` | system-prompt/src/index.ts:483-575；inspect Service `systemPrompt` |
| 拦截/改写一步 | `agent/pre-step`（waterfall，必须 `next()` 并展开 decision） | Event 目录；agent.ts:289-299 |
| 观察工具/模型/会话事实 | `tools/result`、`assistant/message`、`session/event`、`turn/start|end` | Event 目录；`docs/event-producer-consumer.zh.md` |
| 给下一步加消息 | `agent.inject()` / `agent.followup()` | agent.ts:180-182；architecture.zh.md:163 |
| 压缩（调用/观察） | `ctx.compaction.compactIfNeeded/compactNow/compactRegion`；`compaction/*` 事件；`compaction/summary-error` waterfall | compaction/src/index.ts:119-193；types.ts:17-90 |
| 手动压缩 | `/compact` 命令或自行 `ctx.commands.register` | command-compact/src/index.ts:67,101-106 |
| token 计量 | `ctx.tokenMeter.measure(session, header?)`、`estimateMessage(msg)` | inspect Service `tokenMeter`；`docs/subsystems/token-meter.zh.md:104-145` |
| 会话派生状态 | `ctx.sessionProjections.register(...)` + `stateOf` + `wire.view` | 范例 time-context:158-197；docs session-projection:33,321 |
| 持久化 | `ctx.storageDomain.open(defineDomain(...))`（官方）/ `node:sqlite`（纯 JS 现实路径） | storage.zh.md；storage-sqlite/src/index.ts:158-167 |
| Client UI | `ctx.slots.inject/register`（chat node / toolview / sidebar）；`ctx.uiConversation.events.register` | slots.zh.md；ui-tool/src/client/apply.ts:34-42 |
| Host→Client | session projection `wire` / `ctx.webServer.register` | session-projection.zh.md:66-77；tianquan-app/index.js:188 |
| 人类命令 | `ctx.commands.register({name, description, handler})` | command-compact/src/index.ts:101-106 |
| 组合/替换行 | bundle patch 按 id 覆盖、`cordis:group` + `isolate` realm | base patch:1-12；web-app presets/standard.patch.yml:66-82；architecture.zh.md:154 |
| 插件元数据 | `locale/*.json` 的 `meta.title/description` + `icon` | host-plugin.md:31-51 |

### 7.2 必须「动配置/动 preset」的两件事（属稳定机制，但不是纯代码扩展）

1. **替换压缩 provider**：`ctx.compaction` 每 context 只能一个实现；web-app 又已把 host 行禁用。所以必须覆盖 preset 声明（`- id: preset-standard` 整体重述 `config.plugins`）或在 preset 组内替换 `compaction-basic` 行，并把 provider 与消费者放进同一个 `isolate: {compaction:true}` 组。【事实】web-app/cordis.patch.yml:538-552；presets/standard.patch.yml:66-82；技能 `editing-cordis-compositions`（host vs preset 放置规则）。
2. **让能力随 preset 生效**：如果流动塔只在 host 平面注册工具/上下文，而 agent 运行在 preset 作用域，则「谁可见」由 scope 决定；服务型能力（自己 `provide` 的服务）必须与消费方同 realm。【事实+推荐】architecture.zh.md:154；技能 `editing-cordis-compositions`「Choose plugin placement」。

### 7.3 不要碰（内部/不稳定）

- ❌ **prototype patch**（bgx666 风格）：依赖压缩后模块结构；参见 `compaction-basic/src/index.ts:112,270`——`CompactionEngine`/`BasicCompactionEngine`/`protected summarize` 都不是公开契约，`$EX`/技能文档也没把 prototype 列为扩展点。
- ❌ **自定义 SessionEvent 类型**：`Session.append()` 无法设置 `ignorable`，未知类型会导致会话无法重开（技能 practices.md:21）。要持久化就用自己的存储。
- ❌ **import 宿主 Client 包/`dsh-client-ui-primitives`**；❌ 自己写 DOM 或 `document.body`（practices.md:35-36）。
- ❌ **改 profile 的 `package.json`/`cordis.patch.yml` 或跑 pnpm**：安装必须走 `install_bundle`（host-plugin.md:66-70）。
- ⚠️ **依赖 `ctx.fiber`、`agent.options` 之外的 Agent 私有字段、或 `session.append` 的未文档化参数**：源码有，但不承诺。
- ⚠️ 若走 C 方案子类化 `BasicCompactionEngine`（覆盖 `summarize`）：需要能 import 该包（见 §1.4 的模块解析障碍），【待验证】。纯 JS 更现实的是「不替换 provider、只观察」。

### 7.4 01 号文档 §8.3 五处硬编码逐条映射（更新结论）

| 01 §8.3 原硬编码 | 在 rc.5 的对应稳定机制 | 是否必须 patch 宿主 |
|---|---|---|
| 1) `index.js:166 let active=null` 单实例 prototype hook | 不再用 prototype hook；压缩 provider 由 preset 的 `isolate.compaction` 组唯一持有；多塔状态放 host 单例服务 + 按 `sessionId/towerId` 的 Map/表 | 否 |
| 2) `store.js` 单库单表 `PRIMARY KEY(session_id,id)` | 自己声明 storage domain（或自有 sqlite）：`tower_id` 复合键、每树一库均自由 | 否 |
| 3) `MEMORY_TREE_PROMPT` 写死「一棵树」、`renderNodeBlocks` 只渲染一棵 | 自己 `ctx.systemPrompt.context()` 渲染自己的窄视图；自己的节点 ID 命名空间/正则 | 否 |
| 4) `explore_memory_tree` 只有 `node_id`、4 个 HTTP 路由按 session+id | 自己工具加 `tower_id/tree_id` 参数；HTTP 用 `ctx.webServer.register` 自己的前缀 | 否 |
| 5) `moveSession` 单树整棵迁移、client 只渲染一张卡 | 迁移逻辑在自己的存储层；UI 用自己 slot key（或 `ctx.uiConversation.events.register` 自定义 kind） | 否 |

**一句话**：需要 patch 的不是宿主，而是「压缩 provider 的唯一性」——用官方 preset 组合解决；把「多树」当数据模型做在自己的 domain/库里。

### 7.5 最大的架构风险（按严重度）

1. **前缀缓存代价**（设计层风险，非 API）：每次 `compaction/*` 替换都会让 request series/前缀变化（agent.ts:664-684 的 `request/header` 重记），「流动」越频繁，缓存命中越差；01 §8.1 的「静默期/批量窗口」必须在实现层落实。
2. **preset 选错 = 能力全不生效**：用户当前 profile `selectedDefault: cordis`（`$PROFILE/cordis.patch.yml:36-40`），而压缩/工具在多套 preset 中各自挂载；「装了插件」不等于「当前会话用到它」——必须验证所选 preset 的声明里真的有流动塔行。
3. **双写一致性**：原文外置与树节点是两套写；压缩事务失败/中断时会出现 `compaction/start` 无 `end` 的遗留锁（compaction.zh.md:19-21），树侧必须可回滚/幂等（抄 bgx666 的 beginRun/commitRun/rollback）。
4. **依赖注入边界**：纯 JS 插件没有类型与 zod，`storageDomain` 的 duck schema 属实现依赖；一旦上游改校验方式就崩【待验证】。
5. **Client 数据新鲜度**：`useProjection` 只给会话派生值；原文/树节点等大对象别塞 wire（会变大并拖慢每次投影），用 HTTP 路由按需拉（tianquan-app 模式）。
6. **安装即执行代码**：`install_bundle` 在 Host 进程执行插件代码，需 Full access/审批；开发期最好用 `HMR`（配置行变化可热重载，模块替换需重启，宿主文档：host-plugin.md:68-70）。

---

## 8.（补充）dsh-context / dsh-compaction 包族清单与各自职责

> 澄清：**没有名为 `@deepseek-ai/dsh-context` 的包**；`context` 是 `$SRC/packages/` 下的分组目录，包含 7 个「上下文贡献者」包。压缩族同理，`packages/compaction/` 下 5 个包。下表均据 `package.json` 的 `name/description` 与源码。

### 8.1 context 族（`packages/context/*`）

| 包 | 职责 | 关键机制/服务 | 与流动塔的关系 |
|---|---|---|---|
| `dsh-agent-instructions` | 读工作区 `AGENTS.md/CLAUDE.md` 指令文件 | 工作区上下文 loader（`src/files.ts` 602 行、`render.ts` 513 行） | 可参考其「工作区文件→上下文」的缓存/变更检测 |
| `dsh-time-context` | 每步的时间/耗时上下文 | `agent/pre-step` prepend + `systemPrompt` 等价的消息快照 + `sessionProjections`（`src/index.ts:158-243`） | **最佳注入模板**（窄、每步、可缓存） |
| `dsh-tmux-context` | 可选：本 agent 的 tmux 窗格位置 | 同上「durable per-step context」 | 说明「per-step 上下文」是官方模式 |
| `dsh-harness-dev-context` | 把 DSH checkout/Web URL 作为模型上下文，且不污染系统提示词 | 静态/运行时 context（158 行小包，易读） | 窄上下文的第二个范例 |
| `dsh-file-reference` / `dsh-file-reference-local` | `@file` 语法与本地文件引用发现（`ctx.fileReferences` seam + provider） | 引用语法/候选排序，不读文件内容 | 下钻工具若支持 `@文件/行号` 可复用语法 |
| `dsh-session-reference` | 跨会话快照引用，投影为「持久但不可信」的模型上下文（`ctx.sessionReferenceResolver`） | Host 适配器负责提及语法 | **多塔跨会话下钻的现成零件**（安全边界：不可信上下文） |

### 8.2 compaction 族（`packages/compaction/*`）

| 包 | 职责 | 关键事实 |
|---|---|---|
| `dsh-compaction` | Service Definition（`ctx.compaction`） | 抽象类 + `compaction/*` 事件声明 + tool pairing 工具 + checkpoint source（`src/index.ts:119-193`，`src/types.ts:17-120`） |
| `dsh-compaction-basic` | 默认 provider：token-meter 驱动的阈值/保留策略 + LLM 摘要 | 触发点/`summarize` 钩子见 §2.2；`auto` 默认开 |
| `dsh-command-compact` | 人类 `/compact` 命令（backend 无关） | `ctx.compaction.compactNow`（`src/index.ts:67`） |
| `dsh-compaction-tool-result-pruner` | 免模型的工具结果 head/middle/tail 剪枝（回放安全） | 在摘要前跑，`pruneSession(session)`；preset 里与 compaction 同 isolate 组（standard.patch.yml:77-82） |
| `dsh-compaction-image-offload` | 超预算图片替换为占位符并可重试（`image/offload` 事件） | `docs/subsystems/compaction.zh.md:25-38` |

### 8.3 与流动塔直接相邻、必读的包（不属于上面两族）

| 包 | 为什么相关 | 证据 |
|---|---|---|
| `dsh-token-meter` | 压力/预算/代价估计的唯一计量源（`measure`/`estimateMessage`） | `docs/subsystems/token-meter.zh.md:104-145` |
| `dsh-session-projection`（+`-cache`） | 会话派生状态 + 持久化检查点 + Client wire | `docs/subsystems/session-projection.zh.md` |
| `dsh-session-query`（+`-sqlite`） | 历史检索 seam，给「下钻/回溯」提供只读查询面 | `$SRC/packages/session-query/session-query-sqlite/package.json`；base patch:149-161 |
| `dsh-storage` / `-domain` / `-json` / `-sqlite` | 非会话数据的持久化栈（§4） | `docs/subsystems/storage.zh.md` |
| `dsh-system-prompt` | 上下文注入的入口（§2.4） | `packages/core/system-prompt/src/index.ts` |
| `dsh-tools` | 工具注册与执行流水线（§3） | `packages/core/tools/src/contracts.ts` |
| `dsh-agent-loop` | 真正决定「每步看到什么」的循环（assembly/pre-step/deriveMessages） | `packages/core/agent-loop/src/agent.ts:276-310,649-737` |

---

### 附：核对方法与差异说明

- 源码树 rc.3 与安装 rc.5 的差异：所有本文用到的 Service/Event/Tool 名称均用 `cordis_inspect_query`（host `Service`/`Event`/`Config`/`Tool`）在 rc.5 上逐项核过；**方法签名级**未发现不一致。Client 侧 slot 因当前无已连接页面（inspect 返回 "no connected Harness page"）**未能在运行时核对**，只能引源码与文档，标【事实-源码】。
- 技能与文档索引：`...\dsh-agent-preset\skills\cordis-plugin-development\references\{host-plugin,practices}.md`；`$SRC/docs/{architecture,capability-seams,event-producer-consumer,config-catalog,persistence-catalog}.zh.md` 与 `$SRC/docs/subsystems/*.zh.md`。

# 模块契约与依赖图

每个插件源模块文件头都有统一的 **module contract** 块：

```js
/**
 * --- module contract ---
 * purpose: 一句话职责。
 * dependsOn: [generated] lib/a.js, lib/b.js
 * externalDeps: [generated] node:fs, node:path
 * usedBy: [generated] lib/c.js, index.js
 * publicApi: [generated] exportedName1, exportedName2
 * risk: 风险等级 / 为什么不宜解耦。
 * --- end module contract ---
 */
```

- `purpose`、`risk` 由人维护；
- `dependsOn`、`externalDeps`、`usedBy`、`publicApi` 带 `[generated]` 标记，由工具从真实 import/export 生成，**不要手改**；
- 反向 `usedBy` 只是只读索引/文档，**禁止**据此新增反向 import 或运行时依赖；
- 正向依赖以代码为准；契约行与代码不一致时 CI 失败。

## 工具

```powershell
# 更新所有 generated 行 + 生成 docs/module-graph.json
node tools/module-graph.mjs --write

# CI / 提交前校验：缺契约、TODO、依赖漂移、悬空引用、循环依赖
node tools/module-graph.mjs --check

# 一次完整验证：单测 + 依赖图校验
npm run verify
```

`docs/module-graph.json` 是机器可读的正向/反向依赖索引，`docs/module-graph.md` 是摘要。

## 当前状态

- 契约模块：56 个；本地依赖边 0 循环；
- 单测：67/67；
- 依赖图包含 `test/*.test.js`、`eval/*.mjs`、`tools/*.mjs` 作为消费者（`devConsumers`），但契约要求只作用于运行时代码（`index.js`、`client.js`、`lib/**`、`compaction/**`）。

## 拆分结果

| 模块 | 行数 | 说明 |
| --- | ---: | --- |
| `lib/store.js` | ~1276 | **保留单类**：方法共享 `this.db`、prepared statement 缓存、索引/淘汰不变量；只把 DDL/迁移/row 映射抽到 `lib/store-schema.js`。拆 class 会引入状态漂移风险，属于高风险例外。 |
| `lib/relations.js` | ~834 | **保留单模块**：canonical/inverse/symmetric/cycle 不变量贯穿 CRUD、查询、同步、导出；拆分会把同一套约束复制到多处。属于内聚例外。 |
| `client.js` | ~730 | **保留单文件**：由 DSH `__ModuleLoader__` 以单 bundle 加载，无本地 import；拆分需要改客户端加载契约，高风险。 |
| `lib/web-page.js` | ~737 | **保留单文件**：历史只读页面的纯模板字符串；拆分会引入 `${...}` 插值/转义风险，且没有逻辑耦合收益。 |
| 其余源模块 | ≤ 400 | `web-*`、`tools/*`、`catalog/digest`、`compiler-samples`、`host-utils` 等按子功能拆分。 |

## 边界

- 不把 `usedBy` 写成运行时数据：工具只校验，不参与执行；
- 循环依赖由 `--check` 直接失败；跨模块调用仍只能通过 import / 显式注入；
- 测试、eval、tools 脚本不要求契约块，但它们的 import 会进入 `usedBy`，便于看到真实消费者；
- `plugin/flow-tower-compaction/` 是集成 backend 的独立镜像（仅开发/参考用，当前不安装）；它保留手工同步的契约块，不纳入主插件依赖图，同步时必须一起更新。

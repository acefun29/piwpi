# piwpi 扩展 API 核对结论文档（M0）

- 核对基准：pi 源码 @ `3d264e85`（v0.83.0，2026-08-03）
- 核对时间：2026-08-04
- 计划来源：`docs/阶段一开发计划.md` §9 待核对清单（实现第一步先核对，禁止臆测）
- 路径说明：扩展机制实际位于 `packages/coding-agent/src/core/extensions/`（计划文档中 `extensions/xxx` 为简写）

## 一、待核对清单逐项结论

| # | 核对项 | 结论 | 证据 |
|---|---|---|---|
| 1 | `context` 事件名称与 handler 签名/返回类型 | ✅ **确认** | `pi.on("context", handler)`（`core/extensions/types.ts:1215`）；`ContextEvent = { type: "context"; messages: AgentMessage[] }`（670-673）；返回 `ContextEventResult = { messages?: AgentMessage[] }`（1065-1067）；handler 类型 `ExtensionHandler<E, R>` = `(event, ctx) => Promise<R \| void> \| R \| void`（1188）。接线：`core/sdk.ts:350-354`（`transformContext → runner.emitContext(messages)`），每次 LLM 请求前执行（`agent/src/agent-loop.ts:289-292`） |
| 2 | `ExtensionContext` 是否直接含 `cwd` | ✅ **直接存在** | `types.ts:314-315` `cwd: string`。备选通道：`SessionHeader.cwd`（`core/session-manager.ts:37`）。`ExtensionContext` 另含 `sessionManager`(317)、`modelRegistry`(319)、`model`(321)、`signal`(334)、`shutdown()`(340) |
| 3 | 扩展 handler 抛异常时 runner 的隔离行为 | ⚠️ **部分隔离** | `tool_result`：per-handler try/catch → `emitError`（`runner.ts:887-916`）；`context`：同上（993-1006）；`user_bash`：同上（963-977）。**`tool_call`：无 try/catch**（`runner.ts:941`），异常经 `agent-session.ts:484-489` 包装为 `"Extension failed, blocking execution: …"` 抛出 → **阻断工具执行**。结论：`onToolCall` 必须自带 try/catch（计划 §4.5 由此获得实证） |
| 4 | 扩展 API 是否暴露 `turn_end`/`agent_end` 订阅 | ✅ **都存在** | `types.ts:1224`（`agent_end`）、`1227`（`turn_end`）。结论：M5 记忆队列去抖 flush 可用 `turn_end` 事件驱动，**无需 1500ms timer**（计划 §6.1 的 timer 方案可升级，记入修订建议） |
| 5 | `createHarness` 是否支持注入扩展路径 | ⚠️ **有更好的方案** | `createHarness` 明确不支持：传入 `extensionFactories` 即抛错（`test/test-harness.ts:456-459`）。**`createHarnessWithExtensions(options)` 支持 `extensionFactories`**（465-469；`HarnessOptions.extensionFactories` 345）。结论：M6 e2e 用 `createHarnessWithExtensions`，**无需手动调 loader** |
| 6 | `pi.on("context")` 返回 `undefined` 时是否零改动 | ⚠️ **需修正认知（重要）** | runner 分发前 `structuredClone(messages)`（`runner.ts:986`），把 **clone** 传给 handler，且**无论 handler 返回什么，恒返回该 clone**（1013）。推论：① handler 不改内容 → clone 与原文逐字节相同 → 序列化字节不变 → 缓存前缀稳定（计划目标**成立**）；② 但"不改引用"不成立（每请求新对象），对 Anthropic 按内容哈希的缓存无影响；③ **onContext 原地修改 `event.messages` 即可生效，无需返回 `{messages}`** —— 计划 §4.4 可简化（M0 骨架已按简化版落地） |

## 二、其他已核对事实（支撑 M1-M6）

- `ExtensionAPI.on` 全事件清单（`types.ts:1193-1239`）：project_trust / resources_discover / session_start / session_info_changed / session_before_switch / session_before_fork / session_before_compact / session_compact / session_shutdown / session_before_tree / session_tree / **context** / before_provider_request / before_provider_headers / after_provider_response / before_agent_start / agent_start / **agent_end** / agent_settled / turn_start / **turn_end** / message_start / message_update / message_end / tool_execution_start / tool_execution_update / tool_execution_end / model_select / thinking_level_select / **tool_call** / **tool_result** / user_bash / input
- `ExtensionAPI` 另含：`registerTool`(1246)、`registerCommand`(1255)、`registerShortcut`(1258)、`registerFlag`(1267)、`appendEntry`(1312，custom entry 持久化，`CustomEntry` 不进 LLM 上下文)、`exec`(1328)、`setModel`(1347)、`registerProvider`(1411) 等
- `tool_call` 事件：`event.input` 可变，注释明确 "Mutate it in place to patch tool arguments before execution. No re-validation is performed after mutation."（`types.ts:898-903`）；返回 `ToolCallEventResult = { block?, reason? }`（1071-1075）
- `tool_result` 事件：`ToolResultEventBase` 含 `toolCallId/input/content/isError/usage`（914-922）；`ReadToolResultEvent.toolName === "read"`、`details: ReadToolDetails | undefined`（929-932）；类型守卫 `isReadToolResult`（979-981）
- `ToolResultEventResult = { content?, details?, isError?, usage? }`（1085-1090），字段任一 `!== undefined` 即覆盖（`runner.ts:891-906`）
- `tool_result` 替换链路：`agent-session.ts:492-523` afterToolCall → 扩展结果优先；`!hookResult && normalizedContent === content` 时返回 undefined（零改动）
- `SessionStartEvent.reason: "startup" | "reload" | "new" | "resume" | "fork"`（562-568）；`SessionShutdownEvent.reason: "quit" | "reload" | "new" | "resume" | "fork"`（616-621）
- `sessionManager.appendCustomEntry(customType, data?): string`（`session-manager.ts:1122-1133`）
- safeCwd 规则：`--${resolvePath(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`（`session-manager.ts:476-481`）
- 扩展加载：jiti 加载 default export，工厂必须为函数（`loader.ts:412-440`）；三来源发现规则：项目 `<cwd>/.pi/extensions/`、全局 `<agentDir>/extensions/`、显式路径（`-e`）（`loader.ts:665-713`）
- 包导出：`@earendil-works/pi-coding-agent@0.83.0` 包根导出 `ExtensionAPI/ExtensionContext/ExtensionHandler/ToolCallEvent/ToolResultEvent/ContextEvent/SessionStartEvent/SessionShutdownEvent/ToolCallEventResult/…`（`src/index.ts:53-151`）；**未导出** `ToolResultEventResult`、`ContextEventResult`、`AgentMessage`、`TextContent`、`ImageContent`、`Usage` → 扩展侧用本地结构类型（见 `src/harness.ts`）

## 三、对计划文档的修订建议

1. **§4.4**：`onContext` 改为原地修改 + 返回 void（runner 恒返回 clone，见 #6），删除 `{ messages }` 返回逻辑；"无变化不改引用"改为"无变化内容逐字节不变"。
2. **§4.5 / §9#3**：`onToolCall` 必须自带 try/catch（runner 对 tool_call **无**隔离，异常会阻断工具执行）。
3. **§6.1**：记忆去抖可用 `turn_end` 事件触发 flush，替代 1500ms timer（#4）。
4. **§7.1**：e2e 测试用 `createHarnessWithExtensions({ extensionFactories })`，不是 `createHarness`（#5）。
5. **路径**：计划文档 `extensions/xxx` 均指 `packages/coding-agent/src/core/extensions/xxx`。
6. **§3.1 补证**：read 输出上限 2000 行 / 50KB 与 `details.truncation`（`tools/truncate.ts`）待 M2 实现时二次核对（本次未展开，非清单项）。

## 四、阶段一（M1-M6）实现结论

**全部里程碑已实现并通过测试**（2026-08-04）：

| 里程碑 | 产出 | 测试 |
|---|---|---|
| M1 | `store.ts`（PluginStore）+ `adapters/registry.ts` 降级映射 | `test/store.test.ts` |
| M2 | `ranges.ts`（normalize/subtract/clamp，计划 §3.2 矩阵全过）、`hash.ts`、`render.ts`、`adapters/source.ts` | `test/ranges/hash/source-adapter.test.ts` |
| M3 | `harness.ts` 三 handler：拦截、增量读取（改写 offset/limit 只补缺失段）、锚点固定区域 | `test/harness.test.ts`（22 用例） |
| M4 | updated 分支：哈希变化重切旧范围 + clamp + truncatedNote，记忆任务投递 | 同上 + e2e 验收 #3 |
| M5 | `memory/queue.ts`（1500ms 去抖串行队列）、`agent.ts`（LLM 严格 JSON）、`project-map.ts`、`persist.ts`（custom entry + 项目地图文件） | `test/memory.test.ts` + harness 记忆用例 |
| M6 | e2e：`pi/packages/coding-agent/test/piwpi-e2e.test.ts`（createHarnessWithExtensions + faux provider 完整 agent 循环） | 5 用例，验收 #1/#2/#3/#6 + §7.3 红线 |

**§7.3 token 对比实验结果（红线通过）**：2000 行文件连续 3 次全量重读，on/off 各跑一次——
- 第二次起请求体量（messages 字符量之和）：on=60,567 vs off=116,874 → **0.518×**
- 全部请求体量：on=82,522 vs off=138,829 → **0.594×**

**全量验证**：extension 82/82 单测通过、e2e 5/5 通过、`tsgo --noEmit` 全仓 0 错误、biome 对新增文件 0 告警。

**pi 原有测试套件（验收 #7，Windows 环境实测）**：`@earendil-works/pi-coding-agent` 全量 **1749 通过 / 40 失败 / 47 跳过**。40 个失败全部位于**未做任何改动**的 pi 既有测试（`git diff --stat -- packages/` 为空），成因均为本机环境：Windows 路径分隔符（`3302-find-path-glob`，隔离复现）、EACCES 权限/套接字（4 例）、系统 ripgrep 缺失（`tools.test.ts`）、npm/session 文件差异（config/session-file 系）。piwpi 新增测试（`piwpi-e2e.test.ts`）全绿，不构成回归。

### 新增核对结论（M1-M6 期间）

1. **`ModelRegistry.complete` 只在仓库源码存在**：仓库 `core/model-registry.ts:99-107` 有 `complete`（`custom-compaction.ts:90-102` 即用此通道），但**发布的 npm 0.83.0 包中 ModelRegistry 是同步门面（无 complete）**。扩展以结构访问 `asCompleteFn(modelRegistry)`（`harness.ts`）取用——运行时拿不到就静默禁用记忆 Agent，其余功能不受影响（"换宿主只需重写挂接层"的实证）。
2. **`ReadonlySessionManager` 不含 `appendCustomEntry`**：`ExtensionContext.sessionManager` 类型是 `Pick<SessionManager, 14 个读方法>`，但运行时传入的是完整实例；用 `asCustomEntryWriter()` 安全取用（`memory/persist.ts`）。
3. **`AgentMessage` 联合类型含 `BashExecutionMessage`**（content 为 string）：onContext 遍历消息必须结构访问（`Array.isArray` 守卫），不能直接 `.filter`。
4. **pi 的 tsconfig 开 `erasableSyntaxOnly`**：piwpi e2e 文件 import 扩展源码时，扩展代码也受此约束（参数属性会报 TS1294）→ `queue.ts` 已改普通字段赋值，`extension/tsconfig.json` 已同步开启该选项防回归。
5. **safeCwd 双横线是 pi 原生行为**：`C:\Users\me\proj` → `--C--Users-me-proj--`（冒号与反斜杠各替换一个 `-`），非笔误，`persist.ts` 与 pi 一致。

### 与计划 §2.1 的两处有据偏差（已落地并在源码注释说明）

1. `identify(input, cwd)`：相对路径必须对 cwd resolve（§4.1 本身即 `(path, cwd)` 签名）；基接口保持不变，Source 用特化子接口（`SourceToolContextAdapter`，故意不 extends——参数增多时接口继承被逆变拒绝）。
2. `ingest(input, output, current, facts)`：segment 文本必须从磁盘字节重切（§3.3 字节哈希原则），经 `facts` 传入磁盘快照与实际返回范围 `got`，`output` 保留为接口兼容参数（避免尾注/截断噪声进 segment）。

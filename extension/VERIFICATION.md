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

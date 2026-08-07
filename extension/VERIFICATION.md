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
| M5 | **新模型（2026-08-06 重构）**：记忆 Agent 只在新增驱动（pending 计数 5 文件/1000 行 → 批量整理，产物只进 Project Map）；修改累积达 `max(8, 总行数×10%)` → 挂载 + map 双失效（不跑记忆 Agent）；`read_project_map` 工具（目录树）为主 Agent 读取通道。`memory/diff.ts`（LCS 变更量）、`project-map.ts`（delete/renderTree/renderBrief）、`agent.ts`（三段输入 prompt）、`queue.ts`（enqueueTask 串行链） | `test/memory.test.ts`（含 diff/树/批量）、`test/harness.test.ts` 记忆用例（新增失效/累积/批量触发） |
| M6 | e2e：`pi/packages/coding-agent/test/piwpi-e2e.test.ts`（createHarnessWithExtensions + faux provider 完整 agent 循环） | 5 用例，验收 #1/#2/#3/#6 + §7.3 红线 |

**§7.3 token 对比实验结果（红线通过）**：2000 行文件连续 3 次全量重读，on/off 各跑一次——
- 第二次起请求体量（messages 字符量之和）：on=60,567 vs off=116,874 → **0.518×**
- 全部请求体量：on=82,522 vs off=138,829 → **0.594×**

**全量验证**：extension 107/107 单测通过（含新增 diff/批量整理/失效用例）、e2e 5/5 通过、`tsc --noEmit` 0 错误、biome 对 extension 0 error/warning、real-pi demo 全断言通过。

**pi 原有测试套件（验收 #7，Windows 环境实测）**：`@earendil-works/pi-coding-agent` 全量 **1749 通过 / 40 失败 / 47 跳过**。40 个失败全部位于**未做任何改动**的 pi 既有测试（`git diff --stat -- packages/` 为空），成因均为本机环境：Windows 路径分隔符（`3302-find-path-glob`，隔离复现）、EACCES 权限/套接字（4 例）、系统 ripgrep 缺失（`tools.test.ts`）、npm/session 文件差异（config/session-file 系）。piwpi 新增测试（`piwpi-e2e.test.ts`）全绿，不构成回归。

## 五、验收 #7 补强验证（Windows 环境修复 + 基线对比 + 真实 pi 进程演示）

### 5.1 环境修复（不动 pi 任何源码）

| 修复 | 手段 | 效果 |
|---|---|---|
| 工作区未构建（dist 缺失） | `npm run build`（全包 tsgo 构建，gitignored 产物） | CLI 子进程类测试从失败转绿（session-file-invalid / session-id-readonly / startup-session-name / stdout-cleanliness 等） |
| 真实用户主目录存在第三方 `.agents/skills`（Codex 符号链接）干扰 trust 扫描 | 测试期间临时挪开（事后已恢复） | trust-manager 2/2 转绿 |

修复后全量：**1763 通过 / 26 失败 / 47 跳过**（对比修复前 1749 / 40）。

### 5.2 基线对比（piwpi 引入前这些失败已存在，零新增回归）

- 方法：`git worktree` 检出 **pristine 提交 `431e66a5`（纯 pi v0.83.0，无 extension/、无 piwpi 测试）**，junction 共享 node_modules、复制 dist 与模型数据，同一 node 22 同一 vitest 命令跑全量套件。
- 结果：pristine 基线 **1757 通过 / 27 失败**，失败文件清单与当前树**完全一致（11 个文件）**；逐测试 diff（`comm`）：
  - **in CURRENT but not BASELINE（新增回归）：空**
  - in BASELINE but not CURRENT：仅 `agent-session-concurrent` 1 例（该文件隔离运行 3/3 通过，属并发时序抖动）
  - 即当前树 26 失败 ⊆ 基线 27 失败，**piwpi 零新增回归**。

### 5.3 剩余 26 失败的根因分类（全部为 Windows 平台固有，非 piwpi 引入）

| 文件（失败数） | 根因 |
|---|---|
| config.test.ts (7) | `getSelfUpdateCommand` 内部 `spawnSync("npm"/"bun"/"pnpm"/"yarn")` 无 shell——Windows 上 .cmd 无法被 CreateProcess 直接拉起 → 检测返回 undefined（pi 源码行为，POSIX 才成立） |
| trust-selector.test.ts (3) | 组件对 cwd `/project` 做路径解析 → Windows 下变成 `E:\project`，断言字符串不匹配 |
| tools.test.ts (3) | ① 2 例 EACCES：Windows 只读位（chmod 444）不产生 EACCES，errno 映射不同；② 1 例 rg `\U`：Windows 临时路径含反斜杠，`--pre=C:\Users\...` 中 `\U` 触发 regex 引擎 "invalid hexadecimal digit"（rg 13/14 同错；上游 CI 路径无反斜杠） |
| 3302-find-path-glob (3) | find 工具返回 Windows 分隔符路径，断言期望 POSIX 分隔符 |
| sdk-session-manager (2) | 期望路径与系统提示中的 cwd 均为 `/` 分隔，Windows 实际 `\` |
| package-command-paths (2) | 同 config：spawn npm/pnpm 在 Windows 上的差异 |
| interactive-mode-suspend (2) | 测试 2/3 走 POSIX 分支（SIGTSTP/suspend），Windows 不支持；win32 分支用例（测试 1）通过 |
| 7209-model-selector (1) | All 标签页模型顺序依赖 models.dev 实时数据（本机重新生成的数据与上游 CI 快照不同） |
| 2791-fswatch (1) | 子进程 `import "E:/.../theme.ts"` 裸盘符路径——Node ESM 在 Windows 要求 file:// URL（测试自身假定 POSIX 路径语义） |
| footer-width (1) | `formatCwdForFooter` 缩写 home 后用平台分隔符 → `~\project` vs `~/project` |
| agent-session-concurrent (1) | 并发时序抖动（隔离运行 3/3 通过） |

### 5.4 真实 pi 进程演示（`pi -e extension` + 本地 mock LLM）

`extension/scripts/pi-demo/run-demo.mjs`：启动真实 **pi CLI（dist/cli.js）** 加载 `-e extension`，模型指向本地 OpenAI 兼容流式 mock 端点，跑完整 4 轮 agent 循环（read 20-40 → read 30-60 → read 30-60 → done）。实测输出：

```
PASS  pi 进程退出码 0 — exit=0
PASS  4 次 LLM 请求（实际 4 次）
PASS  扩展加载无错误
PASS  第 2 次请求中锚点消息已刷新为 render 输出 — [piwpi:plugin file:... mounted:L20-40]
PASS  锚点已合并为 L20-60 — [piwpi:plugin ... mounted:L20-60]
PASS  第 2 次 read 实际执行 41-60（新增段标记） — [piwpi: ...已挂载 L20-60，本次新增 L41-60]
PASS  新增段文本覆盖 line41..line60
PASS  第 3 次 read（已全覆盖）→ noop 短引用 — [piwpi: ...内容无变化（L20-60 已挂载于上文）]
DEMO PASSED — 真实 pi 进程内 piwpi 拦截行为验证通过
```

要点：真实进程内验证了拦截→改参→结果替换→锚点刷新→noop 全链路；另确认 openai-completions 请求体中 tool 消息 content 为纯字符串（与 AgentMessage 块数组不同），脚本按两种形态容错。

### 新增核对结论（M1-M6 期间）

1. **`ModelRegistry.complete` 只在仓库源码存在（已解决依赖漂移）**：仓库 `core/model-registry.ts:99-107` 有 `complete`（`custom-compaction.ts:90-102` 即用此通道），而**发布的 npm 0.83.0 包中 ModelRegistry 是同步门面（无 complete）**。扩展最初按 npm 包运行时记忆 Agent 通道不可用（曾静默禁用）；修复分两层：① `asCompleteFn`（`harness.ts`）结构访问回退 `modelRegistry.runtime.complete`（TS private 运行时可见），且**必须经对象属性调用保 this**（`runtime.complete` 内部依赖 `this.stream`，裸调用会崩）；② 依赖切换为 `file:../packages/coding-agent`（workspace 链接，见 `desktop/README.md`「单一版本原则」）——运行时即本地构建产物，生产路径直接走 `registry.complete`，`runtime.complete` 兜底分支保留并已有回归测试（`harness.test.ts` 门面形状用例）。会话启动输出自检日志 `[piwpi] memory agent LLM channel: ...`，不再静默。
2. **`ReadonlySessionManager` 不含 `appendCustomEntry`**：`ExtensionContext.sessionManager` 类型是 `Pick<SessionManager, 14 个读方法>`，但运行时传入的是完整实例；用 `asCustomEntryWriter()` 安全取用（`memory/persist.ts`）。
3. **`AgentMessage` 联合类型含 `BashExecutionMessage`**（content 为 string）：onContext 遍历消息必须结构访问（`Array.isArray` 守卫），不能直接 `.filter`。
4. **pi 的 tsconfig 开 `erasableSyntaxOnly`**：piwpi e2e 文件 import 扩展源码时，扩展代码也受此约束（参数属性会报 TS1294）→ `queue.ts` 已改普通字段赋值，`extension/tsconfig.json` 已同步开启该选项防回归。
5. **safeCwd 双横线是 pi 原生行为**：`C:\Users\me\proj` → `--C--Users-me-proj--`（冒号与反斜杠各替换一个 `-`），非笔误，`persist.ts` 与 pi 一致。

### 与计划 §2.1 的两处有据偏差（已落地并在源码注释说明）

1. `identify(input, cwd)`：相对路径必须对 cwd resolve（§4.1 本身即 `(path, cwd)` 签名）；基接口保持不变，Source 用特化子接口（`SourceToolContextAdapter`，故意不 extends——参数增多时接口继承被逆变拒绝）。
2. `ingest(input, output, current, facts)`：segment 文本必须从磁盘字节重切（§3.3 字节哈希原则），经 `facts` 传入磁盘快照与实际返回范围 `got`，`output` 保留为接口兼容参数（避免尾注/截断噪声进 segment）。

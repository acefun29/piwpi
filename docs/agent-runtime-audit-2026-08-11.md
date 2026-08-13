# Agent 执行链路、上下文与前缀缓存审计

日期：2026-08-11

## 1. 审计范围与方法

本次审计只阅读真实代码，没有使用 Mock、假数据或模拟结果，也没有修改实现。范围包括：

- `packages/agent`：Agent 循环、工具执行、事件流、取消与错误结束。
- `packages/coding-agent`：会话运行时、RPC、上下文转换、压缩、工具注册和供应商请求入口。
- `extension`：piwpi 文件挂载、Project Map、记忆 Agent、磁盘扫描与调试快照。
- `desktop`：Electron、HTTP bridge、SSE/RPC、会话/项目切换和历史渲染。

结论分为两类：

- **已确认**：仅根据代码控制流即可证明，不依赖特定机器性能。
- **需实测定量**：浪费机制已存在，但实际严重程度取决于会话大小、文件数量、模型和磁盘。

## 2. 结论摘要

目前最值得优先处理的不是模型供应商层，而是 piwpi 自己增加的上下文挂载、后台记忆和桌面桥接之间的状态一致性。

| 优先级 | 问题 | 性质 | 主要后果 |
| --- | --- | --- | --- |
| P0 | 上下文扩展修改临时 clone 后清除 dirty | 已确认 | 文件内容下一轮回退为旧值；增量 read 当轮重复注入；破坏缓存前缀 |
| P0 | 首次 prompt 没有发送锁，RPC 预检可并发 | 已确认 | UI 出现幽灵用户消息，底层可能静默丢弃第二条请求 |
| P0 | 本地 bridge 的 Agent 控制接口没有鉴权 | 已确认 | 其他本地进程或网页可尝试驱动 Agent、修改配置或读取会话 |
| P0 | 记忆 Agent 完成时不复核 generation/hash | 已确认 | 被删除/失效的挂载可能被后台旧任务重新写回，Project Map 可写入旧结论 |
| P1 | 会话关闭会启动并等待隐藏的记忆 LLM | 已确认 | 切换会话/项目最多额外等待 5 秒并消耗模型 token |
| P1 | 项目切换缺少互斥和响应代次 | 已确认 | 多个 runtime replacement 重叠，旧响应覆盖新 UI |
| P1 | SSE 重连后不重新同步状态 | 已确认 | UI 与 Agent 脱节，用户重试可能制造重复请求 |
| P1 | 每次模型请求前完整 clone 上下文并扫描文件 | 已确认；耗时需实测 | 长会话、多工具轮次的首 token 延迟持续增加 |
| P1 | 当前模式不可用的工具仍进入 system prompt/schema | 已确认 | 固定 token 浪费、缓存前缀变大、模型可能调用后再被拒绝 |
| P1 | 缺少终止事件时 `EventStream.result()` 永久 pending | 已确认 | 代理流提前关闭时 Agent 永久卡住 |
| P2 | 同一次会话变化触发重复状态/会话列表/上下文刷新 | 已确认 | 重复递归扫描会话文件和 RPC 序列化 |
| P2 | “并行工具”准备阶段仍串行 | 已确认 | 多个 `beforeToolCall` 的延迟相加 |
| P2 | 工具更新 Promise 无界累积 | 已确认 | 高频更新工具的内存和事件延迟线性增长 |
| P2 | 图片被降级后仍按图片估算压缩阈值 | 已确认；触发频率需实测 | 过早 compaction，额外摘要调用和上下文损失 |
| P2 | 长会话切换全量重建 DOM/Markdown | 已确认；卡顿程度需实测 | 多对话切换阻塞渲染线程和输入焦点 |

## 3. 详细发现

### P0-1：文件挂载上下文只在临时 clone 中更新，下一轮会回退

证据：

- [`packages/coding-agent/src/core/extensions/runner.ts:984`](../packages/coding-agent/src/core/extensions/runner.ts#L984) 在每次请求前对全部消息执行 `structuredClone(messages)`，扩展收到的不是会话中的原对象。
- [`extension/src/harness.ts:1004`](../extension/src/harness.ts#L1004) 只刷新 `dirtyPlugins` 中的锚点。
- [`extension/src/harness.ts:1024`](../extension/src/harness.ts#L1024) 无论刷新是否写回持久会话，都立即删除 dirty 标记。
- [`packages/agent/src/agent-loop.ts:288`](../packages/agent/src/agent-loop.ts#L288) 转换结果只用于本次 provider 请求，没有替换 `currentContext.messages`。

可直接推出以下执行序列：

1. 第一次 `read` 的原始 tool result 保存在真实会话中。
2. 下一次请求前，piwpi 在 clone 中把旧锚点替换成带挂载元数据的渲染文本，然后清除 dirty。
3. 再下一次请求重新从真实会话 clone；真实会话仍是旧 tool result，但 dirty 已被清除，因此内容回退。

这会产生三个确定问题：

- 外部小改后的新文件内容只对模型可见一轮，之后又回到会话里保存的旧内容。
- 文件被删除/挂载失效的提示只存在一轮，后续旧文件内容重新出现。
- 增量 read 的当轮请求同时包含“已扩展后的旧锚点全文”和“本次新增范围正文”。例如旧锚点从 L20-40 扩为 L20-60 时，L41-60 会在同一次请求中出现两次。相关返回位于 [`extension/src/harness.ts:848`](../extension/src/harness.ts#L848)。

缓存影响：旧锚点位于历史较前位置。它在“原始内容 → 扩展内容 → 原始内容”之间变化，provider 无法稳定复用该锚点之后的前缀。

最薄修复方向：先建立单一不变量——发送给模型的挂载视图必须每轮可重复计算且结果相同。不要在修改临时 clone 后清除唯一刷新依据。若同时追求缓存，应避免改写历史消息，改为在尾部追加一次确定性的增量/失效记录，并保持旧历史不可变。

验证：真实读取同一文件的两个不连续范围，连续捕获三次 `before_provider_request` payload；逐次比较锚点内容、重复区间和 provider 的 `cacheRead/cacheWrite/input`。

### P0-2：快速连续发送时，第二条 prompt 可能在 UI 中存在、在 Agent 中静默丢失

证据：

- [`desktop/web/app.js:957`](../desktop/web/app.js#L957) 发送前没有 `promptPending` 锁。
- [`desktop/web/app.js:968`](../desktop/web/app.js#L968) 是否附带 `streamingBehavior` 只看异步事件更新的前端 `streaming`；首个 `agent_start` 到达前，连续两次发送都会被当成初始 prompt。
- [`desktop/web/app.js:971`](../desktop/web/app.js#L971) UI 先插入用户消息，再用无 id 的 `rpcRaw()` 发送。
- [`packages/coding-agent/src/modes/rpc/rpc-mode.ts:930`](../packages/coding-agent/src/modes/rpc/rpc-mode.ts#L930) 每行输入通过 `void handleInputLine(line)` 并发处理，没有命令串行化。
- [`packages/coding-agent/src/core/agent-session.ts:1302`](../packages/coding-agent/src/core/agent-session.ts#L1302) prompt 在真正进入 `Agent.runWithLifecycle()` 前先报告 preflight 成功。
- [`packages/agent/src/agent.ts:482`](../packages/agent/src/agent.ts#L482) 真正执行时才用 `activeRun` 拒绝并发 Agent run。
- [`packages/coding-agent/src/modes/rpc/rpc-mode.ts:395`](../packages/coding-agent/src/modes/rpc/rpc-mode.ts#L395) preflight 已成功后，后续 rejection 不再发送错误响应。

因此两个 prompt 可同时通过较早的鉴权/扩展预检，其中一个随后在 Agent 活动锁处失败；因为 preflight 已报告成功，RPC 不再上报这个失败，而前端已经显示了用户消息。

最薄修复方向：初始 prompt 必须用带 id 的 `rpc()`；preflight 返回前设置 `promptPending` 并禁止第二次初始发送。只有确认 Agent 已 streaming 后，后续输入才明确作为 `followUp` 发送。UI 只在 preflight 成功后提交消息，或在失败时移除/标红临时消息。

验证：真实模型下连续快速按两次 Enter，对照 UI 消息、`prompt` response、`agent_start` 和最终 session JSONL，四者数量必须一致。

### P0-3：localhost bridge 没有任何请求鉴权

证据：

- [`desktop/server/bridge.mjs:593`](../desktop/server/bridge.mjs#L593) 所有 HTTP 路由只按路径和方法分发，没有 token、Origin 或客户端身份校验。
- [`desktop/server/bridge.mjs:610`](../desktop/server/bridge.mjs#L610) `/api/rpc` 可直接向 pi stdin 写任意 RPC 命令。
- [`desktop/server/bridge.mjs:627`](../desktop/server/bridge.mjs#L627) 至 [`desktop/server/bridge.mjs:660`](../desktop/server/bridge.mjs#L660) 可读取、写入和删除供应商配置。
- [`desktop/server/bridge.mjs:680`](../desktop/server/bridge.mjs#L680) 可枚举全部注册项目的会话。
- [`desktop/server/bridge.mjs:696`](../desktop/server/bridge.mjs#L696) 可删除会话文件。

只绑定 `127.0.0.1` 不是授权边界。其他本地进程可以直接调用；浏览器页面也可通过端口探测和不要求读取响应的请求尝试触发简单 POST。`/api/rpc` 最终能发送 prompt，而 Agent 拥有 bash/edit/write 等工具，因此风险不仅是信息泄露，还包括模型费用和项目写操作。

最薄修复方向：bridge 启动时生成高熵临时 token，通过 Electron preload 只交给当前窗口；所有 `/api/*`、debug 代理和 SSE 都校验 token。不要先增加账户系统或复杂权限模型。

验证：不带 token 的本地 `curl` 请求所有控制端点都应返回 401/403；当前 Electron 窗口仍能正常运行。

### P0-4：旧记忆任务可在状态变化后写回并复活已失效挂载

证据：

- [`extension/src/harness.ts:578`](../extension/src/harness.ts#L578) 收集当前 pending 插件和磁盘内容。
- [`extension/src/harness.ts:600`](../extension/src/harness.ts#L600) 等待一次不受会话 generation 约束的 LLM 调用。
- [`extension/src/harness.ts:610`](../extension/src/harness.ts#L610) LLM 返回后直接使用调用前捕获的 `plugin`、`lines`、`hash`。
- [`extension/src/harness.ts:620`](../extension/src/harness.ts#L620) 不复核插件是否仍在 store，直接 `store.upsert(plugin)`。
- [`extension/src/harness.ts:626`](../extension/src/harness.ts#L626) 不复核磁盘 hash，直接更新 Project Map。

如果记忆 LLM 往返期间文件发生大改、被删除或挂载被 scan 移除，旧任务完成后会把旧插件重新插入 store，并用旧内容生成的身份信息覆盖项目地图。这是实际的异步 TOCTOU，而不是理论上的性能问题。

最薄修复方向：任务捕获 `sessionGeneration + pluginId + hash`；LLM 返回后仅当 generation 仍有效、store 仍存在该插件且当前 hash 与任务 hash 相同才提交结果。任何一项不一致就丢弃旧结果。

验证：真实触发一次记忆整理，在请求未返回前修改或删除对应文件；返回后 store 和 Project Map 不得恢复旧 hash/旧条目。

### P1-1：会话/项目切换会为了关闭旧扩展而启动隐藏 LLM 调用

证据：

- [`packages/coding-agent/src/core/agent-session-runtime.ts:160`](../packages/coding-agent/src/core/agent-session-runtime.ts#L160) runtime replacement 在创建新会话前等待 `session_shutdown` handler。
- [`extension/index.ts:51`](../extension/index.ts#L51) `session_shutdown` 等待 `harness.shutdown()`。
- [`extension/src/harness.ts:1085`](../extension/src/harness.ts#L1085) shutdown 调用 `memoryQueue.flush(5000)`。
- [`extension/src/memory/queue.ts:60`](../extension/src/memory/queue.ts#L60) flush 会主动派发尚未开始的任务，而不只是等待已运行任务。
- [`extension/src/harness.ts:600`](../extension/src/harness.ts#L600) 任务会调用模型。

结果是用户切换会话时，旧会话可能突然发起一笔新的记忆模型请求，并让切换最多等待 5 秒。超时只是 `Promise.race` 拒绝，底层 LLM Promise 不会取消；旧任务仍可在切换完成后继续写旧会话和 Project Map。

最薄修复方向：shutdown 取消尚未开始的任务，不得在 teardown 路径启动新模型调用；运行中的任务绑定 AbortSignal 和 generation，超时后结果必须失效。

### P1-2：记忆 Agent 使用当前主模型，但没有独立预算和使用量可见性

证据：

- [`extension/src/harness.ts:584`](../extension/src/harness.ts#L584) 直接取当前 `modelRegistry/currentModel`。
- [`extension/src/memory/agent.ts:132`](../extension/src/memory/agent.ts#L132) 调用 `complete()` 时没有输出 token 上限、独立 session id、cache 策略或专用模型。
- [`extension/src/harness.ts:833`](../extension/src/harness.ts#L833) 文件数/行数达到阈值会在后台自动触发。
- [`extension/src/harness.ts:1141`](../extension/src/harness.ts#L1141) 即使未达到初始文件阈值，每轮 settled 也会递减阈值并最终触发。

这意味着普通主 Agent 对话会产生用户不可见的额外模型请求。该请求使用完全不同的 system prompt 和动态文件批次，不能复用主 Agent 的长对话前缀；使用昂贵主模型时成本尤其明显。目前桌面上下文统计也不包含这部分调用。

最薄修复方向：先明确产品语义：若保留自动记忆，使用显式低成本模型、关闭推理并限制输出；同时记录独立 usage。若没有配置专用模型，不要隐式使用当前主模型。

### P1-3：项目切换没有互斥锁和 UI generation

证据：

- [`desktop/web/app.js:2039`](../desktop/web/app.js#L2039) 只有 `sessionSwitching`。
- [`desktop/web/app.js:2254`](../desktop/web/app.js#L2254) `switchProjectPath()` 没有对应锁。
- [`desktop/web/app.js:2262`](../desktop/web/app.js#L2262) 每个并发调用都会等待 cwd、重置视图并再次执行 `initSession()`。
- [`packages/coding-agent/src/core/agent-session-runtime.ts:233`](../packages/coding-agent/src/core/agent-session-runtime.ts#L233) 每个 `switchProject` 都 teardown 当前 session 并创建 runtime。

快速选择多个项目时，多个 replacement 可交叉运行；较早请求的 `get_state/get_messages/debug` 结果可能晚到并覆盖最终项目 UI。

最薄修复方向：项目切换期间禁止第二次切换；为切换和初始化增加递增 generation，任何旧 generation 的响应不得写 UI。

### P1-4：SSE 自动重连后没有状态恢复协议

证据：

- [`desktop/web/app.js:646`](../desktop/web/app.js#L646) `esOpened` 只创建并 resolve 一次。
- [`desktop/web/app.js:651`](../desktop/web/app.js#L651) EventSource 重连后的 `onopen` 只清 banner，不重新请求 `get_state/get_messages`。
- [`desktop/server/bridge.mjs:258`](../desktop/server/bridge.mjs#L258) bridge 只广播实时 stdout 行，不保存可重放事件。

断线期间 prompt 可能已经被 pi 接收和执行，但 response/stream 事件对前端丢失。重连后 UI 仍沿用旧 `streaming`、消息和会话状态，用户再次发送时容易制造重复操作。

最薄修复方向：每次 SSE connection generation 变化后暂停发送，执行一次 `get_state + get_messages` 权威同步，再恢复输入。pending RPC 要按连接代次失效并明确告知“状态未知”，不能暗示请求未执行。

### P1-5：每次 provider 请求前都复制完整历史并执行同步前置工作

证据：

- [`packages/coding-agent/src/core/sdk.ts:350`](../packages/coding-agent/src/core/sdk.ts#L350) 每个 Agent 都无条件安装 `transformContext`。
- [`packages/coding-agent/src/core/extensions/runner.ts:984`](../packages/coding-agent/src/core/extensions/runner.ts#L984) 每次调用无条件 `structuredClone` 全部消息；即使没有 context handler 也会 clone。
- [`extension/src/harness.ts:957`](../extension/src/harness.ts#L957) piwpi context handler 每次请求都先扫描磁盘。
- [`extension/src/harness.ts:353`](../extension/src/harness.ts#L353) 64 个以内每轮全量 stat，超过后每轮检查 32 个。
- [`extension/src/harness.ts:1042`](../extension/src/harness.ts#L1042) 每轮再次遍历全部消息生成调试摘要。

同一个用户问答包含多次工具调用时，每次工具结果后再次请求模型都会重复上述工作。上下文越长、文件越多，请求发到 provider 之前的 CPU、内存、GC 和文件系统耗时越大。这不直接增加 token，但会增加首 token 延迟。

最薄修复顺序：

1. `emitContext` 在没有 handler 时直接返回，不 clone。
2. piwpi 不要为了调试面板在每次 provider 请求前复制全部摘要；只在面板需要或 agent settled 后生成。
3. 磁盘变化检测从请求关键路径移出，使用明确事件或 settled 后检查；先记录真实耗时再决定是否需要更复杂机制。

验证：在 1k、10k、50k 消息及 0、32、64 个挂载文件下记录 `transformContext` 进入/退出时间、clone 次数、stat/readFile 数量和 provider request 实际开始时间。

### P1-6：当前协作模式不可执行的工具仍被发送给模型

证据：

- [`extension/index.ts:82`](../extension/index.ts#L82) `request_user_input` 只允许 plan。
- [`extension/index.ts:124`](../extension/index.ts#L124) `update_plan_document` 只允许 plan。
- [`packages/coding-agent/src/core/agent-session.ts:928`](../packages/coding-agent/src/core/agent-session.ts#L928) 模式限制只在真正执行工具时检查。
- [`packages/coding-agent/src/core/agent-session.ts:939`](../packages/coding-agent/src/core/agent-session.ts#L939) 切换模式只重建 system prompt，没有过滤 `agent.state.tools`。
- [`packages/coding-agent/src/core/agent-session.ts:2567`](../packages/coding-agent/src/core/agent-session.ts#L2567) extension tools 被加入 active tool 列表。

因此默认模式仍携带两个 plan-only 工具的完整 schema、snippet 和 guideline。固定成本会出现在每个请求中；模型如果误调用，执行阶段才收到“当前模式不可用”的错误，额外浪费一轮。

最薄修复方向：构建 provider context 和 system prompt 时只包含当前 `collaborationMode` 可执行的工具；切换模式时一次性重算该列表。

### P1-7：代理流正常关闭但缺少终止事件时，Agent 永久等待 final result

证据：

- [`packages/ai/src/utils/event-stream.ts:38`](../packages/ai/src/utils/event-stream.ts#L38) `end()` 只有收到显式 result 才 resolve `finalResultPromise`。
- [`packages/agent/src/proxy.ts:183`](../packages/agent/src/proxy.ts#L183) 远端流读到 EOF 后可以直接退出循环。
- [`packages/agent/src/proxy.ts:213`](../packages/agent/src/proxy.ts#L213) EOF 路径调用无 result 的 `stream.end()`。
- [`packages/agent/src/agent-loop.ts:362`](../packages/agent/src/agent-loop.ts#L362) assistant 流结束后仍等待 `response.result()`。

如果代理连接在没有 `done/error` 事件时正常 EOF，异步迭代结束，但 `result()` 永不 resolve，Agent 卡在处理中。

最薄修复方向：无终止事件的 EOF 必须生成明确 error/aborted assistant message；`EventStream.end()` 不允许留下永远 pending 的 final result。

## 4. 次级问题

### P2-1：会话变化触发重复 RPC 和磁盘扫描

[`desktop/web/app.js:485`](../desktop/web/app.js#L485) 的 `session_start` 会发一次 `get_state`、调用两次 `refreshSessions()`，同时新建/恢复/项目切换自己的流程又会请求相同数据。`/api/sessions` 在 [`desktop/server/bridge.mjs:680`](../desktop/server/bridge.mjs#L680) 会递归扫描所有注册项目的 `.piwpi/sessions`。

上下文刷新也在 message end、tool end、agent settled、compaction 和 session start 多处调度。现有序号只丢弃旧响应，不取消已经进入 pi 的 `get_context_breakdown`。

最薄修复方向：每次 session replacement 只保留一个权威刷新入口；`refreshSessions` 和 context breakdown 使用 single-flight。

### P2-2：并行工具的准备阶段实际串行

[`packages/agent/src/agent-loop.ts:499`](../packages/agent/src/agent-loop.ts#L499) 在 parallel 分支里逐个 `await prepareToolCall()`；真正的 `Promise.all()` 到 [`packages/agent/src/agent-loop.ts:540`](../packages/agent/src/agent-loop.ts#L540) 才开始。因此多个慢 `beforeToolCall` 的耗时会相加。

最薄修复方向：parallel 模式下并行完成互不依赖的 prepare，再保持原 tool call 顺序汇总结果。

### P2-3：工具更新事件 Promise 无界累积

[`packages/agent/src/agent-loop.ts:671`](../packages/agent/src/agent-loop.ts#L671) 为每个 partial update 保存一个 Promise，直到工具结束才 `Promise.all()`。高频输出工具会线性积累闭包、partial result 和 listener Promise。

最薄修复方向：使用有界队列；对 UI 进度类更新只保留最新未消费状态。

### P2-4：AgentLoop 的 EventStream 包装器只处理成功，不处理 rejection

[`packages/agent/src/agent-loop.ts:40`](../packages/agent/src/agent-loop.ts#L40) 和 [`packages/agent/src/agent-loop.ts:80`](../packages/agent/src/agent-loop.ts#L80) 都只有 `.then(stream.end)`，没有 rejection 分支。直接使用公开 `agentLoop()/agentLoopContinue()` 的消费者遇到 `convertToLlm` 或 event sink 抛错时，流不会结束。

coding-agent 当前主路径使用 `runAgentLoop()` 并由 Agent lifecycle 捕获，因此该问题主要影响包 API 的其他调用方，但仍是确定的挂死点。

### P2-5：图片降级后的实际 payload 与 compaction 估算不一致

[`packages/coding-agent/src/core/compaction/compaction.ts:244`](../packages/coding-agent/src/core/compaction/compaction.ts#L244) 每张图片固定按约 1200 token 估算；[`packages/coding-agent/src/core/sdk.ts:255`](../packages/coding-agent/src/core/sdk.ts#L255) 在 `blockImages` 时把图片替换成很短的文本；非视觉模型也会在 [`packages/ai/src/api/transform-messages.ts:35`](../packages/ai/src/api/transform-messages.ts#L35) 做类似转换。

结果是压缩判断可能显著高估实际 provider payload，过早触发摘要 LLM，切断本可复用的历史前缀。

最薄修复方向：compaction 估算使用与真实请求相同的 `convertToLlm` 和图片降级结果。

### P2-6：长会话切换全量重建历史 DOM

[`desktop/web/app.js:874`](../desktop/web/app.js#L874) 对全部消息同步创建 DOM 和解析 Markdown；[`desktop/web/app.js:191`](../desktop/web/app.js#L191) 随后再分片高亮全部代码块。快速切换时只有高亮任务有 generation，历史 DOM 构建本身不可取消。

最薄修复方向：先给历史重建增加 generation，旧任务不得继续提交；再根据实测决定是否只渲染最近消息或做可视区虚拟化。

### P2-7：所有 SSE 客户端共享同一 Agent 事件流

[`desktop/server/bridge.mjs:258`](../desktop/server/bridge.mjs#L258) 将 pi stdout 广播给全部客户端，事件没有 client id。多个浏览器标签会同时把任一页面发起的 Agent 流当成自己的会话渲染。

最薄修复方向：当前产品若只支持一个桌面 UI，直接拒绝第二个控制客户端；以后确有多客户端需求再引入 client id。

## 5. 没有发现的缓存问题

本次没有发现 system prompt 每轮自动加入时间戳、随机 UUID 或随机排序的确定证据。当前 cwd、AGENTS 文件、skills 和工具注册顺序在单个 session 内总体稳定。不要为了“可能缓存不稳”先引入排序层或 prompt hash 缓存；应先修复已经确认的历史锚点改写和无关工具 schema。

## 6. 建议实施顺序

1. 修复 P0-1，建立“发送上下文可重复、历史不回退”的单一不变量，并用真实 provider payload 验证重复内容与 cache usage。
2. 修复 P0-2、P1-3、P1-4：prompt、项目切换、连接恢复各自只能有一个权威状态机。
3. 给 bridge 增加进程级临时 token，封住未授权 Agent 控制面。
4. 给记忆任务增加 AbortSignal、session generation 和 hash 提交校验；shutdown 不再启动新 LLM。
5. 把全量 clone、调试摘要和磁盘扫描移出每次 provider 请求的关键路径，并过滤当前模式不可用工具。
6. 修复 EventStream 终止语义，再处理并行工具准备和更新队列。
7. 最后对长会话历史渲染、会话列表扫描和 compaction 估算做定量优化。

## 7. 建议增加的真实观测指标

不需要引入模拟数据，先记录真实链路即可：

- `promptReceived → preflightAccepted → providerRequestStarted → firstToken` 四段耗时。
- 每次 provider 请求的 system/tools/messages 字节数与稳定前缀 hash。
- provider 返回的 `input/cacheRead/cacheWrite/output`，区分主 Agent、compaction、memory Agent。
- `transformContext` 耗时、clone 消息数、stat/readFile/hash 次数。
- session/project generation、SSE connection generation、被丢弃的旧响应数量。
- 历史 DOM 重建耗时、节点数和主线程长任务。

这些指标足以直接判断后续优化是否减少了真实延迟、上下文和缓存浪费。

# Agent 运行时修复计划（基于 docs/agent-runtime-audit-2026-08-11.md）

## Context

根据审计文档 `docs/agent-runtime-audit-2026-08-11.md`（全部 25 处代码锚点已由 4 个 scout 对照当前仓库逐一验证，仅 ±1 行漂移、无实质出入）产出可执行修复计划。审计确认 3 个 P0（上下文锚点回退、prompt 静默丢失、bridge 无鉴权）、7 个 P1、7 个 P2 问题。本计划按审计 §6 建议顺序组织为 9 个阶段，每阶段独立可验证，前一阶段验证通过再进入下一阶段。

已确认的两个方案决策（用户拍板）：
- **P0-1 采用"历史不可变 + 尾部增量记录"**：不改写历史消息中的锚点，改为在尾部追加确定性增量/失效记录。
- **P1-2 记忆模型策略**：在模型供应商界面新增"记忆 Agent 模型"设置，默认关闭，用户从已配置供应商的可用模型中选择低成本模型并保存 provider/model ID；未选择时不运行自动记忆、只提示一次；环境变量保留给命令行使用，不作为桌面端唯一配置方式。

执行第一步：把本计划复制为 `docs/agent-runtime-fix-plan-2026-08-11.md`（与审计同目录），作为交付物之一。

## 阶段 1 — P0-1：上下文锚点回退（历史不可变 + 尾部增量记录）

### 现状（已验证）
- `packages/coding-agent/src/core/extensions/runner.ts:984` `emitContext(messages)`：L986 先 `structuredClone(messages)`，L988-989 才检查 handler；转换结果经 `agent-loop.ts:291-294` 只用于 `convertToLlm` 进 provider，从不写回 `currentContext.messages`。
- `extension/src/harness.ts:957` `onContext(event, ctx)`：先 `scanDiskChanges()`（L962，函数在 L425，`pickScanBatch` L354：≤64 全量 stat，否则每轮 32），再对 clone 内的旧锚点做重渲染（`case "increment"` L848 是真实 tool result 改写、会进历史，保留不动；`new` 在 ~818、`updated` 在 ~870），刷新循环 L1004-1025：`if (!dirtyPlugins.has(plugin.id)) continue;`（L1006）→ 锚点原地替换（L1018-1019）→ **L1024 无条件 `dirtyPlugins.delete(plugin.id)`**（在 L1025 `if (!refreshed) continue;` 之前）。真实会话里锚点消息文本永不持久化（`persistPlugin` L283 只写元数据），dirty 清除后下一轮 clone 不再刷新 → 内容回退。
- 增量 read 的重复注入：刷新循环把旧锚点 L20-40 渲染成 L20-60 全文，同轮请求里 increment 结果消息已含 L41-60 正文 → 同段出现两次。

### 改动步骤

1. **`extension/src/harness.ts`：把"刷新循环"（L1004-1025）替换为确定性增量计算，不再改写任何历史消息。**
   - 删除对 `event.messages` 中锚点 `msg.content` 的原地替换；历史消息原样透传。
   - 新增 `private buildMountDelta(store: PluginStore, fileCache: FileCache): string`：对每个已挂载插件，取内存 `PluginStore` 中 `plugin.hash`（该元数据由 `persistPlugin` 在挂载/重挂载时写入会话 custom entries，无需重读会话）与 `fileCache` 当前磁盘 hash 比较；hash 不同 → 产出增量条目；文件缺失 → 产出"文件已删除，挂载失效"条目；hash 相同 → 不产出。
   - 增量条目文本格式（确定性，**不得含时间戳等运行时变化字段**，否则破坏"相同输入→相同输出"不变量）：
     ```
     [piwpi 挂载更新]
     - <path>（<range>）：内容已变化，当前 hash <h>；当前内容：
     <render(plugin, lines)>
     - <path>：文件已删除，挂载失效
     ```
   - 插件遍历顺序必须确定：按 plugin id 排序（`store.all()` 若为插入序则先 `sort`），保证相同磁盘状态产出字节一致文本。
   - delta 为空串时（无变化挂载）不追加任何内容——模型视图 = 纯历史。
   - 无 handler 依赖该 Set 的情况下删除 `dirtyPlugins`（先 grep `dirtyPlugins` 确认仅 L210 声明、L1006/L1024 使用；若另有引用则保留但停止在 L1024 清除）。新机制完全基于 hash 比较，没有"清除刷新依据"这一步——不变量由构造保证。
2. **`extension/src/harness.ts` `onContext`：把 delta 追加到返回数组的最后一条消息内容上。**
   - 确认 `onContext` 当前返回的 `ContextEventResult` 形状（runner.ts:994-996 用 `result.messages` 替换 currentMessages）；改为返回 `{ messages: [...event.messages, lastWithDelta] }`。
   - `lastWithDelta` = 最后一条消息，delta 追加到其 content 末尾：content 为字符串 → `content + "\n\n" + delta`；content 为块数组 → `[...content, { type: "text", text: delta }]`。最后一条消息在本轮必为 user 消息或 toolResult 消息（assistant 消息在 provider 调用后才入历史），两种形态都安全。
   - 保留 `case "increment"`（L848）对当前 read tool result 的改写——那是进真实历史的工具输出，不是 bug。
   - 效果：旧锚点 L20-40 + increment 结果 L41-60 都在历史中，磁盘未变 → delta 为空 → 无重复注入；磁盘变化 → delta 携带当前内容，历史仍不可变。
3. **`packages/coding-agent/src/core/extensions/runner.ts`：`emitContext` 惰性 clone。**（属 P1-5 的独立修复，与 delta 无依赖，可同期做）L986 的 clone 移到 handler 检查之后：`let currentMessages = messages;`，进入 handler 循环时若 `currentMessages === messages` 才 `structuredClone(messages)`。无 handler → 原样返回 `messages`，零拷贝。

### 本阶段验证
- 单元测试（`cd piwpi/extension && npx vitest run test/harness.test.ts`，扩展 `harness.test.ts` 的 onContext 用例）：
  1. 会话含旧锚点 L20-40 + 磁盘文件已变为 L20-60 → 输出 messages：历史锚点消息 content 与输入逐字节相同（不可变断言）；最后一条消息尾部含 delta，delta 含新范围正文且不含时间戳。
  2. 相同输入连续调用两次 → delta 文本逐字节相同（确定性断言）。
  3. 磁盘未变化 → delta 为空、消息数与输入相同。
  4. 文件删除 → delta 含"文件已删除，挂载失效"。
- 既有回归：`cd piwpi/extension && npm test`、`cd piwpi/packages/coding-agent && npx vitest --run test/extensions-runner.test.ts`（L588 唯一直接调 emitContext 的用例）与 `cd piwpi/packages/coding-agent && npm test` 全绿。
- 真实链路（审计 P0-1 验证）：临时在 `agent-loop.ts:294` 前 `console.log` 转换后 `llmMessages` 长度与前缀 hash（阶段 9 的埋点落地后移除），对同一文件连续发起两次 read+问答：第二次请求的 payload 中锚点内容不回退、无重复区间；provider `cacheRead` 在第二次请求时应增长（可用 `packages/coding-agent/src/core/cache-stats.ts` 对两次会话 entry 事后聚合核对）。

## 阶段 2 — P0-2：prompt 发送锁与 RPC 串行化

### 现状（已验证）
- `desktop/web/app.js:957` `sendMessage`：L968-970 只按前端 `streaming`（`agent_start`/`agent_settled` 置位，L373-381）决定 `streamingBehavior`；L971 `addUserMsg` 先于 L973 `rpcRaw(cmd)` 提交，失败仅 toast 无回滚；`rpcRaw`（L122）无 id 无 pending；`rpc`（L133）带 id `web-${++reqSeq}` 注册 pending（L140、L361-367）。无 `promptPending`。
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts:395` `case "prompt"`：`preflightResult(true)` 回调输出 success（L1302-1303 位于 agent-session）；`.catch` 仅在 `!preflightSucceeded` 时输出 error —— preflight 通过后 `agent.prompt` 被 `activeRun` 拒绝（agent.ts:347-350、482-484）的失败被静默吞掉。L930-932 `attachJsonlLineReader` 逐行 `void handleInputLine` 无串行化。
- 前端无 id 的 `rpcRaw` 导致 response 分支（L368-369）只 toast、无法定位对应消息。

### 改动步骤

1. **`desktop/web/app.js` `sendMessage`（L957）重构为"先确认后提交" + promptPending 锁：**
   - 新增 `let promptPending = false;`（L152 `streaming` 声明旁）。
   - 初始 prompt（`!streaming`）：`if (promptPending) { toast("上一条消息仍在处理中", "error"); return; }` → `promptPending = true` → `const evt = await rpc({ type: "prompt", message: text })`（带 id，不用 `rpcRaw`）→ 仅当 `evt.success !== false` 才 `addUserMsg(text, false)`；`evt.success === false`（preflight 拒绝）或 rpc reject（超时/HTTP 错）→ `promptPending = false` + toast（消息不出现）。注意 `rpc()` 的 pending 在 SSE `case "response"`（L361-367）是**无条件 resolve**（不按 success 分派），调用方必须自己检查 `evt.success`。
   - followUp（`streaming`）：同样改 `await rpc({ type: "prompt", message: text, streamingBehavior: "followUp" })`，成功后 `addUserMsg(text, true)`。
   - 清除点：`setStreaming(true)`（L334-337）内 `promptPending = false`；`agent_settled`、`initSession`（L699 恢复处）、`resetChatView`（L727）、`resumeSession`（L2236）同步复位。`rpc` 默认 15s 超时对 preflight 足够（preflight 全本地），超时按现有 pending 逻辑 reject → 走失败分支。
2. **`packages/coding-agent/src/modes/rpc/rpc-mode.ts` `case "prompt"`（L395）加初始 prompt 串行化：**
   - 新增模块级 `let initialPromptInFlight = false;`。
   - `if (!command.streamingBehavior && initialPromptInFlight) { output(error(id, "prompt", "另一条初始消息正在处理中")); return undefined; }`；`!command.streamingBehavior` 时置 `initialPromptInFlight = true`。
   - `preflightResult` 回调里 `if (!command.streamingBehavior) initialPromptInFlight = false;`（成功与失败都清）。
   - 保持 `.catch` 的 `!preflightSucceeded` 守卫不变——双锁（前端 promptPending + 后端 flag）使"preflight 通过后 activeRun 拒绝"路径不可达；运行期错误仍走 SSE error 事件上报，不双报。
   - 效果：连续两次 Enter，第二条要么被前端拦截、要么被 rpc-mode 拒绝并收到 error 响应（preflight 失败路径已有 error 输出，L395-416 现逻辑），不会静默丢失。
3. 前端 SSE 响应分支（L361-369）无需改：`prompt` 成功/失败响应都带 id，失败时 toast 已存在；消息"未提交"策略保证不会留下幽灵消息。

### 本阶段验证
- 单元测试（扩展 `cd piwpi/packages/coding-agent && npx vitest --run test/rpc-prompt-response-semantics.test.ts`，现 3 用例断言 preflight 失败 1 条 error / 成功 1 条 success / 流式排队 1 条 success）：新增用例 4——preflight 期间第二条初始 prompt → 恰好 1 条 error 响应且 id 匹配；用例 5——初始 prompt 成功后 followUp 正常接受。
- 前端语法：`cd piwpi/desktop && npm run typecheck:web`。
- 真实链路（审计 P0-2 验证）：`cd piwpi/desktop && npm run dev:web` 后真实模型连续快速按两次 Enter：UI 用户消息数、`prompt` response 数、`agent_start` 数、`<session>.jsonl` 中 user 消息数四者一致；第二条被拦截/拒绝且无幽灵消息。（rpc-mode 改动需先 `cd piwpi/packages/coding-agent && npm run build` 再起 desktop。）

## 阶段 3 — P1-3 项目切换互斥 + P1-4 SSE 重连状态恢复

### 现状（已验证）
- `app.js`：`switchProjectPath`（L2254-2273）无锁无 generation，并发调用各自执行"rpc switch_project → waitDebugCwd → refreshProjectInfo → setView/resetChatView → initSession"；`sessionSwitching`（L2039）只在 `resumeSession`（L2204-2206）用。`get_state/get_messages/debug` 响应无 generation 丢弃（唯一 generation：`ctxFetchSeq` L1296-1299、`historyHighlightGeneration` L157）。
- `esOpened`（L649）只 resolve 一次；`connectEvents`（L651-662）`es.onopen`（L653-657）只清 banner，重连后不重新请求 `get_state/get_messages`。bridge `broadcast`（L260-266）只广播实时行，无重放缓冲。

### 改动步骤

1. **`app.js` 新增 `let projectSwitching = false;` 与 `let sessionGeneration = 0;`**（L2039 `sessionSwitching` 旁）。
   - `switchProjectPath`（L2254）开头：`if (projectSwitching) { toast("正在切换项目", "error"); return; } projectSwitching = true;`，整个流程 `try/finally { projectSwitching = false; }`。
   - `initSession`（L675）、`resumeSession`（L2204）、`switchProjectPath` 各自开头 `const gen = ++sessionGeneration;`；其内部 `rpc(get_state)` / `rpc(get_messages)` / debug 的 `.then` 回调第一行 `if (gen !== sessionGeneration) return;`——旧代次响应不得写 UI（含 `setStreaming` 恢复、`rebuildHistory`、视图切换）。`case "session_start"`（L485）里 `rpc(get_state)` 的 `.then` 同样捕获并检查 `sessionGeneration`（该 get_state 可能在切换窗口期晚到）。
2. **`app.js` SSE 重连恢复（P1-4）：**
   - 新增 `let esGeneration = 0; let sendPaused = false;`。
   - `es.onopen`（L653-657）改为：`const gen = ++esGeneration;` → 先**使所有 pending 失效**：遍历 `pending`，逐个 reject 为 `new Error("连接已重连，请求状态未知")` 并清除（明确告知，不暗示请求未执行）→ `sendPaused = true`（`sendMessage` 开头 `if (sendPaused) { toast("正在同步会话状态…", "info"); return; }`）→ 发起权威同步 `await resyncAfterReconnect(gen)` → `finally { if (gen === esGeneration) sendPaused = false; }`。
   - 新增 `async function resyncAfterReconnect(gen)`：`const state = await rpc({type:"get_state"}, 30000); if (gen !== esGeneration) return;` 应用状态（复用 `initSession` L699 的 `isStreaming` 恢复逻辑，抽成小函数共享）；`const msgs = await rpc({type:"get_messages"}, 30000); if (gen !== esGeneration) return; rebuildHistory(msgs); refreshSessions();`。同步失败（rpc reject）也走 `finally` 恢复输入，状态以重连后的下次事件为准。
   - 断线期间 pi 已接受的 prompt：`get_messages` 是权威源，resync 后 `rebuildHistory` 自然呈现，用户不会重复发送。
3. bridge 无需改动（P1-4 的"可重放事件缓冲"不必要——权威同步走 `get_messages`，审计亦只要求前端恢复协议）。

### 本阶段验证
- 手工（`npm run dev:web`）：快速点击两个不同项目 → 最终 UI 与最后点击项目一致，切换过程中第二次点击被拦截；旧项目响应晚到不覆盖。
- 断线恢复：DevTools 停用网络再恢复 → `onopen` 触发后 UI 与 pi 侧会话一致（用另一条终端 `curl` bridge 的 /api/sessions 或直接观察消息列表）。
- 既有 smoke：`cd piwpi/desktop && npm run smoke` 通过。

## 阶段 4 — P0-3 bridge 鉴权 + P2-7 拒绝第二控制客户端

### 现状（已验证）
- `desktop/server/bridge.mjs`：`createServer` 回调按 path+method if 链分发（L593-717）；`/api/events` SSE（L597-608）、`/api/rpc`（L610-625，直接 `pi.stdin.write`）、providers 配置 GET/POST/PUT/DELETE（L627-660，落盘 `~/.pi/agent/models.json`）、`/api/bridge/status`（L665）、`/api/project/picker`（L675）、`/api/sessions` GET（L680-694，递归扫 `.piwpi/sessions`）/DELETE（L696-705）。全链路无 token/Origin 校验；静态文件仅防路径穿越（L546-556）；`listen(port, "127.0.0.1")`（L723）。`broadcast`（L260-266）广播全部 SSE 客户端，无 client id。
- `desktop/electron/main.cjs`：`startBridge({port:0})` → `win.loadURL("http://127.0.0.1:${bridge.port}/")`；`preload.cjs` contextBridge 只暴露 `desktopShell/openExternal/openSourceFile`；main↔renderer 仅两条 IPC（open-source-file handle、open-external on）。无任何共享密钥机制。

### 改动步骤

1. **`desktop/server/bridge.mjs`：启动时生成高熵 token，所有控制端点校验。**
   - `startBridge` 内：`const authToken = crypto.randomBytes(32).toString("hex");`；`devMode = process.argv.includes("--dev") || process.env.PIWPI_BRIDGE_DEV === "1"`。`startBridge` 返回值增加 `authToken`。
   - 路由分发前统一校验（静态文件与 `/` 除外）：`function authorized(req, res)` —— 非 devMode 时校验 `req.headers.authorization === "Bearer " + authToken`；不匹配 → `res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" }))`。`/api/events` 用查询参数：`new URL(req.url, "http://x").searchParams.get("token") === authToken`（EventSource 无法带 header，localhost 场景接受 URL 传参；渲染进程不落地日志）。
   - 覆盖范围：`/api/*` 全部（rpc/providers/status/picker/sessions）、`/api/events`（SSE）、`/debug/*` 反代。静态文件保持开放（UI 本身）。
2. **`desktop/electron/main.cjs` + `desktop/electron/preload.cjs`：token 只交给当前窗口。**
   - main.cjs：新增 `ipcMain.handle("get-bridge-token", () => bridge.authToken)`；`will-navigate` 白名单不变。
   - preload.cjs：contextBridge 增加 `getBridgeToken: () => ipcRenderer.invoke("get-bridge-token")`。
   - `desktop/web/app.js`：启动时 `const bridgeToken = (await window.piwpi?.getBridgeToken?.()) ?? null;`；`rpcRaw`（L122）与 `rpc`（L133）的 fetch 增加 `Authorization: "Bearer " + bridgeToken`（header 不存在则不加，dev 模式服务器端放行）；`EventSource` URL（`connectEvents` L651 附近）追加 `?token=${bridgeToken}`。
3. **dev 模式**：`desktop/package.json` 的 `dev:web` 脚本改为 `node server/bridge.mjs --dev`（或 env `PIWPI_BRIDGE_DEV=1`）；`scripts/smoke-rpc.mjs`、`scripts/e2e-chat.mjs` 以 `--dev` 或 `PIWPI_BRIDGE_DEV=1` 启动 bridge。生产路径（Electron `startBridge({port:0})`）不传 `--dev` → 强制鉴权。
4. **`desktop/server/bridge.mjs` SSE 单客户端（P2-7）：**
   - 前端每次页面加载生成 `const clientId = crypto.randomUUID();`（模块变量，重连复用；页面重载即新身份）；SSE URL 追加 `&clientId=${clientId}`。
   - bridge：`sseClients` 改为按 clientId 索引；新连接到达时——同 clientId（重连）→ 关闭旧 res 并替换；不同 clientId 且已有存活客户端 → 响应 409 并立即关闭。一个页面只能拥有一个 Agent 事件流，第二个标签页被拒。
   - `/api/rpc` 不做 clientId 门控（第二标签页无 SSE 事件，其 rpc 响应同样无去向，UI 自然失效；token 已封住外部进程）。

### 本阶段验证
- 401 检查：Electron 正常启动后，用 `curl` 不带 token 请求 `http://127.0.0.1:<port>/api/rpc`、`/api/providers`、`/api/sessions`、`/api/events`、`/debug/*` → 全部 401；带 token（从 Electron 控制台 `await window.piwpi.getBridgeToken()` 取）→ 200/正常响应。
- 第二标签页：同 Electron 内再开一个窗口 → 新窗口 SSE 收到 409，第一窗口事件流不受影响。
- `cd piwpi/desktop && npm run smoke` 通过（smoke 以 --dev 启动）。

## 阶段 5 — P0-4 记忆 TOCTOU + P1-1 shutdown 语义 + P1-2 记忆模型策略

### 现状（已验证）
- `extension/src/harness.ts`：`runMemoryBatch`（L578-629）：捕获循环 L588-597（plugin/lines/hash），`summarize` L600，提交 L614-626（`projectMap.update` L614、`store.upsert` L621、地图文件写 L626）——**LLM 返回后无任何 generation/hash/存在性复核**。harness 内**无 session generation 计数器**（grep 零命中，需新增）。自动触发阈值 L842-844、`onAgentSettled` 递减阈值 L1142-1149。`shutdown`（L1086-1103，`memoryQueue.flush(5000)` L1088）。`memoryDeps`（L263-281）用 `modelRegistry/currentModel`（捕获于 L242-244）。
- `extension/src/memory/queue.ts`：`flush`（L56-69）**主动派发 pending 未开始任务**（`dispatch` L61），`Promise.race` 超时不取消底层链，无 AbortSignal；串行链 pending→dispatch。
- `extension/src/memory/agent.ts`：`summarize`（L132-160），`complete()`（L142-145）无 options（无 maxTokens/sessionId/cache）；`MEMORY_SYSTEM_PROMPT` 固定。
- 配置：extension 目前仅 `PIWPI_DEBUG_PORT`/`PIWPI_DATA_DIR` 两个 env，**无记忆模型配置键**。
- Project Map：`<cwd>/.piwpi/project-map.json`（`persist.ts` L44-52），`writeProjectMapFileMerged`（L126-143）读盘合并写回。

### 改动步骤

1. **`extension/src/harness.ts` 新增状态代次（P0-4 前置）：**
   - 新增 `private sessionGeneration = 0;`；在 session_start 事件处理与 `scanDiskChanges` 检测到挂载失效/移除时 `this.sessionGeneration++`。
2. **`runMemoryBatch`（L578-629）捕获与提交加校验：**
   - 捕获循环（L588-597）内记录 `const gen = this.sessionGeneration;` 与 `const capturedHash = hash;`。
   - 提交（L614-626）改为：`if (gen !== this.sessionGeneration) { log 丢弃; continue; }`；且 `if (!this.pluginStore.get(plugin.id)) continue;`（store 查插件仍在）；且 `if (fileCache 当前 hash !== capturedHash) continue;`（`fileCache` 访问器名以实现时确认，语义：磁盘 hash 与任务捕获时一致才允许写回）。任一项不满足 → 丢弃该插件结果并 debug 日志（"stale memory result dropped"）。projectMap.update 与 store.upsert 在同一校验之后。
3. **`extension/src/memory/queue.ts` shutdown 语义（P1-1）：**
   - `flush(ms)` 改为：**只等待已运行链**，不再 `dispatch` pending；新增 `cancelPending()` 丢弃未开始任务（清 timer、置 cancelled 标记，任务状态机补 `cancelled` 态，`dispatch` 时检查）。
   - 任务执行贯穿 `AbortSignal`：`runMemoryBatch(signal)` → `summarize(signal)` → `complete(..., { signal })`；`flush` 超时用 `AbortController` 触发 abort 且**结果必须作废**（aborted 标记 + 步骤 2 的 gen/hash 校验兜底）。
   - `harness.shutdown`（L1086-1103）：先 `memoryQueue.cancelPending()` 再 `memoryQueue.flush(5000)`；teardown 路径不得启动任何新模型调用。
4. **`extension/src/memory/agent.ts` `complete()` 加 options：**
   - `complete(model, messages, options?: { signal?: AbortSignal; maxTokens?: number })`；`summarize` 转发 signal 与 maxTokens（见步骤 5）。`ModelRegistry.complete` 的既有签名与 abort 支持未验证——实现时先确认其 options 形状；若 ModelRegistry 不支持 abort，则 signal 只用于调用前检查（已 abort 不再发请求），结果作废仍由 gen/hash 校验兜底。
5. **`extension/src/harness.ts` 记忆模型解析（P1-2，用户决策）：**
   - 配置读取顺序：`~/.pi/agent/models.json` 的 `memoryModel: { providerId, modelId } | null`（与 bridge `readModelsConfig/writeModelsConfig` 同一文件）→ 其次 `PIWPI_MEMORY_MODEL` env（命令行专用，形如 `providerId/modelId`）→ 都没有 → `null`。
   - `memoryDeps`（L263-281）：`memoryModel == null` 时自动触发路径（L842-844、L1141 的 `onAgentSettled` 递减）直接跳过并**只提示一次**（`let memoryModelWarned = false;`）；手动触发路径保持用当前主模型并打一条 warn。配置了 memoryModel → 从 `modelRegistry` 按 provider/model id 解析为 `Model` 用于 `complete()`，`maxTokens: 1024`（审计"限制输出"），关闭推理（模型自身配置）。
   - 每次记忆运行记录独立 usage：debug 日志一行（`[memory] model=<id> input=<n> output=<n>`，usage 取自 complete 结果，若不可得则记提示）；并在 harness 维护 `memoryRunCount/memoryTokenTotal` 计数器，追加进现有 debug 快照（extension 有 debug 机制，`debug.test.ts` 佐证；快照挂载点以实现时现有 debug 输出结构为准）。
6. **`extension/index.ts` session_shutdown handler（L51-54）**：保持 `await harness.shutdown()`，语义已由步骤 3 修正（不再启动新 LLM、运行中任务超时作废）。

### 本阶段验证
- `cd piwpi/extension && npm test`（含 `memory.test.ts`）全绿；新增用例：
  1. runMemoryBatch 在 LLM 返回前插件被移除/文件被改 → 提交被丢弃，store 与 project-map.json 不出现旧条目（模拟：注入可挂起的 summarize 桩 + 中途改文件/删插件）。
  2. flush 不再派发 pending（pending 任务在 flush 后被 cancel 而非运行）。
  3. shutdown 后无新模型调用（mock complete 计数为 0）。
  4. 未配置 memoryModel 时自动触发被跳过且仅告警一次；配置后使用指定模型与 maxTokens。
- 真实链路（审计 P0-4 验证）：触发一次记忆整理，请求未返回前修改/删除对应文件 → 返回后 `.piwpi/project-map.json` 与 store 不恢复旧 hash/旧条目。

## 阶段 6 — P1-5 请求关键路径裁剪 + P1-6 模式工具过滤

### 现状（已验证）
- `runner.ts:986` 无条件 clone（阶段 1 步骤 3 已惰性化）。
- `harness.ts:1043` 每轮无条件 `event.messages.map(toDebugSummary)`（即使无监听者）；L965-978 反向扫全部消息取 lastUserText、L980-1002 尾部 6 条 recentDialogue（审计未列，但同属每轮开销，一并处理）。
- `harness.ts:962` `onContext` 每 provider 请求调 `scanDiskChanges`（L425；`pickScanBatch` L354：≤64 全量否则每轮 32 stat）。
- 指标设施：无 per-request 指标；`packages/coding-agent/src/core/timings.ts` 仅启动期、namespace 字面量 `"main" | "extensions"`、`PI_TIMING=1` 门控。
- 工具过滤：`agent-session.ts` `_toolCanExecuteInCurrentMode`（L928-931）只在 `beforeToolCall` 执行期拦截（L480-484）；`setCollaborationMode`（L939-950）只重建 system prompt（`_rebuildSystemPrompt` L1053），不重算 `agent.state.tools`；`setActiveToolsByName`（L958-968）写入全部 active 工具；`prepareNextTurnWithContext`（L545-561）`tools: this.agent.state.tools.slice()` 不过滤；`_refreshToolRegistry`（L2499-2591）把 extension 工具自动加入 active（L2577-2580）。plan-only 工具：`extension/index.ts` L82 `request_user_input`、L124 `update_plan_document`（`collaborationModes: ["plan"]`）。

### 改动步骤

1. **`extension/src/harness.ts` 调试摘要按需生成（P1-5 第 2 项）：**
   - L1043 的 `toDebugSummary` 映射改为：仅当存在 debug/context 监听者时才生成（先确认监听者注册 API——debug 事件在 L1043 后 `emit`，查找 emit 前是否有监听者计数/订阅集合；若无现成计数，则在订阅/退订处维护 `debugListenerCount`）。无监听者 → 跳过映射（`lastContext` 不赋值或赋空，按监听者存在性决定）。
   - L965-978 的 lastUserText 反向扫与 L980-1002 的 recentDialogue：先 grep 二者消费者；仅当消费者全是调试/上下文展示（debug 面板、context usage 显示）时，与摘要共用同一监听者门控（无监听者跳过）；若发现任一功能性消费者（如记忆或 prompt 组装），保留该部分原逻辑并在代码注释中说明。
2. **`extension/src/harness.ts` 磁盘扫描移出请求关键路径（P1-5 第 3 项）：**
   - 新增 `private scanPending = true;`（初值 true，首轮请求前必须有一次扫描）。
   - `onContext`（L962）改为 `if (!this.scanPending) { /* 跳过 */ } else { this.scanPending = false; await scanDiskChanges(); }`。
   - 置位点：`onAgentSettled`（L1142-1149）与 session_start 处理里 `this.scanPending = true;`。语义：turn 边界（settled）扫描一次，turn 内多次 provider 调用不再重复 stat；文件变更检测延迟到 turn 结束，工具自写文件的内容本就在 tool result 里，无信息损失。
   - 配合阶段 1 的 delta：delta 计算读取的 `fileCache` 在请求时来自最近一次 settled 扫描，确定性不变。
3. **`packages/coding-agent/src/core/extensions/runner.ts` 埋点（阶段 9 前置）：** `emitContext` 进入/退出记录耗时与 clone 次数（见阶段 9 的 timings 扩展）。
4. **`packages/coding-agent/src/core/agent-session.ts` 按模式过滤工具（P1-6）：**
   - 新增 `private getEffectiveToolNames(): string[]`：`return this.getActiveToolNames().filter((n) => this._toolCanExecuteInCurrentMode(n));`（保留 `getActiveToolNames` 原语义，调用者以实现时 grep 确认——它可能被 UI 用于展示 active 列表）。
   - `setActiveToolsByName`（L958-968）：保存全量 active 名后，`agent.state.tools = 按 _toolCanExecuteInCurrentMode 过滤后的工具`（过滤在组装 AgentTool[] 处，复用 L961-967 现组装逻辑）。
   - `setCollaborationMode`（L939-950）：`this._baseSystemPrompt = this._rebuildSystemPrompt(this.getEffectiveToolNames());` 并用同样过滤集重设 `agent.state.tools`（调一次"过滤重算"小函数，与 setActiveToolsByName 共享）。切回 default 模式时全量工具自动恢复。
   - 过滤谓词与执行期完全一致 → schema 与执行行为不再分叉；默认模式下 `request_user_input`/`update_plan_document` 不再进 system prompt/schema。
5. 时间预算提示：先落地步骤 1-4 的可裁剪项与阶段 9 埋点，再用真实数据决定是否需要更复杂机制（如扫描事件化）；不预先引入新架构。

### 本阶段验证
- `cd piwpi/extension && npm test`、`cd piwpi/packages/coding-agent && npm test` 全绿。
- 新增用例（`cd piwpi/packages/coding-agent && npx vitest --run test/collaboration-mode.test.ts` 扩展）：default 模式下 `agent.state.tools` 不含 `request_user_input`/`update_plan_document`；切 plan → 两者出现；切回 default → 消失；既有协作模式行为用例不回退。
- 埋点观测（阶段 9 就绪后）：1k/10k 消息 + 0/32/64 挂载下，turn 内第 2 次及以后 provider 请求的 transform 耗时显著下降（无扫描、无摘要、clone 仅首次）。
- 回归：`cd piwpi/packages/agent && npm test`。

## 阶段 7 — P1-7 EventStream 终止语义 + P2-4 rejection + P2-2 并行准备 + P2-3 更新队列

### 现状（已验证）
- `packages/ai/src/utils/event-stream.ts`：`EventStream`（L8）`push`（L18，isComplete 命中即 resolve）、`end(result?)`（L32-35，**result 为 undefined 时永不 resolve finalResultPromise**）、`result()`（L57）；`AssistantMessageEventStream`（L63，isComplete = done|error）。无 addError/addAborted 方法。
- `packages/agent/src/proxy.ts`：`streamProxy`（L116）EOF 直接 break（L183-185）、`stream.end()` 无 result（L213）；catch 分支 push error 再 end（L214-224）。
- `packages/agent/src/agent-loop.ts`：`streamAssistantResponse`（L281）for-await（L317），循环内 done/error 分支 `await response.result()`（L348），**循环后无条件再 await**（L363）——EOF 无终止事件时永久 pending；`executeToolCallsParallel`（L489）L507 串行 `await prepareToolCall`、L540 才 Promise.all；`executePreparedToolCall`（L666）L681 每 partial push 一个 Promise、L695/699 才 `Promise.all(updateEvents)`（无界累积）；`agentLoop`（L31）`.then(stream.end)` 无 catch（L49-50）、`agentLoopContinue`（L64）同（L87-90）。

### 改动步骤

1. **`packages/ai/src/utils/event-stream.ts`：`end()` 不允许留下永久 pending 的 final result（P1-7 根因）：**
   - `end(result?: R)`：result 为 undefined 时，`resolveFinalResult(this.createIncompleteEndResult())`；新增 `protected createIncompleteEndResult(): R { return undefined as R; }`（默认）。
   - `AssistantMessageEventStream` 覆写：返回 aborted 终止消息。消息形状：**复用 packages/agent 中既有的 aborted/终止消息形状**（实现时 grep `"aborted"` 于 packages/agent/src；若已存在 aborted assistant message 类型则复用，不存在则按 `{ type: "aborted", reason: "stream ended without a terminal event" }` 与 `{ type: "error", ... }` 同构定义）。
2. **`packages/agent/src/proxy.ts` EOF 路径（L183-185 → L213）：** break 后、`stream.end()` 前先 `stream.push({ type: "error", reason: "Connection closed without a terminal event", error: partial })`（错误事件形状复用 L214-224 catch 分支现有形状，仅 reason 不同）→ isComplete 命中即 resolve，L213 的 `end()` 可带也可不带 result（双重保险）。
3. **`packages/agent/src/agent-loop.ts` 包装加 rejection（P2-4）：**
   - `agentLoop`（L40-51）与 `agentLoopContinue`（L87-90）：`.then(...)` 后追加 `.catch((err) => { stream.push({ type: "error", reason: String(err?.message ?? err) }); stream.end(); })`（AgentEvent 的 error 事件形状以 agent 事件联合类型为准——实现时 grep `type: "error"` 于 packages/agent/src/events 或 agent-loop.ts 内既有 emit）。
   - `streamAssistantResponse` L363 的兜底 await 现可安全 resolve；无需改。
4. **`executeToolCallsParallel`（L489）并行 prepare（P2-2）：** 将 L498-507 的串行循环改为：先逐条 `await emit({type:"tool_execution_start",...})`（保持事件顺序），然后 `const preparations = await Promise.all(toolCalls.map((tc) => prepareToolCall(currentContext, assistantMessage, tc, config, signal)));` 再按原顺序汇总进 `finalizedCalls`（L540 的 `Promise.all` 逻辑不变）。工具结果仍按 tool call 原始顺序输出（既有测试 L586"completion order but persist in source order"断言保持）。
5. **`executePreparedToolCall`（L666）有界更新（P2-3）：** 删除 `updateEvents` 数组（L673/L681/L695/L699）；改为每个 tool 维护"最新未消费状态"：`let latestUpdate = null; let flushScheduled = false;`，partial 回调里 `latestUpdate = partial; if (!flushScheduled) { flushScheduled = true; queueMicrotask(() => { flushScheduled = false; if (latestUpdate) { await emit({ type: "tool_execution_update", toolCallId, ...latestUpdate }); latestUpdate = null; } }); }`；`tool.execute` 返回/抛错后、发 result 事件前，若 `latestUpdate` 非空再 flush 一次（保证最终状态不丢）。内存 O(1)，中间态按审计"只保留最新未消费状态"丢弃。
   - 若 `packages/agent/test/agent-loop.test.ts` 存在断言"每个 update 事件都发出"的用例：该行为是审计明确要求的变更，相应断言改为断言"最终 update 状态一定发出、至多一次"。

### 本阶段验证
- 新增单测：
  1. `packages/ai`：`EventStream.end()` 无 result → `result()` resolve 且值为 aborted 终止消息（`AssistantMessageEventStream` 用例）。
  2. `packages/agent`：`streamProxy` 远端 EOF → 消费者 for-await 收到 error 事件、`result()` resolve（可模拟 reader 直接 `{done:true}`）。
  3. `agentLoop()` 在 `convertToLlm` 抛错时 → 流以 error 事件结束，`result()` 不挂死（P2-4）。
- 全量：`cd piwpi/packages/ai && npm test`、`cd piwpi/packages/agent && npm test`（重点 agent-loop.test.ts 并行工具与终止语义用例）、`cd piwpi/packages/coding-agent && npm test`（agent-harness 调用方）。

## 阶段 8 — P2-1 刷新 single-flight + P2-5 compaction 估算 + P2-6 历史渲染 generation

### 现状（已验证）
- `app.js` `case "session_start"`（L485-498）：`rpc(get_state).then(refreshSessions)` + L496 再次 `refreshSessions()` + L497 `scheduleContextUsageRefresh()`——同一事件两次刷新 + 项目切换流程自身再刷。`get_context_breakdown` 的 `ctxFetchSeq`（L1140、L1296-1299）只丢旧响应，不取消已入 pi 的请求。
- `compaction.ts`：`ESTIMATED_IMAGE_CHARS = 4800`（L244，≈1200 token/图），`estimateTokens`（L266）不经过真实降级；真实请求中图片被 `sdk.ts:271`（blockImages 开，27 字符 ≈7 token）或 `transform-messages.ts` L6-7 占位符（46/50 字符）替换，或保留原样（视觉模型）。调用方 `agent-session.ts` L1837/1886/2078/2107/2162（`prepareCompaction`/`compact`/`shouldCompact`）。
- `rebuildHistory`（L875，同步全量 DOM 构建）不可取消；高亮 `scheduleHistoryHighlight`（L191-208）已有 generation。

### 改动步骤

1. **`app.js` session_start 单一权威刷新 + single-flight（P2-1）：**
   - L496 的第二次 `refreshSessions()` 删除（保留 get_state → refreshSessions 一条路径 + L497 的 context 刷新）。
   - `refreshSessions` 加 single-flight：`let sessionsRefreshing = null; async function refreshSessions() { if (sessionsRefreshing) return sessionsRefreshing; sessionsRefreshing = (async () => { ...原逻辑... })().finally(() => { sessionsRefreshing = null; }); return sessionsRefreshing; }`。
   - `get_context_breakdown` 的请求函数（含 L1296 处）加 single-flight + 重跑标记：`if (breakdownInFlight) { breakdownRerun = true; return; }`，完成回调里 `if (breakdownRerun) { breakdownRerun = false; 再发起一次; }`——同一时刻最多一个 breakdown 请求进入 pi，`ctxFetchSeq` 继续作代次兜底。
2. **`packages/coding-agent/src/core/compaction/compaction.ts` 估算对齐真实 payload（P2-5）：**
   - `estimateTextAndImageContentChars`（L246）/`estimateTokens`（L266）增加可选参数 `opts?: { blockImages?: boolean; visionModel?: boolean }`：image 块计 `opts.blockImages ? 27 : opts.visionModel === false ? (user 块 46 / tool 块 50) : 4800`（字符数，与占位符实际长度一致；user/tool 按 content 来源区分——`estimateTextAndImageContentChars` 已在消息类型层面可分）。
   - `estimateContextTokens`（L202）透传 opts；`agent-session.ts` 调用点（L1837/2107 的 `prepareCompaction`、L2078 的 `shouldCompact`）传入 `blockImages: settingsManager.getBlockImages()` 与 `visionModel: this.model.input.includes("image")`（`this.model` 在 agent-session 可用；`input.includes("image")` 与 `transform-messages.ts` L36 同判据）。
   - 默认（不传 opts）保持 4800 → `test/compaction.test.ts` 既有断言不回退；阈值行为在视觉模型下不变。
3. **`app.js` `rebuildHistory`（L875）可取消（P2-6）：**
   - 函数开头 `const gen = sessionGeneration;`（阶段 3 引入）；消息循环每 ~20 条 `await new Promise((r) => setTimeout(r, 0));` 一次并 `if (gen !== sessionGeneration) return;`（放弃剩余构建，不提交）。高亮沿用既有 generation。可视区虚拟化按审计只在实测（阶段 9 的 DOM 重建耗时指标）证明需要时再做——**本计划不做**。

### 本阶段验证
- `cd piwpi/packages/coding-agent && npx vitest --run test/compaction.test.ts` 全绿；新增用例：blockImages=true 时含图消息估算 ≈ 无图文本 + 27 字符级；非视觉模型同；视觉模型维持 4800。
- `cd piwpi/desktop && npm run typecheck:web`；手工：快速切换会话时旧 rebuildHistory 中止（观察 Console 无"旧代次提交"日志/UI 不闪旧内容）；`get_context_breakdown` 在快速连续触发时只发一次请求（Network 面板）。
- `cd piwpi/desktop && npm run smoke` 通过。

## 阶段 9 — 真实链路观测指标（审计 §7）

### 决策
不引入新指标管道；全部走现有 `console.debug` + `timings.ts` 扩展。`packages/agent`/`packages/coding-agent` 无现成 per-request 指标设施（已验证），审计 §7 的指标在以下位置落地：

1. **`packages/coding-agent/src/core/timings.ts`**：`TimingLabel` namespace 扩展 `"transform" | "scan" | "memory" | "provider"`；`time()` 现为同步 Date.now() 差值，足够计时；门控保持 `PI_TIMING=1`，另支持 `PIWPI_TRACE=1`（同一日志门）。
2. **`runner.ts` `emitContext`**（阶段 6 已埋点）：记录 enter/exit 耗时、clone 次数、消息数 → `[trace] transform ms=<n> clones=<n> messages=<n>`。
3. **`harness.ts` `scanDiskChanges`**：耗时、stat 数、readFile 数 → `[trace] scan ms=<n> stat=<n> read=<n>`。
4. **`agent-loop.ts` `streamAssistantResponse`**：`providerRequestStarted`（进入 streamFn 前）与 `firstToken`（首个事件到达）；`JSON.stringify(llmMessages).length` 字节数与稳定前缀 hash（`hash(systemPrompt + 除最后一条外全部消息)`）→ `[trace] provider bytes=<n> prefix=<hash> firstTokenMs=<n>`。
5. **rpc-mode/agent-session**：`promptReceived → preflightAccepted` 耗时（rpc-mode L395 入口到 preflightResult 回调）→ `[trace] preflightMs=<n>`。
6. **usage/cache 区分**：`message_end` 事件处（agent-session L662 附近）已有 usage 对象（`usage-totals.ts` 事后聚合来源），按消息来源打标：主 Agent（无标）、compaction（`compactionSummary` 消息类型）、记忆（extension 侧，阶段 5 已加 `[memory]` 日志）→ `[trace] usage input=<n> output=<n> cacheRead=<n> cacheWrite=<n>`（值以 usage 对象字段为准，缺失字段跳过）。
7. **`app.js`**：`sessionGeneration`/`esGeneration` 变化与丢弃响应计数 → `[trace] ui gen=<session>/<es> discarded=<n>`；`rebuildHistory` 耗时与节点数 → `[trace] dom ms=<n> nodes=<n>`。
8. **记忆运行**：阶段 5 已加 `[memory]` 独立 usage 日志。

指标落地顺序：阶段 6 的埋点（2-4 项）与阶段 9 同步实现（阶段 6 验证要用）；其余随各自阶段。

### 本阶段验证
- 跑一轮真实问答（`cd piwpi/desktop && npm run dev:web`，`PIWPI_TRACE=1` 环境变量传给 `pi` 进程——desktop 通过 bridge 启动 pi，确认 env 传递路径后设置）：日志中四段耗时（promptReceived→preflightAccepted→providerRequestStarted→firstToken）、每请求字节数/前缀 hash、usage 三分类、transform/scan 耗时均出现；重复同一问题两次 → 第二次前缀 hash 相同、cacheRead 增长。
- 指标用于阶段 1/6 的验证对比基线，落地后删除阶段 1 验证用的临时 `console.log`。

## Critical files & anchors

1. **`extension/src/harness.ts`** — 最负载荷：`onContext`（L957，delta 追加 + 扫描移出关键路径）、`buildMountDelta`（新增）、`scanDiskChanges`（L425）/`pickScanBatch`（L354）、`runMemoryBatch`（L578-629，gen/hash 校验）、`memoryDeps`（L263-281，记忆模型解析）、`onAgentSettled`（L1142）、`shutdown`（L1086-1103）。阶段 1/5/6/9 的主战场。
2. **`desktop/web/app.js`** — 阶段 2/3/8/9 前端全部改动：`sendMessage`（L957）、`rpc/rpcRaw`（L122/133）、`setStreaming`（L334）、`es.onopen/connectEvents`（L651-662）、`switchProjectPath`（L2254）、`initSession`（L675）、`session_start`（L485）、`rebuildHistory`（L875）、`ctxFetchSeq`（L1296）。
3. **`desktop/server/bridge.mjs` + `desktop/electron/main.cjs` + `preload.cjs`** — 阶段 4：路由分发点（L593-717，token 校验插入处）、`broadcast`（L260）、SSE 连接注册（L597-608，clientId 门控）、`startBridge` 返回（token）、IPC 通道（main.cjs 新增 `get-bridge-token`）。
4. **`packages/coding-agent/src/modes/rpc/rpc-mode.ts`** — 阶段 2 后端：`case "prompt"`（L395-416）、`handleInputLine`（L872-912）、`attachJsonlLineReader`（L930-932）。
5. **`packages/agent/src/agent-loop.ts` + `packages/ai/src/utils/event-stream.ts`** — 阶段 7：`streamAssistantResponse`（L281，L363 兜底 await）、`executeToolCallsParallel`（L489）、`executePreparedToolCall`（L666）、wrapper `.then`（L40-51/87-90）、`EventStream.end`（L32-35）、`AssistantMessageEventStream`（L63）。

其余参照各阶段内行号锚点（均为 scout 实测当前行号）。

## Verification 汇总（按阶段执行，含上述各阶段内验证）

```bash
# 常用回归（每阶段结束跑对应包）
cd piwpi/extension && npm test                       # 阶段 1/5/6
cd piwpi/packages/coding-agent && npm test           # 阶段 1/2/5(无)/6/7/8
cd piwpi/packages/agent && npm test                  # 阶段 6/7
cd piwpi/packages/ai && npm test                     # 阶段 7
cd piwpi/desktop && npm run typecheck:web && npm run smoke   # 阶段 2/3/4/8
# 注意：根 npm test 不含 extension 包；coding-agent 源码改动需 npm run build 后 desktop 才生效
```

每阶段各自的真实链路验证（curl 401、双 Enter 计数、切换覆盖、记忆 TOCTOU、payload 前缀 hash/cacheRead、EOF 挂死）见各阶段小节，全部通过后进入下一阶段。

## Assumptions & contingencies

- **P0-1（用户已选）**：历史不可变 + 尾部增量。代价：磁盘内容变化过的挂载，其 delta 在后续每轮请求都会重新追加（模型每轮都被告知当前状态，这是不可变历史的固有开销）；不变量"相同输入→相同字节输出"靠 delta 不含时间戳 + 插件排序保证。若实测 delta 噪声影响质量，回退方案为写回式（转换结果赋回 `currentContext.messages` + 幂等标记），但历史将不再不可变。
- **P1-2（用户已选）**：`memoryModel` 存 `~/.pi/agent/models.json`（与 bridge 配置同一文件），UI 在供应商设置面板新增选择器；`PIWPI_MEMORY_MODEL`（`providerId/modelId`）仅命令行通道。`maxTokens: 1024`（可调，先固定）。extension 读取 models.json 的路径未验证——实现时以 harness 现有配置读取方式为准（`PIWPI_DATA_DIR` 读取逻辑可参照）；若读取路径复杂，先落 env 通道并记录待办，桌面 UI 通道随后补。
- **实现时需先确认的未验证点**（均已 inline 标注）：`ModelRegistry.complete` 的 options/abort 支持；`PluginStore` 查询方法名与 `fileCache` 访问器；`onContext` 的 `ContextEventResult` 返回形状；extension debug 监听者计数 API；`AgentEvent` 与 aborted/error 消息的确切形状（grep `"aborted"`/`type: "error"` 于 packages/agent/src）；`agentLoop`/`agentLoopContinue` 的直接调用者（`lsp references` 查）；`getActiveToolNames` 的其他调用者；`agent-loop.test.ts` 是否有逐条 update 断言。
- **P2-7**：SSE 独占按"每页面加载生成 clientId"实现；同 clientId 重连放行、异 clientId 409。`/api/rpc` 不做 clientId 门控（token 已封外部进程，第二标签页无事件流自然失效）。
- **P2-3**：更新事件改为"最新未消费状态 + 微任务合并"，中间态丢弃——审计明示的取舍；若有测试断言逐条发出，按新语义改断言。
- **P1-5 磁盘扫描**：移到 settled 后，turn 内外部并发编辑直到 turn 结束才可见（工具自写内容在 tool result 内，无信息损失）；先埋点实测，若首 token 延迟改善不足再评估事件化扫描，本计划不含该架构。

---

## 实施记录（2026-08-11 执行完成）

9 个阶段全部落地，代码与测试改动与计划一致；与计划的偏差与实现决策记录如下。

### 与计划的偏差（均为代码现状与计划行号锚点不一致所致）

1. **P0-1 比较基准**：计划写"取 PluginStore 中 plugin.hash 与 fileCache 比较"，但 `scanDiskChanges` 小改重挂载会更新 `metadata.hash`，而历史锚点文本不变 → 按 store hash 比较会漏报（模型永远看不到最新内容）。实际实现新增 `anchorHashes: Map<pluginId, hash>`（锚点创建/增量时置位，scan 重挂载不更新），delta 对比 anchorHash vs 磁盘 hash；`retiredMounts` 记录已失效/删除但锚点仍在历史中的挂载（plan 的 delta 格式含"文件已删除"条目，invalidated 场景同样需要）。不变式"相同输入→相同字节输出"仍成立。
2. **`onContext` 返回形状**：harness 原为 `Promise<void>`（计划引用 runner 旧版 `ContextEventResult` 契约）。现改为返回本地 `ContextResult { messages? }`（runner.ts:997-998 已支持 handlerResult.messages 采用），delta 追加到末条消息副本。
3. **P1-5 调试摘要门控**：`options.onEvent` 是固定回调（无订阅计数 API）→ 以 `options.onEvent !== undefined` 作为监听者存在性；`lastUserText`/`recentDialogue` 为记忆任务的功能性消费者，保留。
4. **P2-5 占位符位置**：计划引用的 `transform-messages.ts`（coding-agent 内）不存在——46/50 字符占位符在 `packages/ai/src/api/transform-messages.ts`（NON_VISION_USER/TOOL_IMAGE_PLACEHOLDER），27 字符占位符在 `core/sdk.ts`（"Image reading is disabled."），均已按此对齐。
5. **P2-4 无 error 事件**：`AgentEvent` 联合类型无 `type: "error"` 成员（grep 确认），不侵入公共类型 → `.catch` 改为 `stream.end(undefined)`（配合 P1-7 的 end() 语义，result() 以 undefined 解析、迭代器终止）。测试按可观察契约断言"流终止、result() 不挂死"。
6. **queue flush 超时**：`Promise.withResolvers` 需 node>=22，本机测试环境 node 20.19 → 回退 executor 形式（文件内注明原因）。
7. **P1-2 UI 选择器**：计划 Assumptions 允许"先落 env 通道并记录待办"——extension 侧 `models.json` 读取 + `PIWPI_MEMORY_MODEL` env 已落地；供应商面板的记忆模型选择器（写 `memoryModel` 到 models.json）未实现，留给后续 UI 工作。

### 环境与回归说明

- 本机 node 为 20.19（仓库 engines 要求 >=22.19）：undici 8.5.0 的 `CacheStorage` 依赖 `worker_threads.markAsUncloneable`（node>=22.2），导致 coding-agent 大部分测试文件模块加载失败。用 `NODE_OPTIONS=--require <临时 shim>` 注入空函数后跑通（shim 在 `%TEMP%\piwpi-node20-shim.cjs`，不进仓库）。
- 仓库 node_modules 的 workspace symlink 曾指向旧路径 `E:\project\opensource\piwpi\pi\...`（已不存在），已修复为 junction 指向当前仓库位置。
- 全部回归：extension 126/126、ai 无新增失败、agent 无新增失败、coding-agent 无新增失败（与 stash 基线 diff）；残余失败均为 node20/Windows bash-exec 环境问题（基线同样失败）。`desktop npm run typecheck:web`、`npm run smoke` 通过。
- P9 指标：provider trace 经 built dist 实测触发（`[trace] provider bytes=… prefix=… firstTokenMs=…`，重复运行前缀 hash 一致）；scan/transform/preflight/usage/ui 埋点同门同格式，代码路径一致。
- 手动验证项（需真实模型/Electron，未在本环境执行）：双 Enter 无幽灵消息、项目快速切换覆盖、断线重连权威同步、Electron 内第二标签页 409、记忆 TOCTOU 真机复现。

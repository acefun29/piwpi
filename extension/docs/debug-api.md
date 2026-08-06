# piwpi Debug 观测 API（HTTP + SSE）

piwpi 扩展内置一个**只读**的调试观测服务，供外部前端（浏览器/自建工具）实时查看：

- 当前挂载的文件插件（segments、哈希、锚点消息、记忆摘要）
- 最近一次 LLM 上下文的消息快照
- 项目地图
- 实时事件流（拦截、挂载、记忆、上下文刷新）

服务**默认关闭**，仅通过环境变量开启，且只绑定 `127.0.0.1`：

```sh
# 方式一：环境变量
PIWPI_DEBUG_PORT=8787 pi -e extension

# 方式二（Windows PowerShell）
$env:PIWPI_DEBUG_PORT="8787"; pi -e extension
```

启动成功后扩展会打印：

```
[piwpi] debug server listening on http://127.0.0.1:8787 (PIWPI_DEBUG_PORT)
```

## 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 服务信息与端点清单 |
| GET | `/api/state` | **全量快照**：插件列表 + 项目地图 + 队列状态 + 上下文摘要 |
| GET | `/api/plugins` | 插件列表（同上 state.plugins） |
| GET | `/api/plugins/:id` | 单个插件详情（含 render 输出全文），id 需 URL 编码，如 `/api/plugins/source%3Afile%3Ac%3A%5C...` |
| GET | `/api/context` | 最近一次 context 事件的消息摘要（每条文本截断 300 字符） |
| GET | `/api/project-map` | 项目地图 `{ entries, tree }`：entries 为按路径索引的 JSON 字典，tree 为目录分组 Markdown 缩进树（read_project_map 工具同款） |
| GET | `/api/events` | **SSE 实时事件流**（见下） |

所有响应带 `Access-Control-Allow-Origin: *`，任意来源前端可跨域访问。非 GET 返回 405，未知路径返回 404。

## 数据形状

### GET /api/state

```jsonc
{
  "cwd": "C:\\proj",
  "ts": 1788000000000,
  "plugins": [
    {
      "id": "source:file:c:\\proj\\src\\auth.ts",   // 插件 id = "source:" + identity
      "category": "source",
      "source": { "toolName": "read", "identity": "file:c:\\proj\\src\\auth.ts" },
      "metadata": {
        "absPath": "C:\\proj\\src\\auth.ts",
        "hash": "9f3a2c1e...",                        // sha256 hex（全文）
        "totalLines": 80,
        "segments": [                                  // 已挂载内容，1-based 闭区间
          { "start": 20, "end": 40, "text": "line20\nline21\n..." },
          { "start": 41, "end": 60, "text": "..." }
        ],
        "anchorToolCallId": "t1",                      // 上下文中的锚点消息 toolCallId
        "updatedAtHashChange": false,
        "truncatedNote": undefined,                    // 文件变短截段提示（有则显示）
        "memoryState": "pending",                      // M5 新模型：pending = 待批量整理 / done = 已整理
        "pendingMemoryLines": 3                        // 修改累积变更行数（达阈值触发失效，可缺省）
      },
      "content": "[piwpi:plugin ...]\n--- L20-40 ---\n...",  // render 输出（调试用，不含记忆段）
      "memory": undefined                              // 已废弃：M5 新模型下整理产物只进 Project Map
    }
  ],
  "projectMap": { "<pluginId>": { "role": "...", "responsibilities": [...], "decisions": [...] } },
  "pendingCount": 0,        // 等待 tool_result 匹配的登记数
  "queuePending": 0,        // 等待串行链执行的任务数（批量整理等）
  "lastUserText": "读一下 auth.ts",
  "context": {              // 最近一次 context 事件摘要（初始为 null）
    "ts": 1788000000000,
    "messageCount": 12,
    "toolResultCount": 3,
    "messages": [
      { "role": "user", "text": "读一下 auth.ts" },
      { "role": "toolResult", "toolCallId": "t1", "hasImage": false, "text": "[piwpi:plugin ...]" }
    ]
  }
}
```

> 注意：`plugins[].metadata.segments[].text` 含**完整段文本**（本地调试用途），文件很大时快照会相应变大。

### GET /api/events（SSE）

事件名固定为 `piwpi`，`data` 为事件 JSON（均含 `ts`，可选 `pluginId`）：

```jsonc
// event: piwpi
// data: { "type": "mounted", "ts": ..., "pluginId": "...", "kind": "increment", "hash": "...", "got": { "start": 41, "end": 60 } }
```

| type | 触发点 | 附加字段 |
|---|---|---|
| `session_start` | 会话启动 | `reason`（startup/resume/...） |
| `tool_call` | read 被拦截并做出决策 | `kind`: `new` / `increment`（含 `missing` 范围）/ `updated`（含 `oldHash`）/ `noop`（含 `want`） |
| `mounted` | 挂载完成（tool_result 处理后） | `kind`: `new`/`increment`/`updated`（含 `oldHash`）、`hash`、`got` 范围；updated 含 `pendingMemoryLines` |
| `noop` | 全覆盖读取 → 短引用替换 | `mounted`（已挂载范围描述） |
| `context` | 每次 LLM 请求前 | `messageCount`、`toolResultCount` |
| `memory_queued` | 新文件挂载并标记 pending | `kind`: `new`、`pendingFiles`、`pendingLines`（累计未整理统计） |
| `memory_updated` | 批量整理中单个文件整理完成写回 Project Map | — |
| `memory_batch_done` | 批量整理结束 | `files`（成功数）、`total`（本次目标数） |
| `memory_skipped` | 批量整理无模型跳过 | `reason`（如 no-model）、`pendingFiles` |
| `invalidated` | 修改累积达阈值 → 挂载 + project map 失效 | `changedLines`（累积变更行数）、`oldHash`、`hash` |
| `restore` | resume 恢复完成 | `pluginCount` |
| `shutdown` | 会话关闭 | — |

心跳注释帧 `: keepalive` 每 15 秒一次（保持连接）。

## 前端接入示例

```js
// 快照（页面加载 + 每次事件后刷新）
async function loadState() {
  const res = await fetch("http://127.0.0.1:8787/api/state");
  const state = await res.json();
  renderPlugins(state.plugins);   // 挂载文件列表：id / segments 范围 / hash 前 8 位 / 锚点 / memory
  renderContext(state.context);   // 上下文消息摘要
  renderProjectMap(state.projectMap);
}

// 实时事件（SSE）
const events = new EventSource("http://127.0.0.1:8787/api/events");
events.addEventListener("piwpi", (e) => {
  const evt = JSON.parse(e.data);
  console.log(evt);              // { type: "mounted", pluginId, kind, got, ... }
  loadState();                   // 增量事件后重拉快照
});
events.onerror = () => console.warn("debug server disconnected");
```

前端判断"当前挂载了哪些文件、各段范围"：遍历 `state.plugins`，每个插件展示
`source.identity`（文件）+ `metadata.segments`（范围与行数）+ `metadata.hash`（前 8 位）
+ `metadata.anchorToolCallId`（锚点）+ `memory.summary`（若有）。

## 说明与限制

- 服务只读，**不提供任何写/控制端点**（重置插件、手动触发记忆等暂不支持，需要再加）。
- 上下文消息文本截断 300 字符/条，避免快照膨胀；完整内容请以 pi 会话为准。
- 记忆语义（M5 新模型）：记忆 Agent 只在**新增**驱动——新文件挂载后标记 `pending`，累计达阈值（5 文件 或 1000 行）批量整理，产物只写入 Project Map；**修改**累积达阈值（变更行数 ≥ max(8, 总行数×10%)）直接触发 `invalidated` 失效（挂载移除 + map 删除），不跑记忆 Agent。失效检测是**主动的**：每轮 LLM 请求前（context 事件）扫描已挂载文件磁盘哈希，外部修改不依赖下一次 read 即可触发；read 拦截的 updated 分支为第二重检测。协议见 `docs/project-map-protocol.md`。
- 批量整理事件在串行链异步执行后发出，`memory_updated`/`memory_batch_done` 与 `memory_queued` 之间有真实 LLM 调用的时延。
- 数据仅在**当前 pi 进程内**有效；进程退出即消失（持久化见 custom entries / 项目地图文件）。

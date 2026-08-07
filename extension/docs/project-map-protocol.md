# piwpi Project Map 数据协议（M5 新模型）

本文档是 piwpi **记忆系统**的权威数据协议：记忆 Agent 的整理产物唯一落点是 Project Map，
主 Agent 通过 `read_project_map` 工具读取。协议版本 v1。

## 1. 存储

- 位置：`<项目根>/.piwpi/project-map.json`（数据跟项目走；`PIWPI_DATA_DIR` 可覆盖为任意目录）
  - `<项目根>` = 主 Agent 会话的 cwd（desktop 端由「切换项目」决定，pi 以该目录为工作目录启动）
  - 旧版本（`~/.pi/agent/piwpi/<safeCwd>/`）数据在首次启动时自动迁移到新位置
- 格式：**按路径索引的 JSON 字典**，key 为插件 id，value 为 `MapEntry`：

```jsonc
{
  "source:file:c:\\proj\\src\\auth.ts": {
    "role": "认证与授权模块",
    "responsibilities": ["JWT 签发与刷新", "登录态校验"],
    "keyStructures": ["AuthService", "JwtHelper"],
    "dependencies": ["config.ts", "redis"],
    "dependents": ["api/routes.ts"],
    "decisions": ["token 存 Redis 而非数据库"]
  }
}
```

- 插件 id 格式：`source:file:<规范化绝对路径>`（win32 下小写）。非 source 类别暂不写入。

## 2. MapEntry 字段语义

| 字段 | 类型 | 语义 | 写入方 |
|---|---|---|---|
| `role` | string | 该文件在项目中的**一句话身份**（目录树视图的一行摘要） | 记忆 Agent |
| `responsibilities` | string[] | 职责清单（3–8 条为宜，动词开头） | 记忆 Agent |
| `keyStructures` | string[] | 本文件定义的类/函数/模块名 | 记忆 Agent |
| `dependencies` | string[] | 本文件依赖的文件/模块名（尽量与已有条目命名一致） | 记忆 Agent |
| `dependents` | string[] | 依赖本文件的对象（从对话与已有条目推断） | 记忆 Agent |
| `decisions` | string[] | 文件中可见的设计决策 | 记忆 Agent |

约束：
- 字段全部为字符串/字符串数组；数组允许为空。
- 依赖关系**不保证对称**（dependencies 与 dependents 独立推断）。
- 依赖图不在存储层维护；仅在需要计算循环依赖/影响面时**临时**从字典构建。

## 3. 写入时机（记忆 Agent 只在"新增"驱动）

1. 文件第一次被主 Agent read 并挂载 → 插件标记 `memoryState: "pending"`（未整理）。
2. 累计未整理文件数 ≥ **5** 或累计行数 ≥ **1000**（HarnessOptions 可注入）→ 触发**批量整理**：
   - 收集全部 pending 插件，逐个调用记忆 Agent（串行，经记忆队列链路，不阻塞主流程）；
   - 每个文件的输入域严格限定为三段（记忆 Agent **无外部工具能力**）：
     1. 该文件挂载内容（确定性渲染，`render`）；
     2. 主 Agent 最近对话尾部（最近 6 条消息的去重摘要——toolResult 只保留标记行，
        与挂载内容**永不重叠**）；
     3. Project Map 已有条目精简列表（`renderBrief`：路径 — 角色；依赖，每项一行）。
   - 模型输出 `mapEntry` → `projectMap.update()`（增量并集，不重写）→ 落盘 + 会话 custom entries；
   - 插件标记 `memoryState: "done"`。
3. 无模型可用 → 跳过（`memory_skipped`），pending 保留，下次触发重试。

## 4. 失效语义（修改达标 → 直接失效，不跑记忆 Agent）

- 失效检测是**主动的**：
  - **每轮 LLM 请求前**（context 事件）扫描全部已挂载文件的磁盘哈希——外部手动修改不依赖下一次 read 即可触发判定；
  - read 拦截的 updated 分支是第二重检测（双保险）。
- 每次检测到哈希变化时，计算**已挂载段**的变更量（旧段按新行数 clamp 重切后与旧段文本做行级 diff；
  本次新读的 got 段不算变更）。
- 变更行数累积到插件 metadata 的 `pendingMemoryLines`；累积 ≥ `max(8, 总行数×10%)` → **失效**：
  - 插件从挂载中移除（store.remove）；
  - Project Map 中该文件条目**删除**（无 tombstone）；
  - 该轮上下文按最新状态刷新（挂载移除后锚点不再刷新）。
- 未达阈值 → **主动重挂载**（旧段按磁盘重切、hash 更新为磁盘值、变更量累积），锚点在同一轮刷新为最新内容。
- 之后再次 read 该文件 → 走新增流程重新挂载 → 重新 pending → 参与批量整理 → 记忆重建（自愈闭环）。
- resume 会话时磁盘已变但旧文本不可得（无法量化变更量）→ 不失效、不整理，等后续 read 按新内容判定。

## 5. 读取通道（主 Agent）

- 扩展注册 `read_project_map` 工具（无参数），返回**目录分组的 Markdown 缩进树**：

```
# 项目地图
src/
  auth.ts — 认证与授权模块
  memory/
    agent.ts — 记忆 Agent；依赖: harness.ts
```

- 目录节点按路径共享前缀合并；文件行 `<文件名> — <role>`（role 空时用首条职责）。
- 主 Agent 在需要项目全局理解（找文件、依赖关系、影响面）时主动调用；**不注入**主对话，零持续 token 开销。
- 调试：debug API `/api/project-map` 同时返回 `entries`（字典）与 `tree`（同一棵缩进树）。

## 6. 与主 Agent 上下文的关系

- 记忆 Agent 的整理产物**只进 Project Map**，不再渲染进挂载内容（render 不含 memory 段）、
  不再写入插件 `memory` 字段（该字段已废弃，旧数据兼容保留）。
- 主 Agent 上下文中的文件内容由挂载系统（M1–M4）负责；记忆只回答"这个项目里各文件是什么、和谁有关系"。

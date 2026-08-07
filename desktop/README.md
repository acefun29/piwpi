# piwpi 桌面端（阶段一）

基于 `prototype/` 视觉原型的桌面前端：Electron 壳 + 本地 bridge + pi RPC。

## 架构

```
Electron 主进程 (electron/main.mjs)
  └─ startBridge()  (server/bridge.mjs，零依赖 Node 标准库)
       ├─ HTTP 127.0.0.1:<随机端口>
       │    ├─ 静态托管 web/
       │    ├─ POST /api/rpc    → 命令写入 pi stdin（JSONL）
       │    ├─ GET  /api/events → SSE 转发 pi stdout（事件 + 响应）
       │    └─ GET  /debug/*    → 反代 piwpi 扩展 debug 服务 (127.0.0.1:8787)
       └─ spawn pi --mode rpc -e <extension>
            env: PIWPI_DEBUG_PORT=8787, ELECTRON_RUN_AS_NODE=1（Electron 下必须）
            cwd: piwpi 仓库根（PIWPI_WORKSPACE 可覆盖）
```

- 对话数据走 pi RPC（协议见 `pi/packages/coding-agent/docs/rpc.md`）
- Context 抽屉走扩展 debug API（见 `pi/extension/docs/debug-api.md`）
- 前端为零构建纯 ES Module，浏览器也能直接打开调试

> **单一版本原则（重要）**：`pi/extension` 对 `@earendil-works/pi-coding-agent` 的依赖是
> `file:../packages/coding-agent`（workspace 链接），**不装 npm 发布版**——扩展的运行时 CLI、类型、
> ModelRegistry API 全部来自 `pi/packages/coding-agent` 的本地构建产物，与魔改的 pi 源码永远同版本。
> 修改 pi 源码后必须重新构建，扩展才生效：
>
> ```bash
> cd pi/packages/coding-agent && npm run build
> ```
>
> 记忆 Agent 的 LLM 通道在会话启动时会打印自检日志（`[piwpi] memory agent LLM channel: ...`），
> 可据此判断走的是 `registry.complete`（本地包）还是 `runtime.complete`（兜底）。

## 运行

```bash
cd desktop
npm install        # 首次（拉 electron 二进制，体积较大；网络受限可用镜像：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js）
npm start          # 启动 Electron 窗口
```

> **关于 Electron 内置模块加载**：本项目 Electron 主进程用 `.cjs`（CommonJS）+ `require("electron")`，绕开 Electron 37 在部分 Windows 环境下 ESM 入口解析不到内置模块的兼容问题。

纯 Web 模式（调试用）：

```bash
npm run dev:web    # node server/bridge.mjs
# 浏览器打开 http://127.0.0.1:8901
```

> **node 版本要求**：pi 要求 node >= 22.19，bridge 用 `process.execPath` spawn pi 子进程，所以 dev:web 必须用 node 22 运行（`npm start` 不受影响——Electron 自带 Node 22）。系统 node 为 20.x 时显式指定：
>
> ```bash
> C:\path\to\node22\node.exe server\bridge.mjs
> ```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8901 | bridge 端口（0 = 随机，Electron 模式用随机） |
| `PIWPI_DEBUG_PORT` | 8787 | piwpi 扩展 debug 端口（被占自动递增） |
| `PIWPI_WORKSPACE` | piwpi 仓库根 | pi 进程工作目录 |
| `PIWPI_PI_CLI` | extension/node_modules 内（symlink → packages/coding-agent） | pi-coding-agent dist/cli.js 路径 |
| `PIWPI_EXT` | ../pi/extension | piwpi 扩展路径 |
| `PIWPI_PI_ARGS` | `--model deepseek/deepseek-v4-flash` | 额外 pi 参数（默认固定用 DeepSeek；换模型/加参数用此覆盖） |

> 默认模型固定为 DeepSeek（`deepseek/deepseek-v4-flash`）。如需换回 OpenAI 系：先把本地网关（`OPENAI_BASE_URL` 指向的服务，如 localhost:8080）启动，再设 `PIWPI_PI_ARGS=--model openai/gpt-5.5`。

## 测试

```bash
npm run smoke            # RPC + debug 服务连通性（不调用 LLM）
node scripts/e2e-chat.mjs   # 真实对话 E2E（会消耗 LLM 额度）
```

## 阶段一范围

- [x] 流式对话（text / thinking 折叠块 / codex 风格工具卡 / 运行指示 / 中断 / followUp 排队）
- [x] 思考强度选择器（get_available_thinking_levels / set_thinking_level）
- [x] 实时 Context 抽屉（挂载文件 segments/hash/锚点/memory + 上下文消息 + SSE 事件流 + 徽标）
- [x] 刷新后历史重建（get_messages）
- [x] Project Map 页（目录树 + 详情卡；数据走 /debug/project-map + SSE 增量刷新）
- [ ] Memory 页（侧边栏仍置灰"即将推出"）
- [ ] 会话列表 / 恢复 UI
- [ ] 模型切换 UI（默认已固定 deepseek-v4-flash，切换走 `PIWPI_PI_ARGS=--model ...`）

## 测试

```bash
npm run smoke            # RPC + debug 服务连通性（不调用 LLM）
node scripts/e2e-chat.mjs   # 真实对话 E2E（会消耗 LLM 额度；用 --model 走可达 provider）
```

Electron UI 冒烟（需 `ELECTRON_RUN_AS_NODE` 未被外部设置；沙箱/虚拟化环境追加 `--no-sandbox --disable-gpu`）：

```bash
node_modules/electron/dist/electron.exe --no-sandbox --disable-gpu electron/ui-smoke.cjs
# 输出：desktop/screenshots/ui-smoke.png + state JSON
```
- [ ] extension_ui 弹窗交互（目前自动取消 + toast）

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createDebugServer, type DebugServer, parseDebugPort } from "./src/debug.ts";
import { createHarness } from "./src/harness.ts";

/**
 * piwpi 扩展入口（阶段一完成）。
 *
 * 加载方式：`pi -e extension`（在仓库根运行），或 `pi -e E:\project\opensource\piwpi\pi\extension`，
 * 或复制/软链到 `<项目>/.pi/extensions/piwpi/`。
 * 加载机制：`core/extensions/loader.ts:412-440`（jiti 加载 default export，`await factory(api)`）与 618-713。
 *
 * 事件订阅事实（已核对，见 VERIFICATION.md）：
 * - ExtensionAPI.on 全重载：core/extensions/types.ts:1193-1239
 * - context 事件接线：core/sdk.ts:350-354（transformContext → runner.emitContext）
 *
 * 调试观测服务（可选）：设置环境变量 PIWPI_DEBUG_PORT=<port> 后监听 127.0.0.1，
 * HTTP 快照 + SSE 实时事件，接口文档见 extension/docs/debug-api.md。
 */
export default async function (pi: ExtensionAPI): Promise<void> {
	let debugServer: DebugServer | undefined;
	const harness = createHarness({ onEvent: (event) => debugServer?.handleEvent(event) });

	const debugPort = parseDebugPort(process.env.PIWPI_DEBUG_PORT);
	if (debugPort) {
		try {
			debugServer = await createDebugServer(harness, debugPort);
			console.log(`[piwpi] debug server listening on http://127.0.0.1:${debugServer.port} (PIWPI_DEBUG_PORT)`);
		} catch (err) {
			console.error("[piwpi] debug server failed to start:", err);
		}
	}

	pi.on("tool_call", (event, ctx) => harness.onToolCall(event, ctx));
	pi.on("tool_result", (event, ctx) => harness.onToolResult(event, ctx));
	pi.on("context", (event, ctx) => harness.onContext(event, ctx));
	pi.on("session_start", (event, ctx) => harness.onSessionStart(event, ctx));
	pi.on("session_shutdown", async () => {
		await harness.shutdown();
		debugServer?.close();
	});

	// M5 新模型：主 Agent 读取 Project Map 的唯一通道（零持续 token 开销，按需主动调用）。
	// 协议见 extension/docs/project-map-protocol.md；返回目录分组的 Markdown 缩进树。
	pi.registerTool({
		name: "read_project_map",
		label: "Read project map",
		description:
			"读取 piwpi 项目地图（Markdown 目录树）：各文件的身份/职责/关键结构/依赖/被依赖/设计决策。需要理解项目全局结构、查找文件、分析依赖与影响面时调用。",
		promptSnippet: "piwpi project map（文件身份与依赖树）",
		promptGuidelines: [
			"需要项目级理解（找文件、依赖关系、影响面）时调用 read_project_map",
			"项目地图由 piwpi 记忆 Agent 在新文件挂载累计后批量整理生成",
		],
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: harness.projectMapTree() }],
			details: {},
		}),
	});
}

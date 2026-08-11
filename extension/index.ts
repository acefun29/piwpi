import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { createDebugServer, type DebugServer, parseDebugPort } from "./src/debug.ts";
import { createHarness } from "./src/harness.ts";
import { dataDirFor } from "./src/memory/persist.ts";

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
		// 旧实例的 server 在 session_shutdown 时 close()，但端口要等 SSE 连接真正关闭才释放；
		// 新实例（会话切换时 factory 重跑）立即绑定会 EADDRINUSE → 短延迟退避重试（不阻塞主流程）
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				debugServer = await createDebugServer(harness, debugPort);
				console.log(`[piwpi] debug server listening on http://127.0.0.1:${debugServer.port} (PIWPI_DEBUG_PORT)`);
				break;
			} catch (err) {
				if (attempt === 19) {
					console.error("[piwpi] debug server failed to start:", err);
					break;
				}
				await new Promise((r) => setTimeout(r, 100));
			}
		}
	}

	pi.on("tool_call", (event, ctx) => harness.onToolCall(event, ctx));
	pi.on("tool_result", (event, ctx) => harness.onToolResult(event, ctx));
	pi.on("context", (event, ctx) => harness.onContext(event, ctx));
	pi.on("session_start", (event, ctx) => harness.onSessionStart(event, ctx));
	pi.on("agent_settled", () => harness.onAgentSettled());
	pi.on("session_shutdown", async () => {
		await harness.shutdown();
		await debugServer?.close();
	});

	// M5 新模型：主 Agent 读取 Project Map 的唯一通道（零持续 token 开销，按需主动调用）。
	// 协议见 extension/docs/project-map-protocol.md；返回目录分组的 Markdown 缩进树。
	pi.registerTool({
		name: "read_project_map",
		label: "Read project map",
		description:
			"读取 piwpi 项目地图（Markdown 目录树）：各文件的身份与职责。需要快速了解项目结构、查找文件时调用。",
		promptSnippet: "piwpi project map（文件身份与职责）",
		promptGuidelines: [
			"需要项目级理解（找文件、了解文件职责）时调用 read_project_map",
			"项目地图由 piwpi 记忆 Agent 在新文件挂载累计后批量整理生成",
		],
		collaborationModes: ["default", "plan"],
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: harness.projectMapTree() }],
			details: {},
		}),
	});

	pi.registerTool({
		name: "request_user_input",
		label: "Request user input",
		description:
			"在计划模式中向用户提出一个会改变方案的决策问题。一次只能问一个问题，提供 2-3 个互斥选项，并把推荐项放在第一位。",
		promptSnippet: "计划模式单题决策访谈",
		collaborationModes: ["plan"],
		parameters: Type.Object({
			header: Type.String({ description: "短标题" }),
			question: Type.String({ description: "单个决策问题" }),
			options: Type.Array(
				Type.Object({
					label: Type.String(),
					description: Type.String(),
				}),
				{ minItems: 2, maxItems: 3 },
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const renderedOptions = params.options.map((option) => `${option.label} — ${option.description}`);
			const other = "其他…";
			const selected = await ctx.ui.select(`${params.header}\n\n${params.question}`, [...renderedOptions, other]);
			if (!selected) {
				return { content: [{ type: "text", text: "User cancelled the question." }], details: {} };
			}
			if (selected === other) {
				const answer = await ctx.ui.input(params.header, "输入你的答案");
				return {
					content: [{ type: "text", text: answer ? `User answer: ${answer}` : "User cancelled the question." }],
					details: {},
				};
			}
			const index = renderedOptions.indexOf(selected);
			// selected 必为 renderedOptions 之一（取消与“其他…”已提前返回），indexOf 命中即有效
			const option = params.options[index]!;
			return {
				content: [{ type: "text", text: `User selected: ${option.label}\n${option.description}` }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "update_plan_document",
		label: "Update plan document",
		description:
			"更新当前计划模式会话的私有 Markdown 计划文档。每次提交完整文档；正式输出前使用 proposed 状态。",
		promptSnippet: "更新会话私有计划文档",
		collaborationModes: ["plan"],
		parameters: Type.Object({
			status: Type.Union([Type.Literal("draft"), Type.Literal("proposed")]),
			markdown: Type.String(),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const plansDir = join(dataDirFor(ctx.cwd), "plans");
			const planPath = join(plansDir, `${ctx.sessionManager.getSessionId()}.md`);
			await mkdir(plansDir, { recursive: true });
			await writeFile(planPath, params.markdown, "utf8");
			pi.appendEntry("piwpi.plan_document", {
				version: 1,
				status: params.status,
				markdown: params.markdown,
				path: planPath,
			});
			return {
				content: [{ type: "text", text: `Plan document updated: ${planPath}` }],
				details: { path: planPath, status: params.status },
			};
		},
	});
}

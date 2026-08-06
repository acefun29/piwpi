import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextEvent, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDebugServer, type DebugEvent, type DebugServer, parseDebugPort } from "../src/debug.ts";
import { createHarness } from "../src/harness.ts";
import { MemoryQueue } from "../src/memory/queue.ts";

/**
 * debug 观测服务测试（HTTP 快照 + SSE 实时事件）。
 * 事件类型从 @earendil-works/pi-coding-agent import 伪造（计划 §7.1 同款合法性）。
 */

let tmp: string;
const FILE = "a.ts";
let absFile: string;

beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "piwpi-debug-"));
	absFile = join(tmp, FILE);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const fileId = (p: string) => `source:file:${process.platform === "win32" ? p.toLowerCase() : p}`;

function lines(n: number): string {
	return Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n");
}
const text20_40 = lines(80).split("\n").slice(19, 40).join("\n");

function ctx(): ExtensionContext {
	return { cwd: tmp } as unknown as ExtensionContext;
}

function readCall(toolCallId: string, input: Record<string, unknown>): ToolCallEvent {
	return { type: "tool_call", toolName: "read", toolCallId, input } as unknown as ToolCallEvent;
}

function readResult(toolCallId: string, input: Record<string, unknown>, text: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "read",
		toolCallId,
		input,
		content: [{ type: "text", text }],
		isError: false,
		details: undefined,
	} as unknown as ToolResultEvent;
}

function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
	return fetch(url).then(async (res) => ({ status: res.status, body: await res.json() }));
}

describe("debug 服务（HTTP 快照端点）", () => {
	let server: DebugServer;
	const events: DebugEvent[] = [];
	let h: ReturnType<typeof createHarness>;

	beforeAll(async () => {
		writeFileSync(absFile, lines(80));
		h = createHarness({ onEvent: (e) => events.push(e), cwd: tmp });
		server = await createDebugServer(h, 0);
	});
	afterAll(async () => {
		await server.close();
	});

	it("parseDebugPort：合法/非法输入", () => {
		expect(parseDebugPort("8787")).toBe(8787);
		expect(parseDebugPort("0")).toBeUndefined();
		expect(parseDebugPort("abc")).toBeUndefined();
		expect(parseDebugPort(undefined)).toBeUndefined();
		expect(parseDebugPort("70000")).toBeUndefined();
	});

	it("GET /api/status：服务信息 + CORS 头", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/api/status`);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		const body = (await res.json()) as { ok: boolean; service: string; endpoints: string[] };
		expect(body.ok).toBe(true);
		expect(body.service).toBe("piwpi-debug");
		expect(body.endpoints).toContain("/api/events (SSE)");
	});

	it("初始快照：plugins 为空、context 为 null", async () => {
		const { status, body } = await fetchJson(`http://127.0.0.1:${server.port}/api/state`);
		expect(status).toBe(200);
		const state = body as { plugins: unknown[]; context: unknown; cwd: string };
		expect(state.plugins).toEqual([]);
		expect(state.context).toBeNull();
		expect(state.cwd).toBe(tmp);
	});

	it("read 流程后：快照含插件元数据（引用式无文本），live 端点实时读盘返回段文本", async () => {
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, text20_40), ctx());

		const { body } = await fetchJson(`http://127.0.0.1:${server.port}/api/state`);
		const state = body as {
			plugins: Array<{
				id: string;
				metadata: {
					segments: Array<{ start: number; end: number }>;
					anchorToolCallId: string;
					hash: string;
				};
			}>;
			pendingCount: number;
			queuePending: number;
		};
		expect(state.plugins).toHaveLength(1);
		const plugin = state.plugins[0]!;
		expect(plugin.id).toBe(fileId(absFile));
		expect(plugin.metadata.segments).toEqual([{ start: 20, end: 40 }]);
		expect(plugin.metadata.anchorToolCallId).toBe("t1");
		expect((plugin.metadata as { memoryState?: string }).memoryState).toBe("pending"); // M5 新模型
		expect(state.pendingCount).toBe(0);
		expect(state.queuePending).toBe(0);

		const list = (await fetchJson(`http://127.0.0.1:${server.port}/api/plugins`)).body as unknown[];
		expect(list).toHaveLength(1);

		// 实时读盘（引用式：磁盘是事实源）→ 挂载范围当前文本
		const live = await fetchJson(
			`http://127.0.0.1:${server.port}/api/plugins/${encodeURIComponent(fileId(absFile))}/live`,
		);
		expect(live.status).toBe(200);
		const liveBody = live.body as { segments: Array<{ start: number; end: number; text: string }> };
		expect(liveBody.segments).toEqual([{ start: 20, end: 40, text: text20_40 }]);

		const missing = await fetchJson(`http://127.0.0.1:${server.port}/api/plugins/nope`);
		expect(missing.status).toBe(404);
		const missingLive = await fetchJson(`http://127.0.0.1:${server.port}/api/plugins/nope/live`);
		expect(missingLive.status).toBe(404);
	});

	it("onContext 后：/api/context 返回截断摘要", async () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "继续" }] },
			{ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: text20_40 }] },
		] as unknown as ContextEvent["messages"];
		await h.onContext({ type: "context", messages } as unknown as ContextEvent, ctx());

		const { body } = await fetchJson(`http://127.0.0.1:${server.port}/api/context`);
		const context = body as {
			messageCount: number;
			toolResultCount: number;
			messages: Array<{ role: string; text: string }>;
		};
		expect(context.messageCount).toBe(2);
		expect(context.toolResultCount).toBe(1);
		expect(context.messages[0]!.role).toBe("user");
		expect(context.messages[1]!.text.length).toBeLessThanOrEqual(300);
	});

	it("未知路径 → 404；非 GET → 405", async () => {
		expect((await fetchJson(`http://127.0.0.1:${server.port}/nope`)).status).toBe(404);
		const res = await fetch(`http://127.0.0.1:${server.port}/api/state`, { method: "POST" });
		expect(res.status).toBe(405);
	});

	it("harness 事件被收集（onEvent 链路）", () => {
		const types = events.map((e) => e.type);
		expect(types).toContain("tool_call");
		expect(types).toContain("mounted");
		expect(types).toContain("context");
	});
});

describe("debug 服务（SSE 实时事件）", () => {
	it("事件按序推送：mounted(new) → memory_queued → memory_updated → memory_batch_done → mounted(updated) → shutdown", async () => {
		writeFileSync(absFile, lines(80));
		const complete = vi.fn(async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						mapEntry: {
							role: "auth",
							responsibilities: [],
							keyStructures: [],
							dependencies: [],
							dependents: [],
							decisions: [],
						},
					}),
				},
			],
		}));
		let server: DebugServer | undefined;
		const h = createHarness({
			queue: new MemoryQueue(0),
			memoryDeps: { complete, model: { provider: "faux" } },
			memoryBatchFiles: 1, // 注入小阈值：1 个 pending 文件即触发批量整理
			cwd: tmp,
			onEvent: (e) => server?.handleEvent(e),
		});
		server = await createDebugServer(h, 0);

		// 先连 SSE，再触发事件流
		const frames: DebugEvent[] = [];
		const frameArrived = new Promise<void>((resolve) => {
			const req = httpGet(`http://127.0.0.1:${server.port}/api/events`, (res: IncomingMessage) => {
				res.setEncoding("utf8");
				let buf = "";
				res.on("data", (chunk: string) => {
					buf += chunk;
					const parts = buf.split("\n\n");
					buf = parts.pop() ?? "";
					for (const part of parts) {
						const line = part.split("\n").find((l) => l.startsWith("data: "));
						if (line) frames.push(JSON.parse(line.slice(6)) as DebugEvent);
					}
					if (frames.some((f) => f.type === "shutdown")) resolve();
				});
			});
			req.on("error", () => resolve());
		});

		await new Promise((r) => setTimeout(r, 100)); // 等待 SSE 连接建立
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, text20_40), ctx());
		appendFileSync(absFile, "\nline81"); // 尾部追加 1 行 → 变更量 0，重挂载不失效
		await h.onToolCall(readCall("t2", { path: FILE, offset: 30, limit: 21 }), ctx());
		await h.onToolResult(readResult("t2", { path: FILE, offset: 30, limit: 21 }, text20_40), ctx());
		await h.shutdown(); // flush 批量整理链 + shutdown 事件

		await Promise.race([
			frameArrived,
			new Promise((_, rej) => setTimeout(() => rej(new Error("SSE timeout")), 5000)),
		]);

		const types = frames.map((f) => f.type);
		expect(types).toContain("tool_call");
		expect(types).toContain("mounted");
		expect(types).toContain("memory_queued");
		expect(types).toContain("memory_updated");
		expect(types).toContain("memory_batch_done");
		expect(types).toContain("shutdown");

		const mountedUpdated = frames.find((f) => f.type === "mounted" && f.kind === "updated");
		expect(mountedUpdated?.pluginId).toBe(fileId(absFile));

		const queuedNew = frames.find((f) => f.type === "memory_queued" && f.kind === "new");
		expect(queuedNew?.pluginId).toBe(fileId(absFile));

		await server.close();
	});
});

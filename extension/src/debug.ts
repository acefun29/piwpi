import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LiveContent } from "./harness.ts";
import type { MapEntry, SourcePluginMeta, ToolContextPlugin } from "./types.ts";

/**
 * piwpi debug 观测服务（HTTP + SSE，零依赖，仅绑定 127.0.0.1）。
 *
 * 启用：环境变量 PIWPI_DEBUG_PORT=<port>（如 8787）→ `PIWPI_DEBUG_PORT=8787 pi -e extension`。
 * 接口文档：extension/docs/debug-api.md
 *
 * 设计：
 * - 只读观测（不改任何状态）；前端 = fetch 快照 + EventSource 订阅增量事件
 * - 快照来自 harness.snapshot()（结构类型注入，避免循环依赖）
 * - SSE 事件在 harness 的 onEvent 回调处广播（工具拦截/挂载/记忆/上下文刷新等）
 */

/** harness 发射的调试事件（类型见 docs/debug-api.md 事件表）。ts 由 harness 发射时填充。 */
export type DebugEvent = {
	type:
		| "session_start"
		| "tool_call"
		| "mounted"
		| "noop"
		| "context"
		| "memory_queued"
		| "memory_updated"
		| "memory_skipped"
		| "memory_batch_done"
		| "invalidated"
		| "map_stale"
		| "restore"
		| "shutdown";
	ts?: number;
	pluginId?: string;
	[k: string]: unknown;
};

/** 上下文消息摘要（文本截断，防止快照膨胀） */
export interface DebugMessageSummary {
	role: string;
	toolCallId?: string;
	hasImage?: boolean;
	/** 文本内容（截断到 MAX_CONTEXT_TEXT 字符） */
	text: string;
}

/** 最近一次 context 事件的快照 */
export interface DebugContextSnapshot {
	ts: number;
	messageCount: number;
	toolResultCount: number;
	messages: DebugMessageSummary[];
}

/** 插件观测视图（引用式重构后只含元数据，不含内容文本；内容实时查看走 /api/plugins/:id/live） */
export interface DebugPluginState {
	id: string;
	category: string;
	source: { toolName: string; identity: string };
	metadata: SourcePluginMeta;
	memory?: ToolContextPlugin["memory"];
}

/** /api/state 全量快照 */
export interface DebugSnapshot {
	cwd: string;
	ts: number;
	plugins: DebugPluginState[];
	projectMap: Record<string, MapEntry>;
	pendingCount: number;
	queuePending: number;
	lastUserText: string;
	context: DebugContextSnapshot | null;
}

/** 每条上下文消息的文本截断长度 */
export const MAX_CONTEXT_TEXT = 300;

export interface DebugServer {
	/** 实际监听端口（传 0 时为系统分配） */
	port: number;
	/** 接收 harness 事件并广播给 SSE 客户端 */
	handleEvent(event: DebugEvent): void;
	close(): Promise<void>;
}

const HEARTBEAT_MS = 15_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

export function createDebugServer(
	harness: {
		snapshot(): DebugSnapshot;
		liveContent(id: string): Promise<LiveContent | null>;
		projectMapTree(): string;
	},
	port: number,
): Promise<DebugServer> {
	const clients = new Set<ServerResponse>();
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let closed = false;

	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		// CORS：前端可在任意来源访问（仅本机绑定的调试服务）
		res.setHeader("access-control-allow-origin", "*");
		res.setHeader("access-control-allow-methods", "GET, OPTIONS");
		res.setHeader("access-control-allow-headers", "content-type");
		if (req.method === "OPTIONS") {
			res.writeHead(204).end();
			return;
		}
		if (req.method !== "GET") {
			sendJson(res, 405, { error: "method not allowed" });
			return;
		}

		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = url.pathname;

		if (path === "/api/status") {
			sendJson(res, 200, {
				ok: true,
				service: "piwpi-debug",
				port,
				endpoints: [
					"/api/status",
					"/api/state",
					"/api/plugins",
					"/api/plugins/:id",
					"/api/plugins/:id/live",
					"/api/context",
					"/api/project-map",
					"/api/events (SSE)",
				],
			});
			return;
		}
		if (path === "/api/state") {
			sendJson(res, 200, harness.snapshot());
			return;
		}
		if (path === "/api/plugins") {
			sendJson(res, 200, harness.snapshot().plugins);
			return;
		}
		if (path === "/api/context") {
			sendJson(res, 200, harness.snapshot().context);
			return;
		}
		if (path === "/api/project-map") {
			const snapshot = harness.snapshot();
			sendJson(res, 200, { entries: snapshot.projectMap, tree: harness.projectMapTree() });
			return;
		}
		// 实时读盘查看（引用式：磁盘是事实源，点击时读取挂载范围当前内容）——必须放在 /:id 之前匹配
		const liveMatch = /^\/api\/plugins\/([^/]+)\/live$/.exec(path);
		if (liveMatch) {
			const id = decodeURIComponent(liveMatch[1]!);
			const live = await harness.liveContent(id);
			if (!live) {
				sendJson(res, 404, { error: `plugin not found or file unreadable: ${id}` });
				return;
			}
			sendJson(res, 200, live);
			return;
		}
		const pluginMatch = /^\/api\/plugins\/([^/]+)$/.exec(path);
		if (pluginMatch) {
			const id = decodeURIComponent(pluginMatch[1]!);
			const plugin = harness.snapshot().plugins.find((p) => p.id === id);
			if (!plugin) {
				sendJson(res, 404, { error: `plugin not found: ${id}` });
				return;
			}
			sendJson(res, 200, plugin);
			return;
		}
		if (path === "/api/events") {
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write("retry: 1000\n\n");
			clients.add(res);
			req.on("close", () => {
				clients.delete(res);
			});
			return;
		}
		sendJson(res, 404, { error: `not found: ${path}` });
	});

	heartbeat = setInterval(() => {
		for (const client of clients) {
			client.write(": keepalive\n\n");
		}
	}, HEARTBEAT_MS);
	heartbeat.unref?.();

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			const address = server.address();
			const actualPort = typeof address === "object" && address ? address.port : port;
			server.removeListener("error", reject);
			resolve({
				port: actualPort,
				handleEvent(event: DebugEvent): void {
					if (closed) return;
					const frame = `event: piwpi\nid: ${event.ts}\ndata: ${JSON.stringify(event)}\n\n`;
					for (const client of clients) {
						client.write(frame);
					}
				},
				close(): Promise<void> {
					closed = true;
					if (heartbeat) clearInterval(heartbeat);
					for (const client of clients) {
						client.end();
					}
					clients.clear();
					return new Promise((resolveClose) => server.close(() => resolveClose()));
				},
			});
		});
	});
}

/** 从环境变量解析调试端口（非法值 → undefined） */
export function parseDebugPort(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const port = Number.parseInt(raw, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
	return port;
}

/**
 * piwpi real-pi process demo（阶段一 M6 补强验证）。
 *
 * 用**真实 pi CLI 进程**（dist/cli.js）+ 本地 mock LLM（OpenAI 兼容流式端点）跑完整 agent 循环：
 *   1. mock LLM 第一次请求 → 要求 read a.ts 20-40
 *   2. pi 执行 read（piwpi 扩展首次挂载，锚点保留全文）
 *   3. mock LLM 第二次请求 → 要求 read a.ts 30-60（piwpi 只补 41-60，结果替换为短引用）
 *   4. mock LLM 第三次请求 → 要求 read a.ts 30-60（已全覆盖 → noop 短引用）
 *   5. mock LLM 第三次响应 "done" → 会话结束
 *
 * 断言（来自 mock server 记录的每轮请求消息体）：
 *   - 第二次请求的 toolResult 含 "[piwpi: … 本次新增 L41-60" 且文本覆盖 line41..line60
 *     （证明真实进程里 input 被改写为 41-60 执行）
 *   - 第三次请求的 toolResult 为 "内容无变化" noop 短引用
 *   - pi 进程 exit 0
 *
 * 用法：node run-demo.mjs
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PI_ROOT = resolve(__dirname, "../../.."); // pi/
const CLI_ENTRY = join(PI_ROOT, "packages", "coding-agent", "dist", "cli.js");
const EXTENSION_DIR = resolve(__dirname, "../.."); // pi/extension

const FILE_LINES = 80;
const requests = [];

/** OpenAI 兼容 SSE chunk 构造 */
function chunk(id, delta, finishReason = null) {
	return `data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created: 1,
		model: "piwpi-mock-1",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}\n\n`;
}

function readToolCall(id, offset, limit) {
	return chunk(
		id,
		{
			role: "assistant",
			tool_calls: [
				{
					index: 0,
					id: `call_${id}`,
					type: "function",
					function: {
						name: "read",
						arguments: JSON.stringify({ path: "a.ts", offset, limit }),
					},
				},
			],
		},
		"tool_calls",
	);
}

function startMockServer(onRequest) {
	const server = createServer((req, res) => {
		if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
			res.writeHead(404).end();
			return;
		}
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			const parsed = JSON.parse(body);
			requests.push({ messages: parsed.messages ?? [] });
			const callIndex = requests.length - 1;
			onRequest?.(callIndex);
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const stream = [];
			if (callIndex === 0) stream.push(readToolCall(1, 20, 21));
			else if (callIndex === 1) stream.push(readToolCall(2, 30, 31));
			else if (callIndex === 2) stream.push(readToolCall(3, 30, 31));
			else stream.push(chunk("c4", { role: "assistant", content: "done" }), chunk("c4", {}, "stop"));
			stream.push("data: [DONE]\n\n");
			res.end(stream.join(""));
		});
	});
	return new Promise((resolvePort) => {
		server.listen(0, "127.0.0.1", () => resolvePort({ server, port: server.address().port }));
	});
}

function textOf(msg) {
	const content = msg.content;
	// openai-completions 请求体中 role=tool 消息的 content 是纯字符串；AgentMessage 原生是块数组
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/** openai-completions 请求中工具结果消息的 role 是 "tool"（convertToLlm 转换），AgentMessage 原生为 "toolResult" */
function toolResults(messages) {
	return messages.filter((m) => m.role === "tool" || m.role === "toolResult");
}

async function main() {
	const tmp = mkdtempSync(join(tmpdir(), "piwpi-pi-demo-"));
	const agentDir = join(tmp, "agent");
	mkdirSync(agentDir, { recursive: true });

	// 调试观测服务端口（真实 pi 进程内验证 debug API）
	const debugPort = 8800 + Math.floor(Math.random() * 100);
	let debugState = null;
	const { server, port } = await startMockServer((callIndex) => {
		// 第 3 次 LLM 请求到达时（两次 read 已挂载），从真实 pi 进程内拉一次 /api/state
		if (callIndex === 2) {
			fetch(`http://127.0.0.1:${debugPort}/api/state`)
				.then((r) => r.json())
				.then((s) => (debugState = s))
				.catch((err) => console.error("[demo] debug state fetch failed:", err.message));
		}
	});
	try {
		writeFileSync(join(tmp, "a.ts"), Array.from({ length: FILE_LINES }, (_, i) => `line${i + 1}`).join("\n"));
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify(
				{
					providers: {
						"piwpi-mock": {
							name: "piwpi mock",
							baseUrl: `http://127.0.0.1:${port}/v1`,
							apiKey: "mock-key",
							api: "openai-completions",
							models: [
								{
									id: "piwpi-mock-1",
									name: "Piwpi Mock",
									api: "openai-completions",
									baseUrl: `http://127.0.0.1:${port}/v1`,
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 128000,
									maxTokens: 16384,
								},
							],
						},
					},
				},
				null,
				2,
			),
		);

		const pi = spawn(
			process.execPath,
			[
				CLI_ENTRY,
				"--model",
				"piwpi-mock/piwpi-mock-1",
				"-e",
				EXTENSION_DIR,
				"-p",
				"read a.ts",
			],
			{
				cwd: tmp,
				// agent 目录环境变量：config.ts:495 ENV_AGENT_DIR = PI_CODING_AGENT_DIR；调试服务经 PIWPI_DEBUG_PORT 开启
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PIWPI_DEBUG_PORT: String(debugPort) },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "",
			stderr = "";
		pi.stdout.on("data", (d) => (stdout += d));
		pi.stderr.on("data", (d) => (stderr += d));
		const exitCode = await new Promise((r) => pi.on("close", r));

		console.log("=== pi stdout ===");
		console.log(stdout.slice(0, 2000));
		console.log("=== pi stderr (tail) ===");
		console.log(stderr.split("\n").slice(-8).join("\n"));

		const failures = [];
		const assert = (cond, name, extra = "") => {
			console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
			if (!cond) failures.push(name);
		};

		assert(exitCode === 0, "pi 进程退出码 0", `exit=${exitCode}`);
		assert(requests.length === 4, `4 次 LLM 请求（实际 ${requests.length} 次）`);
		assert(!stderr.includes("Failed to load extension"), "扩展加载无错误");
		// 真实进程内 debug 服务是否启动：以 /api/state 拉取成功为准（print 模式会屏蔽扩展 stdout 日志）
		assert(!stderr.includes("debug server failed to start"), "真实进程内 debug 服务启动无错误（PIWPI_DEBUG_PORT）");

		// debug API：真实 pi 进程运行中拉取的 /api/state 快照
		assert(debugState !== null, "运行中成功拉取 /api/state");
		assert(debugState?.plugins?.length === 1, "快照含 1 个挂载插件", JSON.stringify(debugState?.plugins?.length));
		const segs = debugState?.plugins?.[0]?.metadata?.segments ?? [];
		assert(segs.length >= 1 && segs[0].start === 20 && segs.at(-1).end === 60, "快照 segments 覆盖 L20-60", JSON.stringify(segs.map((s) => `${s.start}-${s.end}`)));
		assert(debugState?.context?.messageCount > 0, "快照含上下文摘要", `messages=${debugState?.context?.messageCount}`);

		// 第 2 次请求：首条 read 的锚点消息已被 onContext 刷新为确定性渲染（真实进程内锚点刷新）
		const anchor1 = textOf(toolResults(requests[1]?.messages ?? [])[0] ?? { content: [] });
		assert(anchor1.startsWith("[piwpi:plugin"), "第 2 次请求中锚点消息已刷新为 render 输出", anchor1.slice(0, 60));

		// 第 3 次请求：锚点更新为 L20-60 + 第 2 次 read 的增量短引用（input 被改写为 41-60 执行）
		const r2tools = toolResults(requests[2]?.messages ?? []);
		const anchor2 = textOf(r2tools[0] ?? { content: [] });
		assert(anchor2.includes("mounted:L20-60"), "锚点已合并为 L20-60", anchor2.slice(0, 60));
		const second = textOf(r2tools[r2tools.length - 1] ?? { content: [] });
		assert(second.includes("本次新增 L41-60"), "第 2 次 read 实际执行 41-60（新增段标记）", second.slice(0, 80));
		assert(second.includes("line41") && second.includes("line60"), "新增段文本覆盖 line41..line60");

		// 第 4 次请求：第 3 次 read（30-60 已全覆盖）→ noop 短引用
		const third = textOf(toolResults(requests[3]?.messages ?? []).pop() ?? { content: [] });
		assert(third.includes("内容无变化"), "第 3 次 read（已全覆盖）→ noop 短引用", third.slice(0, 80));

		if (failures.length > 0) {
			console.error(`\nDEMO FAILED: ${failures.join("; ")}`);
			process.exitCode = 1;
		} else {
			console.log("\nDEMO PASSED — 真实 pi 进程内 piwpi 拦截行为验证通过");
		}
	} finally {
		server.close();
		rmSync(tmp, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});

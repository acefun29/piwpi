/**
 * 端到端冒烟：真实 prompt → 流式事件（text/thinking/toolcall）→ 工具执行 → debug 挂载。
 *
 * 用法：node scripts/e2e-chat.mjs [prompt]
 * 默认 prompt 会触发 read 工具挂载文件到上下文。
 */
import { startBridge } from "../server/bridge.mjs";
import { StringDecoder } from "node:string_decoder";

const prompt = process.argv[2] ?? "读一下 pi/extension/src/hash.ts 的前 20 行，然后告诉我这个文件是做什么的。";

const { server, port, killPi } = await startBridge({ port: 0 });

/** 从 /api/events 消费 pi 事件 */
async function consumeEvents(onEvent, stopWhen) {
	const res = await fetch(`http://127.0.0.1:${port}/api/events`);
	const decoder = new StringDecoder("utf8");
	let buf = "";
	const reader = res.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.write(value);
		for (;;) {
			const i = buf.indexOf("\n\n");
			if (i === -1) break;
			const frame = buf.slice(0, i);
			buf = buf.slice(i + 2);
			for (const line of frame.split("\n")) {
				if (line.startsWith("data: ")) {
					const evt = JSON.parse(line.slice(6));
					onEvent(evt);
					if (stopWhen(evt)) return;
				}
			}
		}
	}
}

const stats = { updates: 0, text: 0, thinking: 0, toolcall: 0, toolStart: 0, toolEnd: 0, settled: false, errored: false };
let textLen = 0;
const seenTypes = new Set();

const consumer = consumeEvents(
	(evt) => {
		seenTypes.add(evt.type);
		console.log(`  [evt] ${evt.type}${evt.assistantMessageEvent?.type ? "/" + evt.assistantMessageEvent.type : ""}${evt.command ? " command=" + evt.command : ""}`);
		if (evt.type === "message_end" && evt.message) {
			const m = evt.message;
			const contentLen = Array.isArray(m.content) ? m.content.length : typeof m.content === "string" ? m.content.length : "?";
			console.log(`  [msg_end] role=${m.role} stopReason=${m.stopReason} contentBlocks=${contentLen} model=${m.model ?? m.id ?? ""}`);
		}
		if (evt.type === "turn_end") {
			console.log(`  [turn_end] msgStop=${evt.message?.stopReason} toolResults=${evt.toolResults?.length ?? 0}`);
		}
		if (evt.type === "message_update") {
			stats.updates++;
			const d = evt.assistantMessageEvent?.type;
			if (d === "text_delta") { stats.text++; textLen += evt.assistantMessageEvent.delta?.length ?? 0; }
			if (d === "thinking_delta") stats.thinking++;
			if (d === "toolcall_end") stats.toolcall++;
		}
		if (evt.type === "tool_execution_start") stats.toolStart++;
		if (evt.type === "tool_execution_end") stats.toolEnd++;
		if (evt.type === "agent_settled") stats.settled = true;
		if (evt.type === "auto_retry_end" && !evt.success) { stats.errored = true; }
	},
	(evt) => evt.type === "agent_settled" || evt.type === "agent_end" || (evt.type === "response" && evt.command === "prompt" && evt.success === false),
);

// 发送 prompt
const rpcRes = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ type: "prompt", message: prompt }),
});
console.log("prompt accepted:", (await rpcRes.json()).ok);

await Promise.race([
	consumer,
	new Promise((_, reject) => setTimeout(() => reject(new Error("e2e timeout 180s")), 180_000)),
]);

// 拉 debug 快照验证挂载
await new Promise((r) => setTimeout(r, 1200));
const state = await (await fetch(`http://127.0.0.1:${port}/debug/state`)).json();

console.log("---- 事件统计 ----");
console.log(JSON.stringify(stats, null, 2));
console.log(`text 累计 ${textLen} 字符 | thinking_delta ${stats.thinking} 次`);
console.log("seen types:", [...seenTypes].join(", "));
console.log("---- debug 快照 ----");
console.log(`plugins: ${state.plugins?.length ?? 0} 个`);
for (const p of state.plugins ?? []) {
	const meta = p.metadata ?? {};
	const ranges = (meta.segments ?? []).map((s) => `L${s.start}-${s.end}`).join(",");
	console.log(`  ${p.source?.identity} [${ranges}] hash=${String(meta.hash ?? "").slice(0, 8)} anchor=${meta.anchorToolCallId}`);
}
console.log(`context: ${state.context ? `${state.context.messageCount} 条消息 / ${state.context.toolResultCount} 条工具结果` : "null"}`);

killPi();
server.close();
const pass = stats.settled || stats.toolEnd > 0 || stats.text > 0;
console.log(pass ? "\nE2E PASS" : "\nE2E INCONCLUSIVE (无文本输出，检查 LLM 鉴权)");
process.exit(pass ? 0 : 1);

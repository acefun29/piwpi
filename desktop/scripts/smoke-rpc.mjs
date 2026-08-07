// 冒烟测试：spawn pi --mode rpc -e extension（带 PIWPI_DEBUG_PORT），
// 发送 get_state / get_available_thinking_levels，并探测 debug 服务 /api/status。
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../.."); // desktop/scripts → pi 仓库根
const PI_CLI = join(REPO, "extension", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const EXT = join(REPO, "extension");
const DEBUG_PORT = 8787;

const child = spawn(process.execPath, [PI_CLI, "--mode", "rpc", "--no-session", "-e", EXT], {
	env: { ...process.env, PIWPI_DEBUG_PORT: String(DEBUG_PORT) },
	stdio: ["pipe", "pipe", "pipe"],
});

const decoder = new StringDecoder("utf8");
let buf = "";
const lines = [];
child.stdout.on("data", (chunk) => {
	buf += decoder.write(chunk);
	for (;;) {
		const i = buf.indexOf("\n");
		if (i === -1) break;
		let line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (line.trim()) lines.push(line);
	}
});
child.stderr.on("data", (d) => process.stderr.write("[pi-stderr] " + d));

const send = (cmd) => child.stdin.write(JSON.stringify(cmd) + "\n");

async function waitFor(pred, timeoutMs, label) {
	const start = Date.now();
	for (;;) {
		const idx = lines.findIndex(pred);
		if (idx !== -1) return lines.splice(idx, 1)[0];
		if (Date.now() - start > timeoutMs) throw new Error("timeout waiting: " + label);
		await new Promise((r) => setTimeout(r, 50));
	}
}

try {
	send({ id: "s1", type: "get_state" });
	const stateLine = await waitFor((l) => l.includes('"s1"'), 30000, "get_state response");
	const state = JSON.parse(stateLine);
	console.log("get_state success:", state.success, "| model:", state.data?.model?.id ?? null, "| thinking:", state.data?.thinkingLevel);

	send({ id: "s2", type: "get_available_thinking_levels" });
	const tlLine = await waitFor((l) => l.includes('"s2"'), 10000, "thinking levels");
	console.log("thinking levels:", JSON.parse(tlLine).data?.levels);

	// 上下文分布：空会话时 system+tools > 0，其余分类为 0，percent 有值
	send({ id: "s3", type: "get_context_breakdown" });
	const bdLine = await waitFor((l) => l.includes('"s3"'), 10000, "context breakdown");
	const bd = JSON.parse(bdLine).data;
	if (!bd || typeof bd.percent !== "number") throw new Error("context breakdown missing data");
	const b = bd.breakdown;
	if (b.system <= 0 || b.tools <= 0 || b.total <= 0) throw new Error(`unexpected breakdown: ${JSON.stringify(b)}`);
	if (b.user + b.assistant + b.thinking + b.toolCalls + b.toolResults + b.images !== 0) {
		throw new Error(`empty session should have no message categories: ${JSON.stringify(b)}`);
	}
	if (b.total !== b.system + b.tools + b.user + b.assistant + b.thinking + b.toolCalls + b.toolResults + b.images) {
		throw new Error(`total mismatch: ${JSON.stringify(b)}`);
	}
	console.log("context breakdown:", JSON.stringify(bd));

	// 等扩展把 debug server 拉起来
	let ok = false;
	for (let i = 0; i < 40; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/api/status`);
			if (res.ok) {
				console.log("debug /api/status:", JSON.stringify(await res.json()).slice(0, 120));
				ok = true;
				break;
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	if (!ok) console.log("debug server NOT reachable (extension may not start debug server in rpc mode)");
} catch (err) {
	console.error("SMOKE FAIL:", err.message);
	console.error("collected lines:", lines.slice(0, 10));
} finally {
	child.kill();
}
process.exit(0);

import { spawn } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const rpcEntry = process.env.PIWPI_PI_CLI ?? join(repo, "packages", "coding-agent", "dist", "rpc-entry.js");
const child = spawn(process.execPath, [rpcEntry, "--no-session", "--offline"], {
	cwd: repo,
	env: {
		...process.env,
		...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
	},
	stdio: ["pipe", "pipe", "pipe"],
});

const decoder = new StringDecoder("utf8");
const lines = [];
let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline === -1) break;
		const line = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
		if (line.trim()) lines.push(line);
	}
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

function request(id, type, fields = {}) {
	child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
}

async function response(id, timeoutMs = 30_000) {
	const started = Date.now();
	for (;;) {
		const index = lines.findIndex((line) => {
			try {
				return JSON.parse(line).id === id;
			} catch {
				return false;
			}
		});
		if (index !== -1) return JSON.parse(lines.splice(index, 1)[0]);
		if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${id}`);
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
}

try {
	request("state", "get_state");
	const state = await response("state", 90_000);
	if (!state.success) throw new Error(state.error);

	request("piwpi", "get_piwpi_state");
	const piwpi = await response("piwpi");
	if (!piwpi.success || piwpi.data.cwd !== repo) throw new Error("Invalid built-in piwpi state");

	request("levels", "get_available_thinking_levels");
	const levels = await response("levels");
	if (!levels.success || !Array.isArray(levels.data.levels)) throw new Error("Thinking levels unavailable");

	console.log(`RPC smoke passed: ${state.data.sessionId} (${piwpi.data.plugins.length} mounts)`);
} finally {
	child.stdin.end();
	if (child.exitCode === null) await once(child, "exit");
}

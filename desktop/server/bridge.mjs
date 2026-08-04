/**
 * piwpi 桌面端 bridge（零依赖，仅 Node 标准库）。
 *
 * 职责：
 * 1. 托管 web/ 静态文件
 * 2. spawn `pi --mode rpc -e extension`（自动注入 PIWPI_DEBUG_PORT）
 * 3. POST /api/rpc        → 写一条 JSONL 命令到 pi stdin
 * 4. GET  /api/events     → SSE 转发 pi stdout 的所有 JSON 行（事件 + 命令响应）
 * 5. GET  /debug/*        → 反向代理 piwpi 扩展 debug 服务（含 SSE）
 * 6. GET  /api/bridge/status → bridge 与 pi 进程状态
 *
 * 用法：
 *   - 直接运行：node server/bridge.mjs
 *   - 被 Electron 主进程 import：await startBridge({ port: 0 }) → { server, port, killPi }
 *
 * 配置（环境变量，startBridge 入参优先级更高）：
 *   PORT              监听端口（默认 8901；0 = 随机）
 *   PIWPI_DEBUG_PORT  扩展 debug 服务端口（默认 8787；0 = 随机，需扩展支持回读——扩展不支持，故做启动前 probe）
 *   PIWPI_WORKSPACE   pi 进程工作目录（默认 piwpi 仓库根）
 *   PIWPI_PI_CLI      pi-coding-agent cli.js 路径（默认 extension/node_modules 内）
 *   PIWPI_EXT         piwpi 扩展路径（默认 ../pi/extension）
 *   PIWPI_PI_ARGS     额外传给 pi 的参数（空格分隔）
 */
import { spawn } from "node:child_process";
import { createServer, get as httpGet, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, ".."); // desktop/
const REPO = resolve(ROOT, ".."); // piwpi/
const WEB_DIR = join(ROOT, "web");

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

/** 探测本地端口是否可用 */
function isPortFree(port) {
	return new Promise((resolveFree) => {
		const probe = createServer();
		probe.once("error", () => resolveFree(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => resolveFree(true)));
	});
}

/**
 * 启动 bridge：spawn pi RPC 子进程 + HTTP 服务。
 * @param {{port?: number, workspace?: string, piCli?: string, extPath?: string, debugPort?: number, onPiExit?: Function}} opts
 * @returns {Promise<{server: import("node:http").Server, port: number, workspace: string, killPi: Function}>}
 */
export async function startBridge(opts = {}) {
	const port = opts.port ?? Number.parseInt(process.env.PORT ?? "8901", 10);
	let debugPort = opts.debugPort ?? Number.parseInt(process.env.PIWPI_DEBUG_PORT ?? "8787", 10);
	const workspace = opts.workspace ?? process.env.PIWPI_WORKSPACE ?? REPO;
	// desktop/ 位于 pi 仓库根下：REPO = pi 仓库根，piwpi 扩展即 REPO/extension
	const piCli = opts.piCli ?? process.env.PIWPI_PI_CLI ?? join(REPO, "extension", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
	const extPath = opts.extPath ?? process.env.PIWPI_EXT ?? join(REPO, "extension");
	const extraArgs = (process.env.PIWPI_PI_ARGS ?? "--model deepseek/deepseek-v4-flash").split(" ").filter(Boolean);
	const onPiExit = opts.onPiExit ?? (() => {});

	if (!existsSync(piCli)) {
		throw new Error(`pi cli not found: ${piCli}（设置 PIWPI_PI_CLI 指定 pi-coding-agent dist/cli.js）`);
	}
	// debug 端口被占则递增重试（最多 +50），避免与别的进程冲突
	if (!(await isPortFree(debugPort))) {
		let found = debugPort;
		for (let i = 1; i <= 50; i++) {
			if (await isPortFree(debugPort + i)) { found = debugPort + i; break; }
		}
		if (found !== debugPort) {
			console.warn(`[bridge] debug port ${debugPort} occupied, using ${found}`);
			debugPort = found;
		}
	}

	/* ================= pi RPC 子进程 ================= */
	let pi = null;
	let piAlive = false;
	const sseClients = new Set();

	function broadcast(line) {
		const frame = `data: ${line}\n\n`;
		for (const res of sseClients) {
			try { res.write(frame); } catch { sseClients.delete(res); }
		}
	}

	function startPi() {
		const isElectron = !!process.versions.electron;
		const args = [piCli, "--mode", "rpc", "-e", extPath, ...extraArgs];
		console.log(`[bridge] spawn: ${isElectron ? "<electron as node>" : process.execPath} ${args.join(" ")}`);
		console.log(`[bridge] workspace: ${workspace} | debug port: ${debugPort}`);
		pi = spawn(process.execPath, args, {
			cwd: workspace,
			env: {
				...process.env,
				PIWPI_DEBUG_PORT: String(debugPort),
				// Electron 主进程里 process.execPath 是 electron.exe；必须让它以 Node 模式跑 cli.js
				...(isElectron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		piAlive = true;

		// 严格 JSONL：只按 \n 切、剥尾 \r（禁用 readline，避免误切 U+2028/2029）
		const decoder = new StringDecoder("utf8");
		let buf = "";
		pi.stdout.on("data", (chunk) => {
			buf += decoder.write(chunk);
			for (;;) {
				const i = buf.indexOf("\n");
				if (i === -1) break;
				let line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line.trim()) broadcast(line);
			}
		});
		pi.stdout.on("end", () => {
			buf += decoder.end();
			if (buf.trim()) broadcast(buf);
		});
		pi.stderr.on("data", (d) => process.stderr.write(`[pi] ${d}`));
		pi.on("exit", (code, signal) => {
			piAlive = false;
			console.log(`[bridge] pi exited (code=${code} signal=${signal})`);
			broadcast(JSON.stringify({ type: "bridge_pi_exit", code, signal }));
			onPiExit(code, signal);
		});
	}

	function sendToPi(cmd) {
		if (!piAlive || !pi) throw new Error("pi process not running");
		pi.stdin.write(JSON.stringify(cmd) + "\n");
	}

	function killPi() {
		if (pi && piAlive) {
			try { pi.kill(); } catch { /* ignore */ }
		}
	}

	startPi();

	/* ================= 静态文件 ================= */
	async function serveStatic(pathname, res) {
		const rel = pathname === "/" ? "/index.html" : pathname;
		const filePath = normalize(join(WEB_DIR, rel));
		const relCheck = relative(WEB_DIR, filePath);
		if (relCheck.startsWith("..") || isAbsolute(relCheck)) {
			res.writeHead(403).end("forbidden");
			return;
		}
		try {
			const data = await readFile(filePath);
			res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
			res.end(data);
		} catch {
			res.writeHead(404).end("not found");
		}
	}

	/* ================= debug 服务反代（含 SSE） ================= */
	function proxyDebug(pathname, req, res) {
		const target = `http://127.0.0.1:${debugPort}${pathname}`;
		const proxyReq = httpRequest(target, { method: req.method ?? "GET" }, (proxyRes) => {
			res.writeHead(proxyRes.statusCode ?? 502, {
				"content-type": proxyRes.headers["content-type"] ?? "application/json; charset=utf-8",
				"cache-control": proxyRes.headers["cache-control"] ?? "no-cache",
			});
			proxyRes.pipe(res);
			// 客户端断开时中止上游，避免 SSE 泄漏
			res.on("close", () => proxyRes.destroy());
		});
		proxyReq.on("error", () => {
			if (!res.headersSent) {
				res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
			}
			res.end(JSON.stringify({ error: "piwpi debug server unreachable", port: debugPort }));
		});
		if (req.method !== "GET") {
			req.on("data", (c) => proxyReq.write(c));
			req.on("end", () => proxyReq.end());
		} else {
			proxyReq.end();
		}
	}

	/* ================= HTTP 服务 ================= */
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = url.pathname;

		if (path === "/api/events" && req.method === "GET") {
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write("retry: 1000\n\n");
			res.write(`data: ${JSON.stringify({ type: "bridge_hello", piAlive, ts: Date.now() })}\n\n`);
			sseClients.add(res);
			req.on("close", () => sseClients.delete(res));
			return;
		}

		if (path === "/api/rpc" && req.method === "POST") {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				try {
					const cmd = JSON.parse(body);
					sendToPi(cmd);
					res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ ok: true }));
				} catch (err) {
					res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
				}
			});
			return;
		}

		if (path === "/api/bridge/status" && req.method === "GET") {
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ ok: true, piAlive, debugPort, workspace, clients: sseClients.size }));
			return;
		}

		if (path.startsWith("/debug/") && req.method === "GET") {
			proxyDebug(path.replace(/^\/debug/, "/api"), req, res);
			return;
		}

		if (req.method === "GET") {
			serveStatic(path, res);
			return;
		}

		res.writeHead(405).end("method not allowed");
	});

	await new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolveListen();
		});
	});
	const actualPort = server.address().port;
	console.log(`[bridge] piwpi desktop ready: http://127.0.0.1:${actualPort}`);
	console.log(`[bridge] debug proxy: /debug/* -> 127.0.0.1:${debugPort}/api/*`);

	return { server, port: actualPort, workspace, killPi, get piAlive() { return piAlive; } };
}

/* ================= 直接运行自启 ================= */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	startBridge().catch((err) => {
		console.error(`[bridge] fatal: ${err.message}`);
		process.exit(1);
	});
}

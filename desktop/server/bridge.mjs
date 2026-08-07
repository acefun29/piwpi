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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
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
	// 当前项目目录（可变：POST /api/project 切换时更新并重启 pi）
	let workspace = opts.workspace ?? process.env.PIWPI_WORKSPACE ?? REPO;
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
		// 会话持久化到项目内 .piwpi/sessions（数据跟项目走；pi 内部仍按 safeCwd 分目录）
		const sessionDir = join(workspace, ".piwpi", "sessions");
		const args = [piCli, "--mode", "rpc", "-e", extPath, "--session-dir", sessionDir, ...extraArgs];
		console.log(`[bridge] spawn: ${isElectron ? "<electron as node>" : process.execPath} ${args.join(" ")}`);
		console.log(`[bridge] workspace: ${workspace} | session dir: ${sessionDir} | debug port: ${debugPort}`);
		const child = spawn(process.execPath, args, {
			cwd: workspace,
			env: {
				...process.env,
				PIWPI_DEBUG_PORT: String(debugPort),
				// Electron 主进程里 process.execPath 是 electron.exe；必须让它以 Node 模式跑 cli.js
				...(isElectron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		pi = child;
		piAlive = true;

		// 严格 JSONL：只按 \n 切、剥尾 \r（禁用 readline，避免误切 U+2028/2029）
		const decoder = new StringDecoder("utf8");
		let buf = "";
		child.stdout.on("data", (chunk) => {
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
		child.stdout.on("end", () => {
			buf += decoder.end();
			if (buf.trim()) broadcast(buf);
		});
		child.stderr.on("data", (d) => process.stderr.write(`[pi] ${d}`));
		child.on("exit", (code, signal) => {
			// 只认当前进程：切换项目时 killPi 后立即 startPi，旧进程的 exit 事件会异步晚到，
			// 若不区分会把新进程的 piAlive 覆盖回 false（前端轮询会误判 pi 未重启）
			if (pi !== child) return;
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

	/* ================= 项目注册表（发现索引：会话数据仍在各项目 .piwpi/ 内） ================= */
	/** 注册表文件：~/.pi/agent/piwpi/projects.json（JSON 数组，绝对路径；与扩展全局状态同目录） */
	function projectsFilePath() {
		return join(homedir(), ".pi", "agent", "piwpi", "projects.json");
	}

	async function readProjects() {
		try {
			const data = JSON.parse(await readFile(projectsFilePath(), "utf8"));
			return Array.isArray(data) ? data.filter((p) => typeof p === "string") : [];
		} catch {
			return [];
		}
	}

	/** 注册项目（读-合-写，防并发覆盖）；目录需存在 */
	async function registerProject(cwd) {
		const resolved = resolve(cwd);
		if (!existsSync(resolved)) return;
		const projects = await readProjects();
		if (projects.some((p) => normPathEquals(p, resolved))) return;
		projects.push(resolved);
		try {
			await mkdir(dirname(projectsFilePath()), { recursive: true });
			await writeFile(projectsFilePath(), JSON.stringify(projects, null, 2), "utf8");
		} catch { /* 注册失败不影响主流程 */ }
	}

	/** 路径比较（win32 大小写不敏感） */
	function normPathEquals(a, b) {
		const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
		return norm(a) === norm(b);
	}

	/* ================= 会话列表 / 项目切换 ================= */
	/**
	 * 读会话 JSONL 摘要（首行 header + session_info 名称 + message 计数，限量 2000 行防大文件拖垮列表）。
	 * 语义参照 packages/coding-agent/src/core/session-manager.ts:688-760 的 list 实现，轻量零依赖。
	 */
	async function readSessionSummary(filePath) {
		let text;
		try {
			text = await readFile(filePath, "utf8");
		} catch {
			return null;
		}
		const lines = text.split("\n").slice(0, 2000);
		let header = null;
		let name;
		let messageCount = 0;
		let lastActivity = 0;
		let firstMessage = "";
		for (const line of lines) {
			let e;
			try { e = JSON.parse(line); } catch { continue; }
			if (!e || typeof e !== "object") continue;
			if (!header) {
				if (e.type !== "session") return null; // 首行非 header → 非法会话文件
				header = e;
				continue;
			}
			if (e.type === "session_info" && typeof e.name === "string" && e.name.trim()) {
				name = e.name.trim();
			}
			if (e.type === "message") {
				messageCount++;
				const t = e.timestamp;
				const ts = typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN;
				if (Number.isFinite(ts) && ts > lastActivity) lastActivity = ts;
				// 首条文本消息作会话摘要（codex 同款展示：无标题时用首条消息）
				if (!firstMessage) {
					const msg = e.message;
					if (msg?.role === "user" || msg?.role === "assistant") {
						const content = msg.content;
						const text = Array.isArray(content)
							? content.filter((c) => c?.type === "text").map((c) => c.text).join(" ").trim()
							: typeof content === "string"
								? content.trim()
								: "";
						if (text) firstMessage = text.length > 40 ? `${text.slice(0, 40)}…` : text;
					}
				}
			}
		}
		if (!header) return null;
		const created = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
		const modified = lastActivity > 0 ? lastActivity : Number.isFinite(created) ? created : 0;
		return {
			sessionFile: filePath,
			id: header.id,
			name: name ?? null,
			firstMessage,
			cwd: header.cwd ?? null,
			created: Number.isFinite(created) ? created : 0,
			modified,
			messageCount,
		};
	}

	/** 列出当前项目全部会话（<cwd>/.piwpi/sessions 下递归 *.jsonl），按最近活动降序 */
	async function listSessions(cwd) {
		const root = join(cwd, ".piwpi", "sessions");
		const out = [];
		if (!existsSync(root)) return out;
		const walk = (dir) => {
			let entries;
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const ent of entries) {
				const p = join(dir, ent.name);
				if (ent.isDirectory()) walk(p);
				else if (ent.name.endsWith(".jsonl")) out.push(p);
			}
		};
		walk(root);
		const items = (await Promise.all(out.map(readSessionSummary))).filter(Boolean);
		items.sort((a, b) => b.modified - a.modified || b.created - a.created);
		return items;
	}

	/** 删除会话文件（只允许 .piwpi/sessions 内的绝对路径，防越权删任意文件） */
	function deleteSession(file, projectCwd) {
		const root = resolve(join(projectCwd, ".piwpi", "sessions"));
		const target = resolve(file);
		if (!target.startsWith(root + "\\") && !target.startsWith(root + "/")) return false;
		try {
			rmSync(target, { force: true });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * 当前项目目录的事实源 = 扩展 debug 快照的 cwd（切换项目后扩展自动跟随）；
	 * debug 未就绪时降级为启动 workspace（信息性初始值）。
	 */
	async function currentProjectCwd() {
		try {
			const res = await fetch(`http://127.0.0.1:${debugPort}/api/state`);
			if (res.ok) {
				const state = await res.json();
				if (typeof state.cwd === "string" && state.cwd) return state.cwd;
			}
		} catch {
			/* fallthrough */
		}
		return workspace;
	}

	/** 原生目录选择对话框（仅 Electron 主进程可用；web 调试模式返回 ok:false 由前端降级） */
	async function pickProjectDirectory() {
		if (!process.versions.electron) return { ok: false, error: "仅桌面端支持（web 调试模式请手动输入路径）" };
		try {
			const { dialog } = await import("electron");
			const result = await dialog.showOpenDialog({
				title: "选择项目目录",
				properties: ["openDirectory"],
			});
			if (result.canceled || !result.filePaths?.[0]) return { ok: false, error: "已取消" };
			return { ok: true, path: result.filePaths[0] };
		} catch (err) {
			return { ok: false, error: String(err?.message ?? err) };
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

		// 原生目录选择对话框（Electron 主进程；切换动作由前端直接发 switch_project RPC，不重启）
		if (path === "/api/project/picker" && req.method === "POST") {
			pickProjectDirectory().then((result) => {
				res.writeHead(result.ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify(result));
			});
			return;
		}

		// 会话列表：全部注册项目的会话（对齐 Codex 桌面版"无 cwd 过滤 = 全部"；当前项目惰性注册）
		if (path === "/api/sessions" && req.method === "GET") {
			currentProjectCwd().then(async (cwd) => {
				await registerProject(cwd);
				const projects = await readProjects();
				const nested = await Promise.all(projects.map(async (p) => ({ p, sessions: await listSessions(p) })));
				const sessions = nested.flatMap(({ p, sessions }) =>
					sessions.map((s) => ({ ...s, cwd: s.cwd || p })),
				);
				sessions.sort((a, b) => b.modified - a.modified || b.created - a.created);
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ ok: true, currentCwd: cwd, sessions }));
			});
			return;
		}

		// 删除会话文件（只允许任一注册项目的 .piwpi/sessions 内路径）
		if (path === "/api/sessions" && req.method === "DELETE") {
			const file = url.searchParams.get("file");
			readProjects().then((projects) => {
				const deleted = typeof file === "string" && file
					? projects.some((p) => deleteSession(file, p))
					: false;
				res.writeHead(deleted ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ ok: deleted, error: deleted ? undefined : "无效的会话文件路径" }));
			});
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

/**
 * piwpi 桌面端 bridge（零依赖，仅 Node 标准库）。
 *
 * 职责：
 * 1. 托管 web/ 静态文件
 * 2. spawn piwpi 内建 RPC runtime
 * 3. POST /api/rpc        → 写一条 JSONL 命令到 pi stdin
 * 4. GET  /api/events     → SSE 转发 pi stdout 的所有 JSON 行（事件 + 命令响应）
 * 5. GET  /api/bridge/status → bridge 与 agent 进程状态
 *
 * 用法：
 *   - 直接运行：node server/bridge.mjs
 *   - 被 Electron 主进程 import：await startBridge({ port: 0 }) → { server, port, killPi }
 *
 * 配置（环境变量，startBridge 入参优先级更高）：
 *   PORT              监听端口（默认 8901；0 = 随机）
 *   PIWPI_WORKSPACE   pi 进程工作目录（默认 piwpi 仓库根）
 *   PIWPI_PI_CLI      piwpi RPC 入口路径
 *   PIWPI_PI_ARGS     额外传给 pi 的参数（空格分隔）
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, ".."); // desktop/
const REPO = resolve(ROOT, ".."); // piwpi/
const WEB_DIR = join(ROOT, "web");
const CUSTOM_PROVIDER_PREFIX = "piwpi-custom-";
const SUPPORTED_PROVIDER_APIS = new Set([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
]);
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

function modelsFilePath() {
	return join(homedir(), ".pi", "agent", "models.json");
}

async function readModelsConfig() {
	try {
		const value = JSON.parse(await readFile(modelsFilePath(), "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("models.json 顶层必须是对象");
		if (value.providers !== undefined && (!value.providers || typeof value.providers !== "object" || Array.isArray(value.providers))) {
			throw new Error("models.json providers 必须是对象");
		}
		return { ...value, providers: value.providers ?? {} };
	} catch (err) {
		if (err?.code === "ENOENT") return { providers: {} };
		throw err;
	}
}

async function writeModelsConfig(config) {
	await mkdir(dirname(modelsFilePath()), { recursive: true });
	await writeFile(modelsFilePath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function validateBaseUrl(value) {
	const url = new URL(String(value));
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL 只支持 http 或 https");
	return url.toString().replace(/\/$/, "");
}

function normalizeDiscoveredModel(raw, providerApi) {
	const sourceId = typeof raw?.id === "string" ? raw.id : typeof raw?.name === "string" ? raw.name : "";
	const id = providerApi === "google-generative-ai" ? sourceId.replace(/^models\//, "") : sourceId;
	if (!id) return null;
	const model = { id };
	const name = raw.displayName ?? raw.display_name ?? raw.name;
	if (typeof name === "string" && name && name !== sourceId) model.name = name;
	const contextWindow = raw.context_length ?? raw.inputTokenLimit;
	if (Number.isFinite(contextWindow)) model.contextWindow = contextWindow;
	const maxTokens = raw.top_provider?.max_completion_tokens ?? raw.outputTokenLimit;
	if (Number.isFinite(maxTokens)) model.maxTokens = maxTokens;
	if (Array.isArray(raw.architecture?.input_modalities)) {
		model.input = raw.architecture.input_modalities.filter((value) => value === "text" || value === "image");
	}
	if (Array.isArray(raw.supported_parameters) && raw.supported_parameters.includes("reasoning")) model.reasoning = true;
	return model;
}

async function requestModelPage(url, headers) {
	const response = await fetch(url, { headers });
	if (!response.ok) throw new Error(`模型发现失败（HTTP ${response.status} ${response.statusText}）`);
	return response.json();
}

async function discoverModels({ api, baseUrl, apiKey }) {
	if (!SUPPORTED_PROVIDER_APIS.has(api)) throw new Error(`不支持的接口类型：${api}`);
	if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("API key 不能为空");
	const base = validateBaseUrl(baseUrl);
	const models = [];
	if (api === "anthropic-messages") {
		let url = new URL(`${base}/v1/models`);
		for (;;) {
			const data = await requestModelPage(url, { "x-api-key": apiKey.trim(), "anthropic-version": "2023-06-01" });
			models.push(...(Array.isArray(data.data) ? data.data : []));
			if (!data.has_more || typeof data.last_id !== "string") break;
			url = new URL(`${base}/v1/models`);
			url.searchParams.set("after_id", data.last_id);
		}
	} else if (api === "google-generative-ai") {
		let url = new URL(`${base}/models`);
		for (;;) {
			const data = await requestModelPage(url, { "x-goog-api-key": apiKey.trim() });
			const page = Array.isArray(data.models)
				? data.models.filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
				: [];
			models.push(...page);
			if (typeof data.nextPageToken !== "string" || !data.nextPageToken) break;
			url = new URL(`${base}/models`);
			url.searchParams.set("pageToken", data.nextPageToken);
		}
	} else {
		const data = await requestModelPage(new URL(`${base}/models`), { authorization: `Bearer ${apiKey.trim()}` });
		models.push(...(Array.isArray(data.data) ? data.data : []));
	}
	const normalized = models.map((model) => normalizeDiscoveredModel(model, api)).filter(Boolean);
	const unique = [...new Map(normalized.map((model) => [model.id, model])).values()];
	unique.sort((a, b) => a.id.localeCompare(b.id));
	return unique;
}

function readJsonBody(req) {
	return new Promise((resolveBody, rejectBody) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			try { resolveBody(JSON.parse(body)); } catch (err) { rejectBody(err); }
		});
		req.on("error", rejectBody);
	});
}

function sendJson(res, status, value) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(value));
}

async function getProviderConfiguration() {
	const config = await readModelsConfig();
	const custom = Object.entries(config.providers)
		.filter(([id]) => id.startsWith(CUSTOM_PROVIDER_PREFIX))
		.map(([id, provider]) => ({
			id,
			name: provider.name ?? id,
			api: provider.api,
			baseUrl: provider.baseUrl,
			models: Array.isArray(provider.models) ? provider.models : [],
		}));
	return { custom };
}

async function saveCustomProvider(input) {
	const name = typeof input?.name === "string" ? input.name.trim() : "";
	const api = input?.api;
	if (!name) throw new Error("供应商名称不能为空");
	if (!SUPPORTED_PROVIDER_APIS.has(api)) throw new Error(`不支持的接口类型：${api}`);
	const baseUrl = validateBaseUrl(input?.baseUrl);
	if (!Array.isArray(input?.models) || input.models.length === 0) throw new Error("至少选择或添加一个模型");
	const models = input.models.map((model) => {
		const id = typeof model?.id === "string" ? model.id.trim() : "";
		if (!id) throw new Error("模型 ID 不能为空");
		const result = { id };
		if (typeof model.name === "string" && model.name.trim()) result.name = model.name.trim();
		if (typeof model.reasoning === "boolean") result.reasoning = model.reasoning;
		if (Array.isArray(model.input) && model.input.length) result.input = model.input;
		if (Number.isFinite(model.contextWindow)) result.contextWindow = model.contextWindow;
		if (Number.isFinite(model.maxTokens)) result.maxTokens = model.maxTokens;
		return result;
	});
	const requestedId = typeof input.id === "string" ? input.id : "";
	if (requestedId && !requestedId.startsWith(CUSTOM_PROVIDER_PREFIX)) throw new Error("只能编辑 piwpi 自定义供应商");
	const id = requestedId || `${CUSTOM_PROVIDER_PREFIX}${randomUUID()}`;
	const config = await readModelsConfig();
	config.providers[id] = { name, baseUrl, api, models };
	await writeModelsConfig(config);
	return { id, ...config.providers[id] };
}

async function deleteCustomProvider(id) {
	if (!id.startsWith(CUSTOM_PROVIDER_PREFIX)) throw new Error("只能删除 piwpi 自定义供应商");
	const config = await readModelsConfig();
	if (!Object.hasOwn(config.providers, id)) throw new Error("供应商不存在");
	delete config.providers[id];
	await writeModelsConfig(config);
}

/**
 * 启动 bridge：spawn piwpi RPC 子进程 + HTTP 服务。
 * @param {{port?: number, workspace?: string, piCli?: string, onPiExit?: Function}} opts
 * @returns {Promise<{server: import("node:http").Server, port: number, workspace: string, killPi: Function}>}
 */
export async function startBridge(opts = {}) {
	const port = opts.port ?? Number.parseInt(process.env.PORT ?? "8901", 10);
	// P0-3：控制端点鉴权 token（每次启动随机生成，只交给当前窗口；dev 模式放行）
	const authToken = randomBytes(32).toString("hex");
	const devMode = opts.dev ?? (process.argv.includes("--dev") || process.env.PIWPI_BRIDGE_DEV === "1");
	// 当前项目目录（可变：POST /api/project 切换时更新并重启 pi）
	let workspace = opts.workspace ?? process.env.PIWPI_WORKSPACE ?? REPO;
	const packagedRpcEntry = join(
		process.resourcesPath ?? "",
		"runtime.asar",
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"rpc-entry.js",
	);
	const piCli = opts.piCli ?? process.env.PIWPI_PI_CLI ?? (existsSync(packagedRpcEntry)
		? packagedRpcEntry
		: join(REPO, "packages", "coding-agent", "dist", "rpc-entry.js"));
	const extraArgs = (
		process.env.PIWPI_PI_ARGS ??
		"--offline --tools read,grep,find,ls,bash,edit,write,read_project_map,request_user_input,update_plan_document"
	).split(" ").filter(Boolean);
	const onPiExit = opts.onPiExit ?? (() => {});

	if (!existsSync(piCli)) {
		throw new Error(`pi cli not found: ${piCli}（设置 PIWPI_PI_CLI 指定 pi-coding-agent dist/cli.js）`);
	}
	/* ================= pi RPC 子进程 ================= */
	let pi = null;
	let piAlive = false;
	// P2-7：按 clientId 索引的 SSE 客户端（同 id 重连替换，异 id 冲突 409）
	const sseClients = new Map(); // clientId -> res

	function broadcast(line) {
		const frame = `data: ${line}\n\n`;
		for (const [clientId, res] of sseClients) {
			try { res.write(frame); } catch { sseClients.delete(clientId); }
		}
	}

	/** P0-3：控制端点鉴权（静态文件与 / 除外）。devMode 放行；否则要求 Bearer token。 */
	function authorized(req, res) {
		if (devMode) return true;
		if (req.headers.authorization === `Bearer ${authToken}`) return true;
		res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ error: "unauthorized" }));
		return false;
	}

	function startPi() {
		const isElectron = !!process.versions.electron;
		// 会话持久化到项目内 .piwpi/sessions（数据跟项目走；pi 内部仍按 safeCwd 分目录）
		const sessionDir = join(workspace, ".piwpi", "sessions");
		const args = [piCli, "--session-dir", sessionDir, ...extraArgs];
		console.log(`[bridge] spawn: ${isElectron ? "<electron as node>" : process.execPath} ${args.join(" ")}`);
		console.log(`[bridge] workspace: ${workspace} | session dir: ${sessionDir}`);
		const child = spawn(process.execPath, args, {
			cwd: workspace,
			env: {
				...process.env,
				NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE ?? join(homedir(), ".pi", "agent", "piwpi", "node-compile-cache"),
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
		if (cmd?.type === "switch_project" && typeof cmd.path === "string") workspace = resolve(cmd.path);
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
	const sessionSummaryCache = new Map();

	async function readSessionLines(filePath) {
		const handle = await open(filePath, "r");
		const chunks = [];
		const buffer = Buffer.allocUnsafe(64 * 1024);
		const decoder = new StringDecoder("utf8");
		let position = 0;
		let newlineCount = 0;
		try {
			while (newlineCount < 2000) {
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
				if (bytesRead === 0) break;
				const chunk = decoder.write(buffer.subarray(0, bytesRead));
				chunks.push(chunk);
				newlineCount += chunk.split("\n").length - 1;
				position += bytesRead;
			}
		} finally {
			chunks.push(decoder.end());
			await handle.close();
		}
		return chunks.join("").split("\n").slice(0, 2000);
	}

	/**
	 * 读会话 JSONL 摘要（首行 header + session_info 名称 + message 计数，限量 2000 行防大文件拖垮列表）。
	 * 语义参照 packages/coding-agent/src/core/session-manager.ts:688-760 的 list 实现，轻量零依赖。
	 */
	async function readSessionSummary(filePath) {
		let fileStat;
		try {
			fileStat = await stat(filePath);
		} catch {
			return null;
		}
		const cached = sessionSummaryCache.get(filePath);
		if (cached?.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) return cached.summary;
		let lines;
		try {
			lines = await readSessionLines(filePath);
		} catch {
			return null;
		}
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
		if (!header) {
			sessionSummaryCache.set(filePath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, summary: null });
			return null;
		}
		const created = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
		const modified = lastActivity > 0 ? lastActivity : Number.isFinite(created) ? created : 0;
		const summary = {
			sessionFile: filePath,
			id: header.id,
			name: name ?? null,
			firstMessage,
			cwd: header.cwd ?? null,
			created: Number.isFinite(created) ? created : 0,
			modified,
			messageCount,
		};
		sessionSummaryCache.set(filePath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, summary });
		return summary;
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
			sessionSummaryCache.delete(target);
			return true;
		} catch {
			return false;
		}
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
		if (pathname === "/logo.svg") {
			try {
				const data = await readFile(join(WEB_DIR, "logo.svg")).catch(() => readFile(join(REPO, "logo.svg")));
				res.writeHead(200, { "content-type": MIME[".svg"] });
				res.end(data);
			} catch {
				res.writeHead(404).end("not found");
			}
			return;
		}
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

	/* ================= HTTP 服务 ================= */
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = url.pathname;

		if (path === "/api/events" && req.method === "GET") {
			// EventSource 无法携带 header → token 走查询参数（渲染进程不落地日志）
			if (!devMode && url.searchParams.get("token") !== authToken) {
				res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: "unauthorized" }));
				return;
			}
			const clientId = url.searchParams.get("clientId") ?? "";
			// P2-7：SSE 独占——同 clientId（页面重连）替换旧连接；异 clientId 且已有存活客户端 → 409
			if (clientId && sseClients.has(clientId)) {
				const old = sseClients.get(clientId);
				sseClients.delete(clientId);
				try { old.end(); } catch { /* 旧连接已死 */ }
			}
			if (clientId) {
				if (sseClients.size > 0 && !sseClients.has(clientId)) {
					res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: "another client already connected" }));
					return;
				}
			} else if (sseClients.size > 0) {
				// 无 clientId（如 curl 探测）：仅在无其他客户端时允许
				res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: "another client already connected" }));
				return;
			}
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write("retry: 1000\n\n");
			res.write(`data: ${JSON.stringify({ type: "bridge_hello", piAlive, ts: Date.now() })}\n\n`);
			sseClients.set(clientId, res);
			req.on("close", () => {
				if (sseClients.get(clientId) === res) sseClients.delete(clientId);
			});
			return;
		}

		// P0-3：其余控制端点统一鉴权（静态文件与 / 开放）
		if (path.startsWith("/api/")) {
			if (!authorized(req, res)) return;
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

		if (path === "/api/providers" && req.method === "GET") {
			getProviderConfiguration().then(
				(data) => sendJson(res, 200, { ok: true, ...data }),
				(err) => sendJson(res, 500, { ok: false, error: String(err?.message ?? err) }),
			);
			return;
		}

		if (path === "/api/providers/discover" && req.method === "POST") {
			readJsonBody(req).then(async (input) => {
				const models = await discoverModels({
					api: input.api,
					baseUrl: input.baseUrl,
					apiKey: input.apiKey,
				});
				sendJson(res, 200, { ok: true, models });
			}).catch((err) => sendJson(res, 400, { ok: false, error: String(err?.message ?? err) }));
			return;
		}

		if (path === "/api/providers" && req.method === "PUT") {
			readJsonBody(req).then(async (input) => {
				const provider = await saveCustomProvider(input);
				sendJson(res, 200, { ok: true, provider });
			}).catch((err) => sendJson(res, 400, { ok: false, error: String(err?.message ?? err) }));
			return;
		}

		if (path === "/api/providers" && req.method === "DELETE") {
			const id = url.searchParams.get("id") ?? "";
			deleteCustomProvider(id).then(
				() => sendJson(res, 200, { ok: true }),
				(err) => sendJson(res, 400, { ok: false, error: String(err?.message ?? err) }),
			);
			return;
		}

		if (path === "/api/bridge/status" && req.method === "GET") {
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ ok: true, piAlive, workspace, clients: sseClients.size }));
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
			Promise.resolve(workspace).then(async (cwd) => {
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

	return { server, port: actualPort, workspace, killPi, authToken, get piAlive() { return piAlive; } };
}

/* ================= 直接运行自启 ================= */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	startBridge().catch((err) => {
		console.error(`[bridge] fatal: ${err.message}`);
		process.exit(1);
	});
}

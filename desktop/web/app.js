/**
 * piwpi 桌面端前端逻辑
 * - 对话：POST /api/rpc 发命令，SSE /api/events 收 pi 事件流
 * - 实时 Context：/debug/* 代理到 piwpi 扩展 debug 服务（快照 + SSE）
 */

/* ================= 工具函数 ================= */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text !== undefined) node.textContent = text;
	return node;
};
const SVG = {
	chev: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 3L7.5 6L4.5 9" stroke="#A2A3A8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	file: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 1.5h5.5L11 4v8.5H3V1.5Z" stroke="#74767C" stroke-width="1.2" stroke-linejoin="round"/><path d="M8.5 1.5V4H11" stroke="#74767C" stroke-width="1.2" stroke-linejoin="round"/></svg>',
	term: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4l4 3-4 3M7 11h4" stroke="#74767C" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	edit: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M8.5 2.5l3 3L5 12H2V9l6.5-6.5Z" stroke="#74767C" stroke-width="1.2" stroke-linejoin="round"/></svg>',
	search: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6.5" cy="6.5" r="4.5" stroke="#74767C" stroke-width="1.4"/><path d="M10 10L13 13" stroke="#74767C" stroke-width="1.4" stroke-linecap="round"/></svg>',
	wrench: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2.5a3 3 0 0 0-3.8 3.8L2 9.5 4.5 12l3.2-3.2A3 3 0 0 0 11.5 5L9.7 6.8 7.2 4.3 9 2.5Z" stroke="#74767C" stroke-width="1.2" stroke-linejoin="round"/></svg>',
};
function toolIcon(name) {
	if (name === "bash" || name === "shell") return SVG.term;
	if (name === "edit" || name === "write") return SVG.edit;
	if (name === "grep" || name === "find" || name === "ls") return SVG.search;
	if (name === "read") return SVG.file;
	return SVG.wrench;
}
function toast(text, kind = "info", ms = 4000) {
	const t = el("div", `toast ${kind}`, text);
	$("#toasts").appendChild(t);
	setTimeout(() => t.remove(), ms);
}
function showBanner(text) {
	const b = $("#banner");
	if (text) { b.textContent = text; b.hidden = false; }
	else b.hidden = true;
}

/* ================= RPC 通道 ================= */
let reqSeq = 0;
const pending = new Map(); // id -> {resolve, timer}
let piConnected = false;

async function rpcRaw(cmd) {
	const res = await fetch("/api/rpc", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(cmd),
	});
	const data = await res.json();
	if (!data.ok) throw new Error(data.error || "rpc send failed");
}

/** 发送命令并等待带同 id 的 response */
function rpc(cmd, timeoutMs = 15000) {
	const id = `web-${++reqSeq}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${cmd.type} 响应超时`));
		}, timeoutMs);
		pending.set(id, { resolve, timer });
		rpcRaw({ id, ...cmd }).catch((err) => {
			clearTimeout(timer);
			pending.delete(id);
			reject(err);
		});
	});
}

/* ================= 对话状态与渲染 ================= */
const msgCol = $("#msgCol");
const chatFlow = $("#chatFlow");
let streaming = false;
let currentAssistant = null; // { root, blocks: Map<contentIndex, block>, order: [] }
const toolCards = new Map(); // toolCallId -> card refs

function nearBottom() {
	return chatFlow.scrollHeight - chatFlow.scrollTop - chatFlow.clientHeight < 120;
}
function scrollBottom(force) {
	if (force || nearBottom()) chatFlow.scrollTop = chatFlow.scrollHeight;
}
function hideEmptyHint() {
	const hint = $("#emptyHint");
	if (hint) hint.remove();
}

function addUserMsg(text, queued) {
	hideEmptyHint();
	msgCol.appendChild(el("div", "who", "User"));
	const m = el("div", "msg user", text);
	if (queued) m.appendChild(el("span", "queued-tag", "已排队，将在本轮结束后发送"));
	msgCol.appendChild(m);
	scrollBottom(true);
}

function beginAssistant() {
	hideEmptyHint();
	msgCol.appendChild(el("div", "who", "Agent"));
	const root = el("div", "assistant-msg");
	root.style.display = "flex";
	root.style.flexDirection = "column";
	root.style.gap = "12px";
	msgCol.appendChild(root);
	currentAssistant = { root, blocks: new Map() };
	scrollBottom(true);
}

function ensureAssistant() {
	if (!currentAssistant) beginAssistant();
	return currentAssistant;
}

/* --- 文本块 --- */
function blockText() {
	const node = el("div", "msg");
	return { type: "text", text: "", node };
}
/* --- 思考块 --- */
function blockThinking() {
	const wrap = el("div", "think-block streaming");
	const head = el("div", "think-head");
	head.innerHTML = `<span class="think-chev">${SVG.chev}</span>`;
	head.appendChild(el("span", null, "思考过程"));
	const body = el("div", "think-body");
	head.addEventListener("click", () => wrap.classList.toggle("open"));
	wrap.append(head, body);
	return { type: "thinking", text: "", node: wrap, body };
}
/* --- 工具卡片 --- */
function argBrief(name, args) {
	if (!args || typeof args !== "object") return "";
	const pick = (k) => (typeof args[k] === "string" ? args[k] : undefined);
	switch (name) {
		case "read": {
			const p = pick("path") ?? pick("file_path") ?? pick("filePath") ?? "";
			const off = args.offset ?? args.start_line ?? args.startLine;
			const lim = args.limit ?? args.line_count ?? args.lineCount;
			return p + (off != null ? ` · lines ${off}–${lim != null ? Number(off) + Number(lim) - 1 : "?"}` : "");
		}
		case "bash": return pick("command") ?? "";
		case "edit": case "write": return pick("path") ?? pick("file_path") ?? "";
		case "grep": return pick("pattern") ?? "";
		case "find": return pick("pattern") ?? pick("path") ?? "";
		case "ls": return pick("path") ?? "";
		default: {
			const s = JSON.stringify(args);
			return s.length > 80 ? s.slice(0, 80) + "…" : s;
		}
	}
}
function blockToolCall(id, name, args) {
	const card = el("div", "tool-card");
	if (id) card.dataset.toolId = id; // 兜底卡认领标记
	const head = el("div", "tool-head");
	const left = el("div", "tool-left");
	left.innerHTML = toolIcon(name);
	left.appendChild(el("span", "tool-name", name));
	left.appendChild(el("span", "tool-brief", argBrief(name, args)));
	const right = el("div", "tool-right");
	const status = el("span", "tool-status running", "运行中…");
	const spin = el("span", "spin");
	right.append(spin, status);
	right.insertAdjacentHTML("beforeend", `<span class="tool-chev">${SVG.chev}</span>`);
	head.append(left, right);
	const detail = el("div", "tool-detail");
	head.addEventListener("click", () => card.classList.toggle("open"));
	card.append(head, detail);
	const refs = { card, status, spin, detail, name, args };
	if (id) toolCards.set(id, refs);
	return { type: "toolcall", id, name, args, argsText: "", node: card, refs };
}

/** 认领既有卡片（兜底卡 / 防御重复建卡）：就地更新 name/brief */
function claimToolCard(refs, name, args) {
	refs.name = name;
	refs.args = args;
	const card = refs.card;
	card.dataset.toolId = card.dataset.toolId ?? "";
	card.querySelector(".tool-name").textContent = name;
	card.querySelector(".tool-brief").textContent = argBrief(name, args);
}

function toolResultText(result) {
	if (!result) return "";
	const parts = [];
	for (const c of result.content ?? []) {
		if (c.type === "text" && c.text) parts.push(c.text);
	}
	return parts.join("\n");
}

function fillToolDetail(refs, args, resultText, isError) {
	refs.detail.innerHTML = "";
	if (args !== undefined) {
		refs.detail.appendChild(el("div", "sec-label", "参数"));
		refs.detail.appendChild(el("pre", null, typeof args === "string" ? args : JSON.stringify(args, null, 2)));
	}
	if (resultText) {
		refs.detail.appendChild(el("div", "sec-label", isError ? "错误输出" : "结果"));
		const trimmed = resultText.length > 4000 ? resultText.slice(0, 4000) + `\n…（共 ${resultText.length} 字符，已截断）` : resultText;
		refs.detail.appendChild(el("pre", null, trimmed));
	}
}

function setToolStatus(refs, state) {
	if (state === "done") {
		refs.status.textContent = "完成";
		refs.status.className = "tool-status done";
		refs.spin.remove();
	} else if (state === "error") {
		refs.status.textContent = "失败";
		refs.status.className = "tool-status error";
		refs.spin.remove();
	}
}

/* --- 运行指示 --- */
let runRow = null;
function showRunning(text) {
	hideRunning();
	hideEmptyHint();
	runRow = el("div", "run-row");
	runRow.innerHTML = '<div class="run-dot"></div>';
	runRow.appendChild(el("span", "run-text", text));
	msgCol.appendChild(runRow);
	scrollBottom();
}
function hideRunning() {
	if (runRow) { runRow.remove(); runRow = null; }
}

function setStreaming(on) {
	streaming = on;
	$("#btnAbort").hidden = !on;
	if (!on) hideRunning();
}

/* ================= pi 事件分发 ================= */
function dispatch(evt) {
	switch (evt.type) {
		case "response": {
			if (evt.id && pending.has(evt.id)) {
				const p = pending.get(evt.id);
				pending.delete(evt.id);
				clearTimeout(p.timer);
				p.resolve(evt);
			}
			if (evt.success === false && evt.command === "prompt") {
				toast(`消息被拒绝：${evt.error ?? "未知原因"}`, "error");
			}
			return;
		}
		case "agent_start":
			setStreaming(true);
			showRunning("正在思考…");
			return;
		case "turn_start":
			if (streaming) showRunning("正在执行…");
			return;
		case "agent_settled":
			setStreaming(false);
			currentAssistant = null;
			return;
		case "agent_end":
			if (!evt.willRetry) { /* 等 agent_settled 收尾 */ }
			return;
		case "message_start":
			if (evt.message?.role === "assistant") beginAssistant();
			return;
		case "message_update":
			handleAssistantDelta(evt.assistantMessageEvent);
			return;
		case "message_end":
			if (currentAssistant) {
				for (const b of currentAssistant.blocks.values()) {
					if (b.type === "thinking") b.node.classList.remove("streaming");
				}
			}
			return;
		case "tool_execution_start": {
			hideRunning();
			let refs = toolCards.get(evt.toolCallId);
			if (!refs) {
				// toolcall_end 已错过（重连/中途加载）：建兜底卡，data-tool-id 供后续认领
				const a = ensureAssistant();
				const blk = blockToolCall(evt.toolCallId, evt.toolName, evt.args);
				a.blocks.set(`exec-${evt.toolCallId}`, blk);
				a.root.appendChild(blk.node);
				refs = blk.refs;
			}
			refs.status.textContent = "运行中…";
			scrollBottom();
			return;
		}
		case "tool_execution_update": {
			const refs = toolCards.get(evt.toolCallId);
			if (refs) {
				const partial = toolResultText(evt.partialResult);
				if (partial) {
					refs.status.textContent = `运行中… ${partial.length} 字符`;
				}
			}
			return;
		}
		case "tool_execution_end": {
			const refs = toolCards.get(evt.toolCallId);
			if (refs) {
				setToolStatus(refs, evt.isError ? "error" : "done");
				fillToolDetail(refs, refs.args, toolResultText(evt.result), evt.isError);
			}
			if (streaming) showRunning("执行完成，继续处理…");
			return;
		}
		case "auto_retry_start":
			toast(`请求失败，自动重试中（${evt.attempt}/${evt.maxAttempts}）…`, "warn");
			return;
		case "auto_retry_end":
			if (!evt.success) toast(`重试失败：${evt.finalError ?? ""}`, "error", 8000);
			return;
		case "compaction_start":
			toast("上下文压缩中…");
			return;
		case "compaction_end":
			if (evt.result) toast(`上下文已压缩：${evt.result.tokensBefore} → 约 ${evt.result.estimatedTokensAfter} tokens`);
			return;
		case "extension_ui_request":
			handleExtensionUI(evt);
			return;
		case "extension_error":
			toast(`扩展错误（${evt.event}）：${evt.error}`, "error", 8000);
			return;
		case "bridge_pi_exit":
			setPiStatus(false);
			showBanner(`pi 进程已退出（code=${evt.code}）。请重启 bridge。`);
			return;
		case "bridge_hello":
			setPiStatus(evt.piAlive);
			return;
		default:
			return;
	}
}

function handleAssistantDelta(d) {
	if (!d) return;
	const a = ensureAssistant();
	const key = d.contentIndex;
	if (d.type === "text_start") {
		const blk = blockText();
		a.blocks.set(key, blk);
		a.root.appendChild(blk.node);
	} else if (d.type === "text_delta") {
		hideRunning();
		let blk = a.blocks.get(key);
		if (!blk) { blk = blockText(); a.blocks.set(key, blk); a.root.appendChild(blk.node); }
		blk.text += d.delta ?? "";
		blk.node.textContent = blk.text;
		scrollBottom();
	} else if (d.type === "thinking_start") {
		const blk = blockThinking();
		a.blocks.set(key, blk);
		a.root.appendChild(blk.node);
	} else if (d.type === "thinking_delta") {
		hideRunning();
		let blk = a.blocks.get(key);
		if (!blk) { blk = blockThinking(); a.blocks.set(key, blk); a.root.appendChild(blk.node); }
		blk.text += d.delta ?? "";
		blk.body.textContent = blk.text;
		scrollBottom();
	} else if (d.type === "thinking_end") {
		const blk = a.blocks.get(key);
		if (blk?.type === "thinking") blk.node.classList.remove("streaming");
	} else if (d.type === "toolcall_start") {
		const blk = blockToolCall(null, "…", {});
		a.blocks.set(key, blk);
		a.root.appendChild(blk.node);
	} else if (d.type === "toolcall_delta") {
		const blk = a.blocks.get(key);
		if (blk?.type === "toolcall") {
			blk.argsText += d.delta ?? "";
			// 占位卡实时展示分段参数
			if (!blk.id) {
				blk.node.querySelector(".tool-brief").textContent = blk.argsText.slice(0, 60);
			}
		}
	} else if (d.type === "toolcall_end") {
		const tc = d.toolCall;
		if (!tc) return;
		hideRunning();
		const old = a.blocks.get(key);
		// 先认领既有卡片（兜底卡 / 防御重复建卡），避免同一 toolCallId 出现两张卡
		const existing = toolCards.get(tc.id);
		if (existing) {
			claimToolCard(existing, tc.name, tc.arguments);
			if (old && old.node !== existing.card && old.node.parentNode) old.node.remove();
			a.blocks.set(key, { type: "toolcall", id: tc.id, name: tc.name, args: tc.arguments, argsText: "", node: existing.card, refs: existing });
			scrollBottom();
			return;
		}
		// 正常路径：用完整 toolCall 替换占位卡
		const blk = blockToolCall(tc.id, tc.name, tc.arguments);
		if (old && old.node.parentNode) old.node.replaceWith(blk.node);
		else a.root.appendChild(blk.node);
		a.blocks.set(key, blk);
		scrollBottom();
	}
}

/* --- 扩展 UI 子协议：弹窗类自动取消（阶段一策略），通知类 toast --- */
function handleExtensionUI(evt) {
	const dialog = ["select", "confirm", "input", "editor"];
	if (dialog.includes(evt.method)) {
		toast(`扩展请求「${evt.title ?? evt.method}」已自动取消（阶段一）`, "warn", 6000);
		rpcRaw({ type: "extension_ui_response", id: evt.id, cancelled: true }).catch(() => {});
	} else if (evt.method === "notify") {
		toast(evt.message ?? "扩展通知", evt.notifyType === "error" ? "error" : evt.notifyType === "warning" ? "warn" : "info");
	}
}

/* ================= SSE 连接 ================= */
// 首条 rpc 必须在 EventSource OPEN 之后发，否则响应广播给 0 个客户端会超时
let esOpenResolve = null;
const esOpened = new Promise((r) => { esOpenResolve = r; });

function connectEvents() {
	const es = new EventSource("/api/events");
	es.onopen = () => {
		esOpenResolve?.();
		esOpenResolve = null;
		showBanner(null);
	};
	es.onmessage = (e) => {
		try { dispatch(JSON.parse(e.data)); } catch (err) { console.error("bad event", err); }
	};
	es.onerror = () => {
		setPiStatus(false);
		showBanner("与 bridge 的连接断开，正在重连…");
	};
}

function setPiStatus(alive) {
	piConnected = alive;
	const dot = $("#piDot");
	dot.className = `status-dot ${alive ? "on" : "off"}`;
	$("#piStatus").textContent = alive ? "pi 已连接" : "pi 未连接";
}

/* ================= 会话初始化 ================= */
async function initSession() {
	try {
		// 等 SSE 打开后再发 rpc，避免响应丢失导致超时
		await esOpened;
		// 首次 initSession 时 pi 还在加载扩展（jiti TS），get_state/get_messages 可能需要 30s+
		const [stateRes, levelsRes] = await Promise.all([
			rpc({ type: "get_state" }, 90000),
			rpc({ type: "get_available_thinking_levels" }, 90000),
		]);
		if (stateRes.success) {
			const d = stateRes.data;
			$("#modelName").textContent = d.model ? `${d.model.name ?? d.model.id}` : "未选择模型";
			document.title = `piwpi · ${d.model?.id ?? ""}`;
			setupThinkingPicker(levelsRes.success ? levelsRes.data.levels : ["off"], d.thinkingLevel);
			setStreaming(!!d.isStreaming);
		}
		// 恢复历史消息（刷新页面后）
		const msgsRes = await rpc({ type: "get_messages" }, 60000);
		if (msgsRes.success && msgsRes.data.messages.length > 0) {
			rebuildHistory(msgsRes.data.messages);
		}
	} catch (err) {
		console.error(err);
		toast(`初始化失败：${err.message}`, "error", 8000);
	}
}

function setupThinkingPicker(levels, current) {
	const sel = $("#thinkingSel");
	sel.innerHTML = "";
	for (const lv of levels) {
		const opt = el("option", null, lv);
		opt.value = lv;
		sel.appendChild(opt);
	}
	if (current && levels.includes(current)) sel.value = current;
	sel.disabled = levels.length <= 1;
	sel.onchange = async () => {
		try {
			const res = await rpc({ type: "set_thinking_level", level: sel.value });
			if (res.success) toast(`思考强度已切换为 ${sel.value}`);
			else toast(`切换失败：${res.error}`, "error");
		} catch (err) {
			toast(`切换失败：${err.message}`, "error");
		}
	};
}

/** 从历史消息重建对话（role: user / assistant / toolResult / bashExecution） */
function rebuildHistory(messages) {
	toolCards.clear();
	for (const m of messages) {
		if (m.role === "user") {
			const texts = [];
			if (typeof m.content === "string") {
				texts.push(m.content);
			} else {
				for (const c of m.content ?? []) {
					if (c.type === "text" && c.text) texts.push(c.text);
					else if (c.type === "image") texts.push(`[图片: ${c.fileName ?? c.mimeType ?? "附件"}]`);
				}
			}
			// user 消息顶层 attachments（图片等）
			for (const att of m.attachments ?? []) {
				texts.push(`[图片: ${att.fileName ?? att.type ?? "附件"}]`);
			}
			if (texts.some((t) => t.trim())) addUserMsg(texts.join("\n"), false);
		} else if (m.role === "assistant") {
			beginAssistant();
			const a = currentAssistant;
			(m.content ?? []).forEach((c, i) => {
				if (c.type === "text") {
					const blk = blockText();
					blk.text = c.text ?? "";
					blk.node.textContent = blk.text;
					a.blocks.set(i, blk);
					a.root.appendChild(blk.node);
				} else if (c.type === "thinking") {
					const blk = blockThinking();
					blk.node.classList.remove("streaming");
					blk.text = c.thinking ?? "";
					blk.body.textContent = blk.text;
					a.blocks.set(i, blk);
					a.root.appendChild(blk.node);
				} else if (c.type === "toolCall") {
					const blk = blockToolCall(c.id, c.name, c.arguments);
					a.blocks.set(i, blk);
					a.root.appendChild(blk.node);
				}
			});
			// 失败/中断消息打状态标识，避免"空气泡"
			if (m.stopReason === "error") {
				a.root.appendChild(el("div", "run-text", "⚠ 该轮以错误结束（stopReason: error，可能是模型鉴权或 API 异常）"));
			} else if (m.stopReason === "aborted") {
				a.root.appendChild(el("div", "run-text", "已中断"));
			}
			currentAssistant = null;
		} else if (m.role === "toolResult") {
			const refs = toolCards.get(m.toolCallId);
			if (refs) {
				setToolStatus(refs, m.isError ? "error" : "done");
				fillToolDetail(refs, refs.args, toolResultText(m), m.isError);
			}
		} else if (m.role === "bashExecution") {
			// RPC bash 命令产生的消息：渲染为已完成 bash 工具卡
			beginAssistant();
			const a = currentAssistant;
			const blk = blockToolCall(null, "bash", { command: m.command ?? "" });
			a.root.appendChild(blk.node);
			const refs = blk.refs;
			setToolStatus(refs, m.exitCode === 0 ? "done" : "error");
			fillToolDetail(refs, { command: m.command ?? "" }, m.output ?? "", m.exitCode !== 0);
			currentAssistant = null;
		}
	}
	scrollBottom(true);
}

/* ================= 发送 / 中断 / 新建 ================= */
async function sendMessage() {
	const box = $("#inputBox");
	const text = box.value.trim();
	if (!text) return;
	box.value = "";
	autoGrow(box);
	const cmd = streaming
		? { type: "prompt", message: text, streamingBehavior: "followUp" }
		: { type: "prompt", message: text };
	addUserMsg(text, streaming);
	try {
		await rpcRaw(cmd);
	} catch (err) {
		toast(`发送失败：${err.message}`, "error");
	}
}

function autoGrow(box) {
	box.style.height = "auto";
	box.style.height = Math.min(box.scrollHeight, 160) + "px";
}

function setupInput() {
	const box = $("#inputBox");
	box.addEventListener("input", () => autoGrow(box));
	box.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			sendMessage();
		}
	});
	$("#btnSend").addEventListener("click", sendMessage);
	$("#btnAbort").addEventListener("click", () => rpcRaw({ type: "abort" }).catch(() => {}));
	$("#btnNewChat").addEventListener("click", async () => {
		try {
			const res = await rpc({ type: "new_session" });
			if (res.success && !res.data?.cancelled) {
				msgCol.innerHTML = "";
				toolCards.clear();
				currentAssistant = null;
				setStreaming(false);
				const hint = el("div", "empty-hint");
				hint.id = "emptyHint";
				hint.innerHTML = '<div class="empty-title">开始一段对话</div><div class="empty-sub">piwpi 会把工具读取的文件挂载进上下文，右侧 Context 可实时查看。</div>';
				msgCol.appendChild(hint);
				$("#sessionTitle").textContent = "piwpi / 新对话";
				toast("已开始新对话");
			}
		} catch (err) {
			toast(`新建对话失败：${err.message}`, "error");
		}
	});
}

/* ================= Context 抽屉（debug API） ================= */
const drawer = $("#drawer");
let debugEvents = null;
let refreshTimer = null;

function setupDrawer() {
	$("#btnContext").addEventListener("click", () => {
		drawer.hidden = !drawer.hidden;
		if (!drawer.hidden) refreshDebugState();
	});
	$("#btnCloseDrawer").addEventListener("click", () => (drawer.hidden = true));
	connectDebugEvents();
	refreshDebugState(); // 页面加载即拉一次，更新徽标
}

function connectDebugEvents() {
	debugEvents = new EventSource("/debug/events");
	debugEvents.addEventListener("piwpi", (e) => {
		let evt;
		try { evt = JSON.parse(e.data); } catch { return; }
		logDebugEvent(evt);
		// 去抖刷新快照
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(refreshDebugState, 400);
	});
	debugEvents.onerror = () => {
		$("#ctxMeta").textContent = "debug 服务未连接（扩展未启动？）";
	};
}

function logDebugEvent(evt) {
	const list = $("#eventList");
	const item = el("div", "event-item");
	const time = new Date(evt.ts ?? Date.now()).toLocaleTimeString("zh-CN", { hour12: false });
	const type = el("span", "ev-type", evt.type);
	item.append(`${time} `, type);
	if (evt.pluginId) item.append(` ${shortenPluginId(evt.pluginId)}`);
	if (evt.kind) item.append(` (${evt.kind})`);
	list.prepend(item);
	while (list.children.length > 30) list.lastChild.remove();
}

function shortenPluginId(id) {
	// "source:file:c:\proj\src\auth.ts" → "auth.ts"
	const parts = String(id).split(/[\\/]/);
	return parts[parts.length - 1] || id;
}

async function refreshDebugState() {
	try {
		const res = await fetch("/debug/state");
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const state = await res.json();
		renderPlugins(state.plugins ?? []);
		renderContext(state.context);
	} catch {
		$("#ctxBadge").textContent = "!";
	}
}

function renderPlugins(plugins) {
	$("#ctxBadge").textContent = String(plugins.length);
	$("#fileCount").textContent = String(plugins.length);
	const list = $("#fileList");
	list.innerHTML = "";
	if (plugins.length === 0) {
		list.appendChild(el("div", "drawer-empty", "暂无挂载（agent 读取文件后会出现在这里）"));
		return;
	}
	for (const p of plugins) {
		const meta = p.metadata ?? {};
		const identity = p.source?.identity ?? p.id;
		const card = el("div", "ctx-file");
		card.appendChild(el("div", "f-path", shortenPluginId(identity)));
		const ranges = (meta.segments ?? []).map((s) => `L${s.start}–${s.end}`).join(" · ");
		if (ranges) card.appendChild(el("div", "f-ranges", ranges + (meta.totalLines ? ` / 共 ${meta.totalLines} 行` : "")));
		const metaRow = el("div", "f-meta");
		if (meta.hash) {
			const chip = el("span", "hash-chip", `#${String(meta.hash).slice(0, 8)}`);
			metaRow.appendChild(chip);
		}
		if (meta.anchorToolCallId) metaRow.appendChild(el("span", null, `锚点 ${meta.anchorToolCallId}`));
		if (meta.truncatedNote) metaRow.appendChild(el("span", null, "⚠ 已截段"));
		if (p.category) metaRow.appendChild(el("span", null, p.category));
		card.appendChild(metaRow);
		if (p.memory?.summary) card.appendChild(el("div", "f-mem", p.memory.summary));
		const fullPath = meta.absPath ?? identity;
		card.title = fullPath;
		card.addEventListener("click", () => showPluginDetail(p.id));
		list.appendChild(card);
	}
}

async function showPluginDetail(id) {
	try {
		const res = await fetch(`/debug/plugins/${encodeURIComponent(id)}`);
		if (!res.ok) return;
		const p = await res.json();
		const segs = (p.metadata?.segments ?? []).map((s) => `--- L${s.start}-${s.end} ---\n${s.text}`).join("\n\n");
		const text = segs || p.content || "（无内容）";
		// 简单弹层展示已挂载文本
		const overlay = el("div");
		overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:80;display:flex;align-items:center;justify-content:center;";
		const panel = el("div");
		panel.style.cssText = "width:720px;max-width:90vw;max-height:80vh;background:#fff;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;";
		const head = el("div");
		head.style.cssText = "padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-size:14px;font-weight:600;";
		head.appendChild(el("span", null, shortenPluginId(id)));
		const close = el("button", "icon-btn");
		close.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="#74767C" stroke-width="1.5" stroke-linecap="round"/></svg>';
		close.onclick = () => overlay.remove();
		head.appendChild(close);
		const body = el("pre");
		body.style.cssText = "flex:1;overflow:auto;padding:14px 18px;font-size:12px;line-height:18px;font-family:Consolas,monospace;white-space:pre-wrap;word-break:break-all;";
		body.textContent = text;
		panel.append(head, body);
		overlay.appendChild(panel);
		overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
		document.body.appendChild(overlay);
	} catch { /* ignore */ }
}

function renderContext(ctx) {
	const list = $("#ctxList");
	list.innerHTML = "";
	if (!ctx) {
		$("#msgCount").textContent = "0";
		$("#ctxMeta").textContent = "等待第一次 LLM 请求…";
		return;
	}
	$("#msgCount").textContent = String(ctx.messageCount ?? 0);
	$("#ctxMeta").textContent = `最近刷新 ${new Date(ctx.ts).toLocaleTimeString("zh-CN", { hour12: false })} · ${ctx.messageCount} 条消息 · ${ctx.toolResultCount} 条工具结果`;
	for (const m of ctx.messages ?? []) {
		const item = el("div", `ctx-msg role-${m.role}`);
		const roleText = m.role === "toolResult" ? `toolResult ${m.toolCallId ?? ""}` : m.role;
		item.appendChild(el("div", "m-role", roleText));
		item.appendChild(el("div", "m-text", m.text ?? (m.hasImage ? "[图片]" : "")));
		list.appendChild(item);
	}
}

/* ================= 启动 ================= */
connectEvents();
setupInput();
setupDrawer();
initSession();

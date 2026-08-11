/**
 * piwpi 桌面端前端逻辑
 * - 对话：POST /api/rpc 发命令，SSE /api/events 收 pi 事件流
 * - 上下文占用：通过 /debug/* 获取快照，随会话事件主动刷新
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
	folder: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h4l1.2 1.4h5.8v6.6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-8Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><path d="M2.5 6h11" stroke="currentColor" stroke-width="1.35"/></svg>',
	plan: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 2.5h8v11H4v-11Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M6.25 5.5h3.5M6.25 8h3.5M6.25 10.5h2.25" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
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

/* ================= Markdown 渲染 ================= */
// 两库经 index.html 的 <script> 以 UMD 全局加载（离线可用、零构建）
const md = window.markdownit
	? new window.markdownit({ html: false, linkify: true, breaks: true })
	: null;
function sourcePathFromHref(href) {
	const value = decodeURIComponent(String(href).trim());
	if (!/^(?:[a-zA-Z]:[\\/]|\/(?!\/))/.test(value)) return null;
	return value.replace(/:\d+(?::\d+)?$/, "");
}
// 安全：只允许 http(s)/mailto 与绝对本地源文件链接，封死 javascript: 等可执行协议
if (md) md.validateLink = (url) => /^(https?:|mailto:)/i.test(String(url).trim()) || sourcePathFromHref(url) !== null;
const hljs = window.hljs;
if (hljs) hljs.configure({ ignoreUnescapedHTML: true });

/** 块渲染目标：文本块 → node，思考块 → body */
function mdTarget(blk) { return blk.type === "thinking" ? blk.body : blk.node; }

/** 同步渲染一整个块；highlight 时对 pre code 做高亮（仅收尾阶段开） */
function mdRender(blk, { highlight = false } = {}) {
	const node = mdTarget(blk);
	if (!node || !node.isConnected) return; // 兜底：块已被替换/移除
	if (!md) { node.textContent = blk.text; return; } // 兜底：库缺失退回纯文本
	node.innerHTML = md.render(blk.text);
	sanitizeLinks(node);
	if (highlight) highlightCode(node);
}

/** 链接净化兜底：本地绝对路径标为源文件引用，其余仅保留 http(s)/mailto。 */
function sanitizeLinks(root) {
	for (const a of root.querySelectorAll("a[href]")) {
		const href = a.getAttribute("href") ?? "";
		const sourcePath = sourcePathFromHref(href);
		if (sourcePath) {
			a.classList.add("source-ref");
			a.dataset.sourcePath = sourcePath;
			a.title = sourcePath;
		} else if (!/^(https?:|mailto:)/i.test(href)) {
			a.removeAttribute("href");
		}
	}
}

/** 对节点内 pre code 逐个高亮（markdown-it 产出 language-* 类，hljs 按类取语言） */
function highlightCode(root) {
	if (!hljs) return;
	for (const codeEl of root.querySelectorAll("pre code")) hljs.highlightElement(codeEl);
}

/* 流式 rAF 节流：按块去重，每帧最多全量重渲染一次 */
const dirtyMd = new Set();
let mdRaf = 0;
function scheduleMd(blk) {
	dirtyMd.add(blk);
	if (!mdRaf) mdRaf = requestAnimationFrame(flushMd);
}
function flushMd() {
	mdRaf = 0;
	const list = [...dirtyMd];
	dirtyMd.clear();
	for (const blk of list) mdRender(blk); // 流式中不做高亮，message_end 统一收尾
	scrollBottom();
}
/** 收尾：取消挂起 rAF，把剩余脏块做最终渲染 + 高亮（message_end / agent_settled 用） */
function finalizeMd(a) {
	if (mdRaf) { cancelAnimationFrame(mdRaf); mdRaf = 0; }
	const list = [...dirtyMd];
	dirtyMd.clear();
	for (const blk of list) mdRender(blk, { highlight: true });
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
let collaborationMode = "default";
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
	msgCol.appendChild(el("div", "who", "用户"));
	const m = el("div", "msg user", text);
	if (queued) m.appendChild(el("span", "queued-tag", "已排队，将在本轮结束后发送"));
	msgCol.appendChild(m);
	scrollBottom(true);
}

function beginAssistant() {
	hideEmptyHint();
	msgCol.appendChild(el("div", "who", "助手"));
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
	const node = el("div", "msg md-body");
	return { type: "text", text: "", node };
}
/* --- 思考块 --- */
function blockThinking() {
	const wrap = el("div", "think-block streaming");
	const head = el("div", "think-head");
	head.innerHTML = `<span class="think-chev">${SVG.chev}</span>`;
	head.appendChild(el("span", null, "思考过程"));
	const body = el("div", "think-body md-body");
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
	updateActionBtn();
}

function updateActionBtn() {
	const on = streaming;
	const btn = $("#btnAction");
	btn.classList.toggle("streaming", on);
	btn.title = on ? "中断" : "发送";
	$("#modeSel").disabled = on;
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
			if (currentAssistant) finalizeMd(currentAssistant); // 兜底：没收齐 message_end 时仍完成收尾
			currentAssistant = null;
			scheduleContextUsageRefresh(); // 一轮结束，上下文定稿
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
				finalizeMd(currentAssistant); // 最终渲染 + 高亮
				// 兜底：异常/中断消息补状态行（与 rebuildHistory 一致）
				if (evt.stopReason === "error") {
					currentAssistant.root.appendChild(el("div", "run-text", "⚠ 该轮以错误结束（stopReason: error，可能是模型鉴权或 API 异常）"));
				} else if (evt.stopReason === "aborted") {
					currentAssistant.root.appendChild(el("div", "run-text", "已中断"));
				}
				let hasInteractivePlan = false;
				for (const blk of currentAssistant.blocks.values()) {
					if (blk.type !== "text") continue;
					const planCard = renderPlanArtifact(blk);
					if (planCard && collaborationMode === "plan" && !hasInteractivePlan) {
						appendPlanActions(planCard);
						hasInteractivePlan = true;
					}
				}
			}
			scheduleContextUsageRefresh(); // assistant 消息提交
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
			scheduleContextUsageRefresh(); // toolResult 已入上下文
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
			if (evt.result) toast(`上下文已压缩：${evt.result.tokensBefore} → 约 ${evt.result.estimatedTokensAfter}`);
			scheduleContextUsageRefresh(); // 压缩后上下文骤变
			return;
		case "extension_ui_request":
			handleExtensionUI(evt);
			return;
		case "collaboration_mode_changed":
			setModePicker(evt.mode);
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
			refreshProjectInfo();
			refreshSessions();
			return;
		case "session_start":
			// 启动 / resume / 切换会话都会触发：更新当前会话高亮 + 刷新会话树
			rpc({ type: "get_state" }, 30000)
				.then((r) => {
					if (r.success) {
						if (typeof r.data?.sessionFile === "string") currentSessionFile = r.data.sessionFile;
						if (typeof r.data?.collaborationMode === "string") setModePicker(r.data.collaborationMode);
						refreshSessions();
					}
				})
				.catch(() => {});
			refreshSessions();
			scheduleContextUsageRefresh(); // 新会话/切换会话，重置占用
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
		scheduleMd(blk); // rAF 节流渲染，每帧最多一次全量解析
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
		scheduleMd(blk); // rAF 节流渲染，每帧最多一次全量解析
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

/* --- 扩展 UI 子协议 --- */
function handleExtensionUI(evt) {
	if (evt.method === "notify") {
		toast(evt.message ?? "扩展通知", evt.notifyType === "error" ? "error" : evt.notifyType === "warning" ? "warn" : "info");
		return;
	}
	if (!["select", "confirm", "input", "editor"].includes(evt.method)) return;

	const overlay = el("div", "dialog-overlay");
	const panel = el("div", "dialog-panel");
	const title = el("div", "dialog-title", evt.title ?? evt.method);
	panel.appendChild(title);
	let completed = false;
	const finish = (response) => {
		if (completed) return;
		completed = true;
		document.removeEventListener("keydown", onKeyDown);
		overlay.remove();
		rpcRaw({ type: "extension_ui_response", id: evt.id, ...response }).catch((err) => {
			toast(`提交扩展交互失败：${err.message}`, "error");
		});
	};
	const cancel = () => finish({ cancelled: true });
	const onKeyDown = (event) => {
		if (event.key === "Escape") cancel();
	};

	if (evt.method === "select") {
		const options = el("div", "dialog-options");
		for (const value of evt.options ?? []) {
			const option = el("button", "dialog-option", value);
			option.type = "button";
			option.onclick = () => finish({ value });
			options.appendChild(option);
		}
		panel.appendChild(options);
	} else if (evt.method === "confirm") {
		if (evt.message) panel.appendChild(el("div", "dialog-title", evt.message));
		const foot = el("div", "dialog-foot");
		const no = el("button", "plan-action", "否");
		const yes = el("button", "plan-action primary", "是");
		no.type = "button";
		yes.type = "button";
		no.onclick = () => finish({ confirmed: false });
		yes.onclick = () => finish({ confirmed: true });
		foot.append(no, yes);
		panel.appendChild(foot);
	} else {
		const input = evt.method === "editor" ? el("textarea", "dialog-input") : el("input", "dialog-input");
		input.placeholder = evt.placeholder ?? "";
		input.value = evt.prefill ?? "";
		const foot = el("div", "dialog-foot");
		const cancelButton = el("button", "plan-action", "取消");
		const submitButton = el("button", "plan-action primary", "提交");
		cancelButton.type = "button";
		submitButton.type = "button";
		cancelButton.onclick = cancel;
		submitButton.onclick = () => finish({ value: input.value });
		if (evt.method === "input") {
			input.addEventListener("keydown", (event) => {
				if (event.key === "Enter" && !event.isComposing) {
					event.preventDefault();
					finish({ value: input.value });
				}
			});
		}
		foot.append(cancelButton, submitButton);
		panel.append(input, foot);
		setTimeout(() => input.focus(), 0);
	}

	overlay.appendChild(panel);
	overlay.addEventListener("click", (event) => { if (event.target === overlay) cancel(); });
	document.addEventListener("keydown", onKeyDown);
	document.body.appendChild(overlay);
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
		// 恢复上次选择的项目（localStorage；switch_project 为运行中切换，pi 不重启）
		const saved = localStorage.getItem("piwpi.project");
		if (saved) {
			const st = await (await fetch("/api/bridge/status")).json();
			if (st.workspace && normPath(st.workspace) !== normPath(saved)) {
				await rpc({ type: "switch_project", path: saved }, 30000);
			}
		}
		await refreshProjectInfo();
		// 首次 initSession 时 pi 还在加载扩展（jiti TS），get_state/get_messages 可能需要 30s+
		const [stateRes, levelsRes] = await Promise.all([
			rpc({ type: "get_state" }, 90000),
			rpc({ type: "get_available_thinking_levels" }, 90000),
		]);
		if (stateRes.success) {
			const d = stateRes.data;
			$("#modelName").textContent = d.model ? `${d.model.name ?? d.model.id}` : "未选择模型";
			document.title = `piwpi · ${d.model?.id ?? ""}`;
			if (typeof d.sessionFile === "string") currentSessionFile = d.sessionFile;
			setupModePicker(d.collaborationMode ?? "default");
			setupThinkingPicker(levelsRes.success ? levelsRes.data.levels : ["off"], d.thinkingLevel);
			setStreaming(!!d.isStreaming);
		}
		// 恢复历史消息（刷新页面后）
		await rebuildFromMessages();
		refreshSessions();
		refreshDebugState();
		refreshContextUsage();
	} catch (err) {
		console.error(err);
		toast(`初始化失败：${err.message}`, "error", 8000);
	}
}

/** get_messages → rebuildHistory（会话切换/页面刷新共用） */
async function rebuildFromMessages() {
	try {
		const msgsRes = await rpc({ type: "get_messages" }, 60000);
		if (msgsRes.success && msgsRes.data.messages.length > 0) {
			rebuildHistory(msgsRes.data.messages);
		}
	} catch { /* ignore */ }
}

/** 清空对话视图并恢复空态（新建会话/项目切换后用） */
function resetChatView() {
	msgCol.innerHTML = "";
	toolCards.clear();
	currentAssistant = null;
	setStreaming(false);
	const hint = el("div", "empty-hint");
	hint.id = "emptyHint";
	hint.innerHTML = '<div class="empty-title">开始一段对话</div><div class="empty-sub">piwpi 会把工具读取的文件挂载进上下文，右侧上下文可实时查看。</div>';
	msgCol.appendChild(hint);
}

function thinkingLevelLabel(level) {
	return ({ off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" })[level] ?? "自定义";
}

function setupThinkingPicker(levels, current) {
	const sel = $("#thinkingSel");
	sel.innerHTML = "";
	for (const lv of levels) {
		const opt = el("option", null, thinkingLevelLabel(lv));
		opt.value = lv;
		sel.appendChild(opt);
	}
	if (current && levels.includes(current)) sel.value = current;
	sel.disabled = levels.length <= 1;
	sel.onchange = async () => {
		try {
			const res = await rpc({ type: "set_thinking_level", level: sel.value });
			if (res.success) toast(`思考强度已切换为${thinkingLevelLabel(sel.value)}`);
			else toast(`切换失败：${res.error}`, "error");
		} catch (err) {
			toast(`切换失败：${err.message}`, "error");
		}
	};
}

function setModePicker(mode) {
	collaborationMode = mode === "plan" ? "plan" : "default";
	const sel = $("#modeSel");
	sel.value = collaborationMode;
	sel.closest(".mode-picker")?.classList.toggle("plan", collaborationMode === "plan");
}

function setupModePicker(current) {
	const sel = $("#modeSel");
	setModePicker(current);
	sel.onchange = async () => {
		const previous = collaborationMode;
		const next = sel.value;
		sel.disabled = true;
		try {
			const res = await rpc({ type: "set_collaboration_mode", mode: next });
			if (!res.success) throw new Error(res.error ?? "未知原因");
			setModePicker(next);
			toast(next === "plan" ? "已进入计划模式" : "已切换为默认模式");
		} catch (err) {
			setModePicker(previous);
			toast(`模式切换失败：${err.message}`, "error");
		} finally {
			sel.disabled = streaming;
		}
	};
}

function splitProposedPlan(text) {
	const matches = [...text.matchAll(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/g)];
	if (matches.length !== 1) return null;
	const match = matches[0];
	return {
		before: text.slice(0, match.index).trim(),
		plan: match[1].trim(),
		after: text.slice((match.index ?? 0) + match[0].length).trim(),
	};
}

function appendPlanActions(root) {
	if (root.querySelector(".plan-actions")) return;
	const actions = el("div", "plan-actions");
	actions.appendChild(el("div", "plan-actions-title", "计划已完成，下一步怎么做？"));
	const buttons = el("div", "plan-actions-buttons");
	const compact = el("button", "plan-action primary", "压缩对话并开始实现");
	const direct = el("button", "plan-action", "直接开始实现");
	const refine = el("button", "plan-action", "继续完善计划");
	for (const button of [compact, direct, refine]) button.type = "button";
	const implement = async (strategy) => {
		for (const button of [compact, direct, refine]) button.disabled = true;
		try {
			// 计划实施走 pi 侧 implement_plan RPC：compact 策略内部压缩；成功后 pi 自动进入实施
			const res = await rpc({ type: "implement_plan", strategy }, 240000);
			if (!res.success) throw new Error(res.error ?? "未知原因");
			const badge = root.querySelector(".plan-card-badge");
			if (badge) {
				badge.textContent = "已批准";
				badge.classList.add("approved");
			}
			actions.remove();
		} catch (err) {
			for (const button of [compact, direct, refine]) button.disabled = false;
			toast(`开始实现失败：${err.message}`, "error", 8000);
		}
	};
	compact.onclick = () => implement("compact");
	direct.onclick = () => implement("direct");
	refine.onclick = () => actions.remove();
	buttons.append(compact, direct, refine);
	actions.appendChild(buttons);
	root.appendChild(actions);
}

/** 把 assistant 文本中的唯一 proposed_plan 控制块提升为独立的计划文档 artifact。 */
function renderPlanArtifact(blk) {
	const parts = splitProposedPlan(blk.text);
	if (!parts) return null;

	const wrap = el("div", "plan-message");
	const before = parts.before ? el("div", "msg md-body") : null;
	if (before) wrap.appendChild(before);

	const card = el("section", "plan-card");
	card.dataset.planArtifact = "true";
	const head = el("div", "plan-card-head");
	const identity = el("div", "plan-card-identity");
	const icon = el("span", "plan-card-icon");
	icon.innerHTML = SVG.plan;
	identity.append(icon, el("span", "plan-card-title", "实施计划"));
	const badge = el("span", "plan-card-badge", collaborationMode === "plan" ? "待确认" : "计划文档");
	head.append(identity, badge);
	const body = el("div", "plan-card-body md-body");
	card.append(head, body);
	wrap.appendChild(card);

	const after = parts.after ? el("div", "msg md-body") : null;
	if (after) wrap.appendChild(after);
	blk.node.replaceWith(wrap);

	if (before) mdRender({ type: "text", text: parts.before, node: before }, { highlight: true });
	mdRender({ type: "text", text: parts.plan, node: body }, { highlight: true });
	if (after) mdRender({ type: "text", text: parts.after, node: after }, { highlight: true });
	return card;
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
			let hasInteractivePlan = false;
			(m.content ?? []).forEach((c, i) => {
				if (c.type === "text") {
					const blk = blockText();
					blk.text = c.text ?? "";
					a.blocks.set(i, blk);
					a.root.appendChild(blk.node);
					const planCard = renderPlanArtifact(blk);
					if (planCard && collaborationMode === "plan" && !hasInteractivePlan) {
						appendPlanActions(planCard);
						hasInteractivePlan = true;
					} else if (!planCard) {
						mdRender(blk, { highlight: true }); // 历史消息：先挂载再渲染
					}
				} else if (c.type === "thinking") {
					const blk = blockThinking();
					blk.node.classList.remove("streaming");
					blk.text = c.thinking ?? "";
					a.blocks.set(i, blk);
					a.root.appendChild(blk.node);
					mdRender(blk, { highlight: true });
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
	$("#btnAction").addEventListener("click", () => {
		if (streaming) rpcRaw({ type: "abort" }).catch(() => {});
		else sendMessage();
	});
	$("#btnNewChat").addEventListener("click", async () => {
		setView("chat");
		try {
			const res = await rpc({ type: "new_session" });
			if (res.success && !res.data?.cancelled) {
				resetChatView();
				$("#sessionTitle").textContent = "piwpi / 新对话";
				toast("已开始新对话");
				// 立即刷新当前会话（新会话未落盘，树里以"新对话"常驻项呈现）
				rpc({ type: "get_state" }, 30000)
					.then((r) => {
						if (r.success && typeof r.data?.sessionFile === "string") {
							currentSessionFile = r.data.sessionFile;
						}
					})
					.catch(() => {});
				refreshSessions();
			}
		} catch (err) {
			toast(`新建对话失败：${err.message}`, "error");
		}
	});
}

/* ================= Context 抽屉（debug API） ================= */
const drawer = $("#drawer");

function setupDrawer() {
	const ctxBtn = $("#btnContext");
	ctxBtn.addEventListener("click", () => {
		const opening = drawer.hidden;
		if (opening) {
			drawer.hidden = false;
			requestAnimationFrame(() => drawer.classList.add("open"));
			ctxBtn.classList.add("open");
			refreshDebugState();
			refreshContextUsage();
		} else {
			drawer.classList.remove("open");
			ctxBtn.classList.remove("open");
			setTimeout(() => (drawer.hidden = true), 220);
		}
	});
	refreshDebugState(); // 页面加载即拉一次，更新徽标
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
		if (state.cwd) debugCwd = state.cwd; // 会话内稳定，Project Map 相对路径基准
		renderPlugins(state.plugins ?? []);
		renderContext(state.context);
	} catch {
		$("#ctxBadge").textContent = "!";
	}
}

function renderPlugins(plugins) {
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
		if (meta.anchorToolCallId) {
			const shortId = String(meta.anchorToolCallId).replace(/^call_/, "").slice(0, 8);
			metaRow.appendChild(el("span", null, `锚点 ${shortId}`));
		}
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
		// 实时读盘查看：live 端点返回挂载范围在磁盘上的当前内容（引用式，磁盘是事实源）
		const res = await fetch(`/debug/plugins/${encodeURIComponent(id)}/live`);
		if (!res.ok) return;
		const p = await res.json();
		const segs = (p.segments ?? []).map((s) => `--- L${s.start}-${s.end} ---\n${s.text}`).join("\n\n");
		const text = segs || "（无内容）";
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

/* ================= Context telemetry dashboard ================= */
const CTX_CATS = [
	{ key: "system", label: "系统提示词", icon: "SYS", color: "#7167E8" },
	{ key: "tools", label: "工具定义", icon: "DEF", color: "#A78BFA" },
	{ key: "user", label: "用户消息", icon: "USR", color: "#3F9E63" },
	{ key: "assistant", label: "助手回复", icon: "AST", color: "#38A3A5" },
	{ key: "thinking", label: "思考过程", icon: "THK", color: "#E0A82E" },
	{ key: "toolCalls", label: "工具调用", icon: "CALL", color: "#5B8DEF" },
	{ key: "toolResults", label: "工具输出", icon: "OUT", color: "#D96C6C" },
	{ key: "images", label: "图片", icon: "IMG", color: "#D96CA8" },
];
let ctxBreakdown = null;
let ctxUsageTimer = 0;
let ctxFetchSeq = 0;
let ctxChartKey = null;

function formatTokens(n) {
	if (n < 1000) return String(n);
	if (n < 10000) return (n / 1000).toFixed(1) + "k";
	if (n < 1e6) return Math.round(n / 1000) + "k";
	if (n < 1e7) return (n / 1e6).toFixed(1) + "M";
	return Math.round(n / 1e6) + "M";
}

function fmtPct(p) {
	if (!Number.isFinite(p) || p <= 0) return "0%";
	if (p < 0.1) return "<0.1%";
	if (p < 10) return p.toFixed(1) + "%";
	return Math.round(p) + "%";
}

function contextSegments(data) {
	const breakdown = data?.breakdown ?? {};
	return CTX_CATS.map((category) => ({ ...category, tokens: Number(breakdown[category.key]) || 0 }))
		.filter((segment) => segment.tokens > 0);
}

function donutHtml(segs, total, pct) {
	const circumference = 2 * Math.PI * 48;
	const gap = 3;
	const center =
		`<text x="60" y="57" text-anchor="middle" dominant-baseline="middle" class="donut-pct">${fmtPct(pct)}</text>` +
		`<text x="60" y="74" text-anchor="middle" class="donut-cap">已用</text>`;
	if (total <= 0 || segs.length === 0) {
		return `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><circle cx="60" cy="60" r="48" fill="none" stroke="var(--border)" stroke-width="16"/>${center}</svg>`;
	}
	let start = 0;
	let circles = "";
	for (const segment of segs) {
		const sweep = (segment.tokens / total) * circumference;
		const length = Math.max(sweep - gap, 0.75);
		const middleAngle = ((start + sweep / 2) / circumference) * 360 - 90;
		const radians = middleAngle * Math.PI / 180;
		const lift = 5;
		const liftX = Math.cos(radians) * lift;
		const liftY = Math.sin(radians) * lift;
		circles +=
			`<g class="donut-seg-wrap" data-key="${segment.key}" style="--lift-x:${liftX.toFixed(2)}px;--lift-y:${liftY.toFixed(2)}px">` +
			`<circle class="donut-seg" data-key="${segment.key}" cx="60" cy="60" r="48" stroke="${segment.color}"` +
			` stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}"` +
			` stroke-dashoffset="${(-start).toFixed(2)}" transform="rotate(-90 60 60)"/></g>`;
		start += sweep;
	}
	return `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">${circles}${center}</svg>`;
}

function setContextChartHighlight(key) {
	const hasKey = Boolean(key);
	for (const node of document.querySelectorAll("#ctxChartDonut .donut-seg-wrap")) {
		const active = hasKey && node.dataset.key === key;
		node.classList.toggle("focus", active);
		node.classList.remove("dim");
	}
	for (const node of document.querySelectorAll("#ctxChartLegend .ctx-lg-row")) {
		const active = hasKey && node.dataset.key === key;
		node.classList.toggle("focus", active);
		node.classList.remove("dim");
	}
}

function bindContextChartHover() {
	const targets = [
		...document.querySelectorAll("#ctxChartLegend .ctx-lg-row"),
		...document.querySelectorAll("#ctxChartDonut .donut-seg-wrap"),
	];
	for (const target of targets) {
		target.addEventListener("mouseenter", () => setContextChartHighlight(target.dataset.key));
		target.addEventListener("mouseleave", () => setContextChartHighlight(null));
		target.addEventListener("focus", () => setContextChartHighlight(target.dataset.key));
		target.addEventListener("blur", () => setContextChartHighlight(null));
	}
}

function legendHtml(segs, total) {
	return segs.map((segment) => {
		const pct = total > 0 ? (segment.tokens / total) * 100 : 0;
		return `<div class="ctx-lg-row" data-key="${segment.key}">` +
			`<span class="lg-swatch" style="background:${segment.color}"></span>` +
			`<span class="lg-name">${segment.label}</span>` +
			`<span class="lg-tokens">${formatTokens(segment.tokens)}</span>` +
			`<span class="lg-pct">${fmtPct(pct)}</span></div>`;
	}).join("");
}

function renderContextDashboard(data) {
	const breakdown = data?.breakdown ?? {};
	const total = Number(breakdown.total) || 0;
	const pct = Number(data?.percent) || 0;
	$("#ctxBadge").textContent = data ? fmtPct(pct) : "—";
	const circumference = 2 * Math.PI * 48;
	const progress = $("#ctxGaugeProgress");
	const gaugePct = $("#ctxGaugePct");
	const state = $("#ctxUsageState");
	if (total > 0) {
		progress.classList.remove("none", "warn", "high");
		if (pct >= 85) progress.classList.add("high");
		else if (pct >= 60) progress.classList.add("warn");
		progress.style.strokeDasharray = `${circumference.toFixed(2)} ${circumference.toFixed(2)}`;
		progress.style.strokeDashoffset = (circumference * (1 - Math.min(Math.max(pct, 0), 100) / 100)).toFixed(2);
		gaugePct.textContent = fmtPct(pct);
		state.textContent = "已更新";
		state.classList.add("on");
	} else {
		progress.classList.remove("warn", "high");
		progress.classList.add("none");
		gaugePct.textContent = "—";
		state.textContent = "等待数据";
		state.classList.remove("on");
	}
	$("#ctxUsedTokens").textContent = total > 0 ? formatTokens(total) : "—";
	$("#ctxWindowTokens").textContent = data?.contextWindow ? formatTokens(data.contextWindow) : "—";
	$("#ctxMessageStat").textContent = String(contextMessages.length);
	$("#ctxToolStat").textContent = String(contextToolResultCount);
}
function renderContextChart(key) {
	const data = ctxBreakdown;
	const breakdown = data?.breakdown ?? {};
	const total = Number(breakdown.total) || 0;
	const segments = contextSegments(data);
	const focus = segments.find((segment) => segment.key === key);
	const focusPct = focus && total > 0 ? (focus.tokens / total) * 100 : Number(data?.percent) || 0;
	$("#ctxChartTitle").textContent = focus?.label ?? "上下文组成";
	$("#ctxChartSubtitle").textContent = focus ? "该类别在当前上下文中的占用" : "系统提示词、消息与工具数据的实时估算";
	$("#ctxChartValue").textContent = focus ? formatTokens(focus.tokens) : formatTokens(total);
	$("#ctxChartPercent").textContent = focus ? `${fmtPct(focusPct)} · 占用` : `${fmtPct(Number(data?.percent) || 0)} · 已用`;
	$("#ctxChartDonut").innerHTML = donutHtml(segments, total, Number(data?.percent) || 0);
	$("#ctxChartLegend").innerHTML = legendHtml(segments, total);
	$("#ctxChartFoot").textContent = data
		? `上下文窗口 ${formatTokens(data.contextWindow)} · 总量 ${formatTokens(total)}`
		: "模型就绪后显示占用数据";
	bindContextChartHover();
}

function openContextChart(key = null) {
	ctxChartKey = key;
	renderContextChart(key);
	$("#ctxAllViewer").hidden = true;
	const detail = $("#ctxChartDetail");
	detail.hidden = false;
	detail.scrollTop = 0;
}

function closeContextChart() {
	$("#ctxChartDetail").hidden = true;
	ctxChartKey = null;
}

async function refreshContextUsage() {
	try { await esOpened; } catch { return; }
	const seq = ++ctxFetchSeq;
	try {
		const res = await rpc({ type: "get_context_breakdown" }, 8000);
		if (seq !== ctxFetchSeq || !res.success) return;
		ctxBreakdown = res.data ?? null;
		renderContextDashboard(ctxBreakdown);
		if (!$("#ctxChartDetail").hidden) renderContextChart(ctxChartKey);
	} catch {
		// 保留上次成功的数据，避免面板闪烁
	}
}

function scheduleContextUsageRefresh() {
	clearTimeout(ctxUsageTimer);
	ctxUsageTimer = setTimeout(() => {
		refreshDebugState();
		refreshContextUsage();
	}, 500);
}

function setupContextDashboard() {
	$("#ctxUsageSummary").addEventListener("click", () => openContextChart());
	$("#ctxChartOpen").addEventListener("click", () => openContextChart());
	$("#ctxOpenAll").addEventListener("click", openContextViewer);
	$("#ctxViewerSearch").addEventListener("input", (event) => {
		contextViewerQuery = event.target.value.trim();
		renderContextViewer();
	});
	$("#ctxChartClose").addEventListener("click", closeContextChart);
	$("#ctxViewerClose").addEventListener("click", closeContextViewer);
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		if (!$("#ctxAllViewer").hidden) closeContextViewer();
		else if (!$("#ctxChartDetail").hidden) closeContextChart();
	});
	renderContextDashboard(null);
	scheduleContextUsageRefresh();
}

let contextMessages = [];
let contextToolResultCount = 0;
let contextViewerQuery = "";

function contextRoleName(message) {
	return ({ system: "系统", toolResult: "工具", user: "用户", assistant: "助手" })[message.role] ?? "消息";
}

function contextMessageText(message) {
	return message.text || (message.hasImage ? "[图片]" : "");
}

function contextViewerRecords() {
	const query = contextViewerQuery.toLocaleLowerCase();
	return contextMessages
		.map((message, index) => ({ message, index }))
		.filter(({ message }) => {
			if (!query) return true;
			const haystack = `${contextRoleName(message)} ${message.role} ${message.toolCallId ?? ""} ${contextMessageText(message)}`.toLocaleLowerCase();
			return haystack.includes(query);
		});
}

function renderContextViewer() {
	const records = contextViewerRecords();
	const query = contextViewerQuery;
	$("#ctxViewerMeta").textContent = query
		? `${records.length} / ${contextMessages.length} 条消息`
		: `${contextMessages.length} 条消息 · ${contextToolResultCount} 条工具输出`;
	$("#ctxViewerMatch").textContent = query ? `${records.length} 条匹配` : "";
	$("#ctxAllText").textContent = records.map(({ message, index }) => {
		const role = contextRoleName(message);
		const toolId = message.toolCallId ? `\n工具标识   ${message.toolCallId}` : "";
		const text = contextMessageText(message) || "[无文本内容]";
		return `[${String(index + 1).padStart(3, "0")}] ${role}${toolId}\n${text}`;
	}).join("\n\n") || "没有匹配的上下文";
}

function openContextViewer() {
	closeContextChart();
	renderContextViewer();
	$("#ctxAllViewer").hidden = false;
	$("#ctxAllText").scrollTop = 0;
}

function closeContextViewer() {
	$("#ctxAllViewer").hidden = true;
	contextViewerQuery = "";
	$("#ctxViewerSearch").value = "";
}

function renderContext(ctx) {
	if (!ctx) {
		contextMessages = [];
		contextToolResultCount = 0;
		ctxBreakdown = null;
		$("#ctxBadge").textContent = "—";
		$("#msgCount").textContent = "0";
		$("#ctxMeta").textContent = "等待首次请求…";
		renderContextDashboard(null);
		renderContextViewer();
		return;
	}
	contextMessages = Array.isArray(ctx.messages) ? ctx.messages : [];
	contextToolResultCount = Number(ctx.toolResultCount) || 0;
	$("#msgCount").textContent = String(ctx.messageCount ?? contextMessages.length);
	$("#ctxMeta").textContent = `刷新 ${new Date(ctx.ts).toLocaleTimeString("zh-CN", { hour12: false })} · ${contextToolResultCount} 条工具输出`;
	if (ctxBreakdown) renderContextDashboard(ctxBreakdown);
	if (!$("#ctxAllViewer").hidden) renderContextViewer();
}

/* ================= Project Map 页面（debug API） ================= */
const mapDetail = $("#mapDetail");
const mapPicker = $("#mapPicker");
const pickerHead = $("#pickerHead");
const pickerBody = $("#pickerBody");
const pickerSearch = $("#pickerSearch");
const pickerTree = $("#pickerTree");
const pickerCurrent = $("#pickerCurrent");
let mapVisible = false;
let debugCwd = "";            // 会话内稳定，从 /debug/state 缓存
let mapEntries = {};          // 最近一次 entries（重选文件时重渲染用）
let mapFileList = [];         // [{ id, name, rel, entry }]，构建时收集、按 rel 排序
let selectedMapId = null;
const mapCollapsed = new Set(); // 折叠的目录路径（跨刷新保留）
let mapRefreshTimer = null;

/** 视图切换：chat ↔ map。map 视图隐藏 topbar/chat-flow/input-area，显示 mapPage */
function setView(view) {
	const mapView = view === "map";
	mapVisible = mapView;
	document.querySelector(".topbar").hidden = mapView;
	$("#chatFlow").hidden = mapView;
	document.querySelector(".input-area").hidden = mapView;
	$("#mapPage").hidden = !mapView;
	$("#navMap").classList.toggle("selected", mapView);
	if (mapView) refreshMap();
}

/** 相对路径（无 node:path 的浏览器实现，语义对齐 project-map.ts renderTree 的 relative） */
function relPath(cwd, abs, win) {
	const norm = (p) => p.replace(/\\/g, "/");
	const from = norm(cwd).split("/").filter(Boolean);
	const to = norm(abs).split("/").filter(Boolean);
	const cmp = win ? (s) => s.toLowerCase() : (s) => s;
	let i = 0;
	while (i < from.length && i < to.length && cmp(from[i]) === cmp(to[i])) i++;
	const up = from.length - i;
	const rest = to.slice(i).join("/");
	if (!rest) return ".";
	return up ? "../".repeat(up) + rest : rest;
}

/** 目录分组构建（语义对齐 renderTree：过滤 stale 与非 source:file，目录在前文件在后排序） */
function buildMapTree(entries) {
	// win32 检测须在剥掉 source:file: 前缀后的 abs 上做（前缀会挡住 ^[a-zA-Z]: 锚点）
	const win = Object.keys(entries).some((id) =>
		id.startsWith("source:file:") && /^[a-zA-Z]:[\\/]/.test(id.slice("source:file:".length)),
	);
	const root = { name: "", dirs: new Map(), files: [] };
	mapFileList = [];
	for (const [id, e] of Object.entries(entries)) {
		if (!e || e.stale) continue; // 软删除：快照 toJSON 不过滤，前端自建必须过滤（renderTree 同款语义）
		if (!id.startsWith("source:file:")) continue; // 协议：仅 source:file 类别写入
		const abs = id.slice("source:file:".length);
		if (!abs) continue;
		const rel = relPath(debugCwd, abs, win);
		const parts = rel.split("/").filter(Boolean);
		let node = root;
		for (const part of parts.slice(0, -1)) {
			let next = node.dirs.get(part);
			if (!next) { next = { name: part, dirs: new Map(), files: [] }; node.dirs.set(part, next); }
			node = next;
		}
		const file = { name: parts.at(-1) ?? abs, rel, id, entry: e };
		node.files.push(file);
		mapFileList.push(file);
	}
	mapFileList.sort((a, b) => a.rel.localeCompare(b.rel));
	return root;
}

function renderPickerTree(root, query) {
	pickerTree.innerHTML = "";
	const rootName = (debugCwd || "").split(/[\\/]/).filter(Boolean).at(-1) || "项目";
	const rootRow = el("div", "tree-root", rootName);
	rootRow.title = debugCwd || "";
	pickerTree.appendChild(rootRow);

	const term = (query ?? "").trim().toLowerCase();
	if (term) {
		const matches = mapFileList.filter((f) => f.rel.toLowerCase().includes(term));
		if (matches.length === 0) {
			pickerTree.appendChild(el("div", "tree-empty", "无匹配文件"));
		} else {
			for (const f of matches) {
				const row = el("div", "tree-node");
				row.innerHTML = SVG.file;
				row.appendChild(el("span", null, f.rel));
				row.title = f.rel;
				if (f.id === selectedMapId) row.classList.add("selected");
				row.addEventListener("click", () => selectMapFile(f.id));
				pickerTree.appendChild(row);
			}
		}
	} else {
		emitMapNode(root, pickerTree, "");
	}
}

function emitMapNode(node, parent, dirPath) {
	const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	for (const [name, dir] of dirs) {
		const path = dirPath ? `${dirPath}/${name}` : name;
		const row = el("div", "tree-dir");
		const chev = el("span", "dir-chev");
		chev.innerHTML = SVG.chev;
		row.append(chev, `${name}/`);
		const children = el("div", "tree-children");
		emitMapNode(dir, children, path);
		parent.append(row, children);
		if (mapCollapsed.has(path)) row.classList.add("collapsed");
		row.addEventListener("click", (e) => {
			e.stopPropagation();
			row.classList.toggle("collapsed");
			if (row.classList.contains("collapsed")) mapCollapsed.add(path);
			else mapCollapsed.delete(path);
		});
	}
	const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
	for (const f of files) {
		const row = el("div", "tree-node");
		row.innerHTML = SVG.file;
		row.appendChild(el("span", null, f.name));
		row.title = f.rel;
		if (f.id === selectedMapId) row.classList.add("selected");
		row.addEventListener("click", (e) => {
			e.stopPropagation();
			selectMapFile(f.id);
		});
		parent.appendChild(row);
	}
}

function selectMapFile(id) {
	selectedMapId = id;
	pickerSearch.value = "";
	mapPicker.classList.add("collapsed");
	renderMapPage(mapEntries);
}

function updatePickerCurrent() {
	const sel = mapFileList.find((f) => f.id === selectedMapId);
	pickerCurrent.textContent = sel ? sel.rel : "选择一个文件";
	pickerCurrent.title = sel ? sel.rel : "";
}

/** 详情卡：纯 Map 数据（作用/职责/结构/依赖/决策），空字段省略行 */
function renderMapDetail(entry, rel) {
	mapDetail.innerHTML = "";
	const head = el("div", "detail-head");
	const title = el("span", "detail-title", rel);
	title.title = rel;
	head.append(title, el("span", "chip", "Source"));
	mapDetail.appendChild(head);
	const add = (label, value) => {
		mapDetail.appendChild(el("div", "f-label", label));
		mapDetail.appendChild(el("div", "f-value", value));
	};
	const join = (arr) => (arr ?? []).filter(Boolean).join("；");
	if (entry.role) add("文件作用", entry.role);
	if ((entry.responsibilities ?? []).length) add("主要职责", join(entry.responsibilities));
	if ((entry.keyStructures ?? []).length) add("关键结构", join(entry.keyStructures));
	const deps = (entry.dependencies ?? []).filter(Boolean);
	const dependents = (entry.dependents ?? []).filter(Boolean);
	if (deps.length || dependents.length) {
		const parts = [];
		if (deps.length) parts.push(`依赖 ${deps.join("、")}`);
		if (dependents.length) parts.push(`被 ${dependents.join("、")} 依赖`);
		add("依赖关系", parts.join("；"));
	}
	if ((entry.decisions ?? []).length) {
		mapDetail.appendChild(el("div", "divider"));
		mapDetail.appendChild(el("div", "f-label", "相关开发结论"));
		mapDetail.appendChild(el("div", "f-value", join(entry.decisions)));
	}
	if (!mapDetail.querySelector(".f-label")) {
		mapDetail.appendChild(el("div", "tree-empty", "（记忆 Agent 尚未整理出该文件的内容）"));
	}
}

function renderMapPage(entries) {
	mapEntries = entries;
	const root = buildMapTree(entries);
	if (mapFileList.length === 0) {
		pickerTree.innerHTML = "";
		pickerTree.appendChild(el("div", "tree-root", (debugCwd || "").split(/[\\/]/).filter(Boolean).at(-1) || "项目"));
		pickerTree.appendChild(el("div", "tree-empty", "（暂无条目）对话中 agent 读取文件后，记忆 Agent 会累计整理生成项目地图。"));
		mapDetail.innerHTML = "";
		mapDetail.appendChild(el("div", "tree-empty", "从卡片中选择一个文件查看详情"));
		updatePickerCurrent();
		return;
	}
	// 选中态保持：条目失效/消失时回退到第一个文件
	if (!selectedMapId || !mapFileList.some((f) => f.id === selectedMapId)) {
		selectedMapId = mapFileList[0].id;
	}
	renderPickerTree(root, pickerSearch.value);
	updatePickerCurrent();
	const sel = mapFileList.find((f) => f.id === selectedMapId);
	renderMapDetail(sel.entry, sel.rel);
}

async function refreshMap() {
	if (!mapVisible) return;
	try {
		// 树构建依赖 cwd 做相对路径；页面加载时 debug 服务可能尚未就绪导致缓存为空，先补拉一次
		if (!debugCwd) {
			const r = await fetch("/debug/state");
			if (!r.ok) throw new Error(`HTTP ${r.status}`); // 502（服务未就绪）不静默落空 cwd
			const s = await r.json();
			debugCwd = s.cwd ?? "";
		}
		const res = await fetch("/debug/project-map");
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		renderMapPage(data.entries ?? {});
	} catch {
		pickerTree.innerHTML = "";
		pickerTree.appendChild(el("div", "tree-empty", "debug 服务未连接（扩展未启动？），正在重连…"));
		mapDetail.innerHTML = "";
		updatePickerCurrent();
	}
}

function setupMap() {
	// navMap 点击在 chat ↔ map 视图间切换（会话树常驻侧边栏，无需独立 Conversations 导航）
	$("#navMap").addEventListener("click", () => setView(mapVisible ? "chat" : "map"));

	// 文件选择器：点击头部展开/折叠，搜索实时过滤
	pickerHead.addEventListener("click", () => mapPicker.classList.toggle("collapsed"));
	pickerSearch.addEventListener("input", () => {
		const root = buildMapTree(mapEntries);
		renderPickerTree(root, pickerSearch.value);
	});
}

/* ================= 项目目录与会话列表 ================= */
let currentWorkspace = "";
let currentSessionFile = ""; // 当前活动会话（侧边栏高亮）

/** 路径归一化（比较用）：反斜杠转正 + 小写 */
function normPath(p) {
	return String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 轮询扩展 debug 快照直到 cwd 变为目标项目（switch_project 后扩展重载完成） */
async function waitDebugCwd(target, timeoutMs) {
	const start = Date.now();
	for (;;) {
		try {
			const state = await (await fetch("/debug/state")).json();
			if (typeof state.cwd === "string" && normPath(state.cwd) === normPath(target)) return;
		} catch { /* retry */ }
		if (Date.now() - start > timeoutMs) throw new Error("项目切换确认超时");
		await new Promise((r) => setTimeout(r, 250));
	}
}

/** 刷新侧边栏项目名（事实源 = 扩展 debug 快照 cwd，switch_project 后自动跟随；fallback bridge status） */
async function refreshProjectInfo() {
	try {
		let cwd = "";
		try {
			const state = await (await fetch("/debug/state")).json();
			if (typeof state.cwd === "string" && state.cwd) cwd = state.cwd;
		} catch { /* fallthrough */ }
		if (!cwd) {
			const st = await (await fetch("/api/bridge/status")).json();
			if (typeof st.workspace === "string") cwd = st.workspace;
		}
		if (cwd) {
			currentWorkspace = cwd;
			$("#navProject").title = `切换项目目录（当前：${cwd}）`;
		}
	} catch { /* ignore */ }
}

/** 拉取并渲染当前项目会话列表 */
async function refreshSessions() {
	try {
		const res = await fetch("/api/sessions");
		const data = await res.json();
		renderSessions(data.sessions ?? []);
	} catch { /* ignore */ }
}

/** 项目组折叠状态（跨刷新保留）：path -> collapsed */
const projectCollapsed = new Map();

/**
 * 侧边栏多项目会话树（对齐 Codex 桌面版：全部项目会话 + 项目标识）。
 * 按 cwd 分组：当前项目组置顶，各项目默认展开；组标题点击 = 切到该项目（switch_project，
 * 无缝）；会话点击 = switch_session（pi 采纳会话 cwd，跨项目直接切换）。
 * 当前会话常驻（pi 会话文件惰性落盘，未落盘也显示）；无标题会话用首条消息摘要。
 */
function renderSessions(sessions) {
	const tree = $("#sessionTree");
	if (!tree) return;
	tree.innerHTML = "";
	// 合并当前会话（未落盘）→ 归入当前项目组
	const known = new Set(sessions.map((s) => s.sessionFile));
	const current = currentSessionFile && !known.has(currentSessionFile)
		? [{ sessionFile: currentSessionFile, id: "", name: "新对话", firstMessage: "", modified: Date.now(), messageCount: 0, cwd: currentWorkspace }]
		: [];
	const all = [...current, ...sessions];
	if (all.length === 0) {
		tree.appendChild(el("div", "sessions-tree-empty", "暂无历史会话"));
		return;
	}
	// 按 cwd 分组，当前项目置顶
	const groups = new Map();
	for (const s of all) {
		const cwd = s.cwd || currentWorkspace || "";
		if (!groups.has(cwd)) groups.set(cwd, []);
		groups.get(cwd).push(s);
	}
	const order = [...groups.keys()].sort((a, b) => {
		const an = normPath(a) === normPath(currentWorkspace) ? 0 : 1;
		const bn = normPath(b) === normPath(currentWorkspace) ? 0 : 1;
		return an - bn;
	});
	for (const cwd of order) {
		const list = groups.get(cwd);
		const isCurrentProj = normPath(cwd) === normPath(currentWorkspace);
		// 组标题：点击 = 切到该项目（当前组则折叠）；chevron = 仅折叠
		const head = el("div", "proj-group");
		if (isCurrentProj) head.classList.add("current");
		const folder = el("span", "proj-folder");
		folder.innerHTML = SVG.folder;
		const base = cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
		const name = el("span", "proj-name", base);
		name.title = cwd;
		const chev = el("span", "proj-chev");
		chev.innerHTML = SVG.chev;
		head.append(folder, name, chev);
		head.title = isCurrentProj ? `${cwd}（当前项目）` : `${cwd} — 点击切换到此项目`;
		const body = el("div", "proj-body");
		for (const s of list) {
			const isCurrent = s.sessionFile === currentSessionFile;
			const item = el("div", "sess-item");
			if (isCurrent) item.classList.add("active");
			const label = s.name || s.firstMessage || "(无标题会话)";
			const title = el("span", "sess-title-min", label);
			title.title = s.name || s.firstMessage || s.sessionFile;
			const del = el("button", "sess-del");
			del.title = "删除会话";
			del.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2l-6 6" stroke="#74767C" stroke-width="1.4" stroke-linecap="round"/></svg>';
			del.addEventListener("click", async (e) => {
				e.stopPropagation();
				if (isCurrent) {
					toast("当前会话不能删除", "warn");
					return;
				}
				if (!confirm(`删除会话「${s.name || s.firstMessage || s.id}」？文件将从磁盘移除，不可恢复。`)) return;
				try {
					const res = await fetch(`/api/sessions?file=${encodeURIComponent(s.sessionFile)}`, { method: "DELETE" });
					if (res.ok) {
						toast("会话已删除");
						refreshSessions();
					} else {
						toast("删除失败", "error");
					}
				} catch (err) {
					toast(`删除失败：${err.message}`, "error");
				}
			});
			item.append(title, del);
			item.title = s.sessionFile;
			item.addEventListener("click", () => {
				setView("chat");
				if (!isCurrent) resumeSession(s);
			});
			body.appendChild(item);
		}
		tree.append(head, body);
		// 折叠：默认展开，用户主动折叠后保留状态；当前项目始终展开
		const collapsed = isCurrentProj ? false : (projectCollapsed.get(cwd) ?? false);
		if (collapsed) head.classList.add("collapsed");
		chev.addEventListener("click", (e) => {
			e.stopPropagation();
			head.classList.toggle("collapsed");
			projectCollapsed.set(cwd, head.classList.contains("collapsed"));
		});
		head.addEventListener("click", () => {
			if (isCurrentProj) {
				head.classList.toggle("collapsed");
				projectCollapsed.set(cwd, head.classList.contains("collapsed"));
			} else {
				switchProjectPath(cwd);
			}
		});
	}
}

/** 恢复历史会话：switch_session → 重建对话历史（扩展随会话重载，restorePlugins 恢复挂载） */
async function resumeSession(s) {
	setView("chat");
	try {
		const res = await rpc({ type: "switch_session", sessionPath: s.sessionFile }, 30000);
		if (!res.success) {
			toast(`恢复失败：${res.error ?? "未知原因"}`, "error", 8000);
			return;
		}
		if (res.data?.cancelled) return;
		currentSessionFile = s.sessionFile;
		if (s.cwd) {
			currentWorkspace = s.cwd;
			localStorage.setItem("piwpi.project", s.cwd);
		}
		const projectName = (s.cwd || currentWorkspace).split(/[\\/]/).filter(Boolean).at(-1) || "piwpi";
		const sessionName = s.name || s.firstMessage || "新对话";
		$("#sessionTitle").textContent = `${projectName} / ${sessionName}`;
		const [stateRes, levelsRes, messagesRes] = await Promise.all([
			rpc({ type: "get_state" }, 30000),
			rpc({ type: "get_available_thinking_levels" }, 30000),
			rpc({ type: "get_messages" }, 60000),
			refreshProjectInfo(),
		]);
		if (stateRes.success) {
			const state = stateRes.data;
			if (typeof state.sessionFile === "string") currentSessionFile = state.sessionFile;
			$("#modelName").textContent = state.model ? `${state.model.name ?? state.model.id}` : "未选择模型";
			setupModePicker(state.collaborationMode ?? "default");
			setupThinkingPicker(levelsRes.success ? levelsRes.data.levels : ["off"], state.thinkingLevel);
			setStreaming(!!state.isStreaming);
		}
		resetChatView();
		if (messagesRes.success && messagesRes.data.messages.length > 0) {
			rebuildHistory(messagesRes.data.messages);
		}
		refreshSessions();
		refreshDebugState();
		refreshContextUsage();
	} catch (err) {
		toast(`恢复失败：${err.message}`, "error", 8000);
	}
}

/** 切换项目（运行中切换，pi 不重启）：switch_project RPC → 等扩展 cwd 跟随 → 重建视图 */
async function switchProjectPath(path) {
	try {
		const res = await rpc({ type: "switch_project", path }, 30000);
		if (!res.success) {
			toast(`切换失败：${res.error ?? "未知原因"}`, "error", 8000);
			return;
		}
		localStorage.setItem("piwpi.project", res.data?.cwd ?? path);
		await waitDebugCwd(path, 15000);
		await refreshProjectInfo();
		setView("chat");
		resetChatView();
		$("#sessionTitle").textContent = "piwpi / 新对话";
		await initSession();
		toast(`已切换到项目：${res.data?.cwd ?? path}`);
	} catch (err) {
		toast(`切换失败：${err.message}`, "error", 8000);
	}
}

/** 项目切换：优先原生目录选择对话框（Electron）；web 调试模式降级文本输入 overlay */
function openProjectPicker() {
	fetch("/api/project/picker", { method: "POST" })
		.then((r) => r.json())
		.then((data) => {
			if (data.ok && data.path) {
				switchProjectPath(data.path);
			} else {
				openProjectPickerManual();
			}
		})
		.catch(() => openProjectPickerManual());
}

/** 文本输入降级 overlay（web 模式 / picker 不可用时） */
function openProjectPickerManual() {
	const overlay = el("div");
	overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:80;display:flex;align-items:center;justify-content:center;";
	const panel = el("div");
	panel.style.cssText = "width:520px;max-width:90vw;background:#fff;border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:10px;";
	const title = el("div", null, "切换项目目录");
	title.style.cssText = "font-size:14px;font-weight:600;";
	const sub = el("div", null, "切换为运行中切换（pi 不重启）；会话与 Project Map 数据随项目切换（存于 <项目>/.piwpi/）。");
	sub.style.cssText = "font-size:12px;color:var(--text-3);line-height:18px;";
	const input = el("input");
	input.style.cssText = "padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;outline:none;";
	input.placeholder = "项目目录绝对路径";
	input.value = currentWorkspace || "";
	const row = el("div");
	row.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
	const cancel = el("button", null, "取消");
	cancel.style.cssText = "border:1px solid var(--border);background:none;border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;font-family:inherit;";
	const confirm = el("button", null, "切换");
	confirm.style.cssText = "background:var(--brand);color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;font-family:inherit;";
	const close = () => overlay.remove();
	cancel.onclick = close;
	confirm.onclick = () => {
		const path = input.value.trim();
		if (!path) return;
		close();
		switchProjectPath(path);
	};
	row.append(cancel, confirm);
	panel.append(title, sub, input, row);
	overlay.appendChild(panel);
	overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
	document.body.appendChild(overlay);
	input.focus();
	input.select();
}

function setupProject() {
	$("#navProject").addEventListener("click", openProjectPicker);
}

/* ================= Markdown 链接 ================= */
/** 事件委托：外链交给系统浏览器；源文件引用交给桌面主进程打开。 */
chatFlow.addEventListener("click", async (e) => {
	const a = e.target.closest("a[href]");
	if (!a) return;
	e.preventDefault(); // 禁止应用内导航（Electron 已 deny 新窗口 + 限制来源，这里双保险）
	const href = a.getAttribute("href") ?? "";
	const sourcePath = a.dataset.sourcePath;
	if (sourcePath && window.openSourceFile) {
		const result = await window.openSourceFile(sourcePath, currentWorkspace);
		if (!result?.ok) toast(`打开源文件失败：${result?.error ?? "未知原因"}`, "error");
	} else if (/^https?:\/\//i.test(href)) {
		if (window.openExternal) window.openExternal(href);
		else if (window.open) window.open(href, "_blank"); // web 调试模式兜底
	}
});

/* ================= 启动 ================= */
connectEvents();
setupInput();
setupDrawer();
setupContextDashboard();
setupMap();
setupProject();
initSession();

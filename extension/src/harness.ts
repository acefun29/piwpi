import { readFile } from "node:fs/promises";
import type {
	ContextEvent,
	ExtensionContext,
	ModelRegistry,
	SessionEntry,
	SessionStartEvent,
	ToolCallEvent,
	ToolResultEvent,
	TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { registry } from "./adapters/registry.ts";
import {
	isSourceMeta,
	mountedRanges,
	type ReadInputLike,
	rangeFromInput,
	resolveAbsPath,
	sliceText,
	sourceAdapter,
} from "./adapters/source.ts";
import type { DebugContextSnapshot, DebugEvent, DebugMessageSummary, DebugSnapshot } from "./debug.ts";
import { MAX_CONTEXT_TEXT } from "./debug.ts";
import { hashBuffer } from "./hash.ts";
import { type MemoryAgentDeps, summarize } from "./memory/agent.ts";
import { countChangedLines } from "./memory/diff.ts";
import {
	asCustomEntryWriter,
	CUSTOM_ENTRY_TYPE,
	type CustomEntryWriter,
	defaultAgentDir,
	projectMapFilePath,
	readProjectMapFile,
	restoreFromEntries,
	serializePlugin,
	writeProjectMapFile,
} from "./memory/persist.ts";
import { ProjectMap } from "./memory/project-map.ts";
import { MemoryQueue } from "./memory/queue.ts";
import { clamp, type LineRange, subtract } from "./ranges.ts";
import { render } from "./render.ts";
import { PluginStore } from "./store.ts";
import type { MemoryJob, Segment, ToolContextPlugin } from "./types.ts";

/**
 * Harness：tool_call / tool_result / context / session_start / shutdown（计划 §4，M3+M4+M5）。
 *
 * 异常隔离事实（VERIFICATION.md #3）：
 * - tool_result / context handler 异常会被 runner 捕获（runner.ts:887-916 / 993-1006）
 * - tool_call handler 异常**没有** runner 隔离（runner.ts:941），会阻断工具执行
 *   → onToolCall 内部必须自带 try/catch（计划 §4.5），本文件所有 handler 统一自带。
 *
 * context 事件语义（VERIFICATION.md #6，对计划 §4.4 的简化）：
 * runner 在分发前 structuredClone(messages)（runner.ts:986）并把该 clone 传给 handler，
 * 无论 handler 返回什么，runner 恒返回该 clone（runner.ts:1013）。
 * → onContext **原地修改 event.messages 即可生效**，返回 void；无变化时零改动（prompt 缓存前缀稳定）。
 *
 * read 语义事实（read.ts:238-315，M2 已核对）：
 * - offset = 1-based 起始行；limit = 最大行数；输出为 slice(start, end).join("\n") 无行号
 * - 结果上限 2000 行 / 50KB（truncate.ts）；实际行数 = details.truncation.outputLines
 * - firstLineExceedsLimit 时输出是 bash 提示而非文件文本 → 不挂载
 * - 越界 offset 产生 isError 结果 → 透传
 */

/** 本地结构类型：上游包根未 re-export ToolResultEventResult（types.ts:1085-1090 有定义）。 */
export interface ToolResultEventResult {
	content?: { type: "text"; text: string }[];
	details?: unknown;
	isError?: boolean;
}

export interface Harness {
	onToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<void>;
	onToolResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | undefined>;
	onContext(event: ContextEvent, ctx: ExtensionContext): Promise<void>;
	onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void>;
	shutdown(): Promise<void>;
	/** 调试/观测快照（debug HTTP 服务用，见 src/debug.ts） */
	snapshot(): DebugSnapshot;
	/** M5 新模型：Project Map 目录树渲染（read_project_map 工具用） */
	projectMapTree(): string;
}

/** 测试可注入的依赖（默认全部取自事件 ctx） */
export interface HarnessOptions {
	store?: PluginStore;
	queue?: MemoryQueue;
	projectMap?: ProjectMap;
	/** 项目地图文件目录（默认 ~/.pi/agent） */
	agentDir?: string;
	cwd?: string;
	/** 记忆 LLM 依赖（默认从 ctx.modelRegistry/ctx.model 提取） */
	memoryDeps?: MemoryAgentDeps;
	/** 替代 sessionManager custom entry 写入（默认走 ctx.sessionManager） */
	customEntryWriter?: CustomEntryWriter;
	/** 替代 sessionManager entries 读取（默认走 ctx.sessionManager.getEntries()） */
	entriesProvider?: () => SessionEntry[];
	/** 记忆队列去抖窗口（默认 1500ms） */
	debounceMs?: number;
	/** 记忆批量整理阈值：累计未整理文件数（默认 5，M5 新模型） */
	memoryBatchFiles?: number;
	/** 记忆批量整理阈值：累计未整理行数（默认 1000，M5 新模型） */
	memoryBatchLines?: number;
	/** 调试事件监听（debug 服务用；不设置则事件静默丢弃） */
	onEvent?: (event: DebugEvent) => void;
}

/** tool_call 阶段的登记记录（tool_result 按 toolCallId 匹配，计划 §4.2/§4.3） */
type Pending =
	| { kind: "noop"; pluginId: string }
	| { kind: "increment"; pluginId: string; diskLines: string[]; hash: string }
	| { kind: "updated"; pluginId: string; diskLines: string[]; hash: string; oldHash: string }
	| { kind: "new"; pluginId: string; absPath: string; diskLines: string[]; hash: string };

function formatRange(r: LineRange): string {
	return r.start === r.end ? `L${r.start}` : `L${r.start}-${r.end}`;
}

/**
 * 从 ModelRegistry 上安全取 complete（结构访问）。
 * 发布版 0.83.0 的 ModelRegistry 是同步兼容门面（无 complete），而仓库源码
 * model-registry.ts:99-107 有 complete（custom-compaction.ts:90-102 即用此通道）；
 * 运行时拿不到就返回 undefined → 记忆 Agent 静默禁用，其余功能不受影响。
 */
type RegistryComplete = (
	model: unknown,
	context: { systemPrompt?: string; messages: { role: "user"; content: { type: "text"; text: string }[] }[] },
	options?: Record<string, unknown>,
) => Promise<{ content: { type: string; text?: string }[] }>;

function asCompleteFn(modelRegistry: unknown): RegistryComplete | undefined {
	const mr = modelRegistry as
		| { complete?: (model: unknown, context: unknown, options?: unknown) => Promise<unknown> }
		| undefined;
	const fn = mr?.complete;
	if (typeof fn !== "function") return undefined;
	return (model, context, options) =>
		fn(model, context, options) as Promise<{ content: { type: string; text?: string }[] }>;
}

export function createHarness(options: HarnessOptions = {}): Harness {
	const store = options.store ?? new PluginStore();
	const memoryQueue = options.queue ?? new MemoryQueue(options.debounceMs);
	const projectMap = options.projectMap ?? new ProjectMap();
	const pending = new Map<string, Pending>();
	const agentDir = options.agentDir ?? defaultAgentDir();

	let cwd = options.cwd ?? process.cwd();
	let customEntryWriter: CustomEntryWriter | undefined = options.customEntryWriter;
	let entriesProvider: (() => SessionEntry[]) | undefined = options.entriesProvider;
	let modelRegistry: ModelRegistry | undefined;
	let currentModel: unknown;
	let lastUserText = "";
	/** M5 新模型：主 Agent 对话尾部摘要（去重后，记忆整理输入二） */
	let recentDialogue = "";
	let mapLoaded = false;
	let lastContext: DebugContextSnapshot | null = null;
	const memoryBatchFiles = options.memoryBatchFiles ?? 5;
	const memoryBatchLines = options.memoryBatchLines ?? 1000;

	/** 调试事件（debug 服务用；无监听者时零开销）。ts 在此填充。 */
	function emit(event: Omit<DebugEvent, "ts">): void {
		options.onEvent?.({ ...event, ts: Date.now() } as DebugEvent);
	}

	function rememberCtx(ctx: ExtensionContext): void {
		cwd = ctx.cwd;
		modelRegistry ??= ctx.modelRegistry;
		currentModel = ctx.model;
		customEntryWriter ??= asCustomEntryWriter(ctx.sessionManager);
		entriesProvider ??= () => (ctx.sessionManager.getEntries() ?? []) as SessionEntry[];
	}

	function memoryDeps(): MemoryAgentDeps | undefined {
		if (options.memoryDeps) return options.memoryDeps;
		if (!modelRegistry || !currentModel) return undefined;
		const complete = asCompleteFn(modelRegistry);
		if (!complete) return undefined;
		return { complete, model: currentModel };
	}

	function persistPlugin(plugin: ToolContextPlugin): void {
		if (!customEntryWriter) return;
		try {
			customEntryWriter(CUSTOM_ENTRY_TYPE, serializePlugin(plugin));
		} catch (err) {
			console.error("[piwpi] persist plugin error:", err);
		}
	}

	/** 失效阈值：变更行数累积达到 max(8, 总行数×10%)（M5 新模型） */
	function changeThreshold(totalLines: number): number {
		return Math.max(8, Math.round(totalLines * 0.1));
	}

	/** 未整理（pending）插件统计：文件数与行数（M5 新模型批量触发判定） */
	function pendingStats(): { files: number; lines: number } {
		let files = 0;
		let lines = 0;
		for (const p of store.all()) {
			if (!isSourceMeta(p) || p.metadata.memoryState !== "pending") continue;
			files++;
			lines += p.metadata.totalLines ?? 0;
		}
		return { files, lines };
	}

	/**
	 * M5 新模型：批量整理。只在"新增"驱动——收集全部 pending 插件，逐个调 LLM
	 * （输入域：挂载内容 + 对话尾部去重摘要 + map 精简列表），写 Project Map。
	 * 经 memoryQueue 串行链调度，不阻塞主流程；失败仅记日志，pending 保留下轮再试。
	 */
	async function runMemoryBatch(dialogueContext: string): Promise<void> {
		const targets = store.all().filter((p) => isSourceMeta(p) && p.metadata.memoryState === "pending");
		if (targets.length === 0) return;
		const deps = memoryDeps();
		if (!deps?.model) {
			console.error(`[piwpi] no model available — skip memory batch (${targets.length} files)`);
			emit({ type: "memory_skipped", reason: "no-model", pendingFiles: targets.length });
			return; // pending 保留，下次触发再试
		}
		const mapBrief = projectMap.renderBrief(cwd);
		let done = 0;
		for (const plugin of targets) {
			const job: MemoryJob = {
				pluginId: plugin.id,
				localContext: lastUserText,
				dialogueContext,
			};
			const output = await summarize(deps, plugin, job, mapBrief);
			if (!output?.mapEntry) continue; // 失败：保留 pending，下轮再试
			projectMap.update(plugin.id, output.mapEntry);
			const meta = plugin.metadata as { memoryState?: "pending" | "done" };
			plugin.metadata = { ...meta, memoryState: "done" };
			plugin.content = render(plugin);
			store.upsert(plugin);
			await writeProjectMapFile(projectMapFilePath(agentDir, cwd), projectMap.toJSON());
			persistPlugin(plugin);
			emit({ type: "memory_updated", pluginId: plugin.id });
			done++;
		}
		emit({ type: "memory_batch_done", files: done, total: targets.length });
	}

	/** 计划 §6.4：resume 时回放 custom entries 重建 store；segments 按记录范围+哈希从磁盘重切。 */
	async function restorePlugins(): Promise<void> {
		if (!entriesProvider) return;
		let entries: SessionEntry[];
		try {
			entries = entriesProvider();
		} catch (err) {
			console.error("[piwpi] restore entries error:", err);
			return;
		}
		for (const data of restoreFromEntries(entries)) {
			const raw = data.plugin;
			const sourceMeta = raw.metadata as { absPath?: string; hash?: string; segments?: Segment[] } | undefined;
			if (!sourceMeta?.absPath) continue;
			try {
				const buf = await readFile(sourceMeta.absPath);
				const hash = hashBuffer(buf);
				const diskLines = buf.toString("utf8").split("\n");
				if (hash === sourceMeta.hash) {
					// 哈希一致：按记录范围从磁盘重切文本
					const segments: Segment[] = [];
					for (const s of sourceMeta.segments ?? []) {
						const c = clamp({ start: s.start, end: s.end }, diskLines.length);
						if (c) segments.push({ start: c.start, end: c.end, text: sliceText(diskLines, c) });
					}
					raw.metadata = { ...sourceMeta, totalLines: diskLines.length, segments };
				} else {
					// 磁盘已变：段清空、hash 更新；不触发记忆/失效（旧文本不可得无法量化），
					// 等下一次 read 走 updated 按新内容累积判定（自愈，M5 新模型）
					raw.metadata = {
						...sourceMeta,
						hash,
						totalLines: diskLines.length,
						segments: [],
						updatedAtHashChange: false,
					};
				}
			} catch {
				// 文件不可读：段清空，等下一次 read 重建
				raw.metadata = { ...sourceMeta, segments: [] };
			}
			raw.content = render(raw);
			store.upsert(raw);
		}
		emit({ type: "restore", pluginCount: store.all().length });
	}

	// M5 新模型：无 job worker；批量整理经 memoryQueue 串行链调度（runMemoryBatch），
	// shutdown 的 flush 等待同一链完成。

	return {
		/** 计划 §4.2：read 拦截 → 哈希比对 → noop/increment/updated/new 登记（必须自带 try/catch）。 */
		async onToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<void> {
			try {
				rememberCtx(ctx);
				if (event.toolName !== "read") return;
				const adapter = registry[event.toolName];
				if (!adapter || adapter === "unimplemented") return;
				const input = event.input as ReadInputLike;
				if (typeof input.path !== "string" || input.path.length === 0) return;
				const absPath = resolveAbsPath(input.path, ctx.cwd);
				let disk: Buffer;
				try {
					disk = await readFile(absPath);
				} catch {
					return; // 读不到 → 完全走原生（read 自身报错）
				}
				const hash = hashBuffer(disk);
				const diskLines = disk.toString("utf8").split("\n");
				const identity = sourceAdapter.identify(input, ctx.cwd);
				if (!identity) return;
				const id = `source:${identity}`;
				const existing = store.get(id);

				if (existing && isSourceMeta(existing) && existing.metadata.hash === hash) {
					const want = rangeFromInput(input, diskLines.length);
					if (want.start > diskLines.length) return; // 越界：让 read 原生报错
					const missing = subtract(mountedRanges(existing), want);
					if (missing.length === 0) {
						// 全覆盖：不改参数，read 照常执行（IO 廉价），tool_result 里替换成短引用
						pending.set(event.toolCallId, { kind: "noop", pluginId: id });
						emit({ type: "tool_call", pluginId: id, kind: "noop", want });
						return;
					}
					// 只补第一段缺失：read 只支持单连续区间（read.ts:271-283）
					const m = missing[0]!;
					input.offset = m.start;
					input.limit = m.end - m.start + 1;
					pending.set(event.toolCallId, { kind: "increment", pluginId: id, diskLines, hash });
					emit({ type: "tool_call", pluginId: id, kind: "increment", missing: m });
				} else if (existing && isSourceMeta(existing)) {
					// 哈希变了：不改参数，让 read 按用户原始意图执行，重挂载在 tool_result 里做（M4）
					pending.set(event.toolCallId, {
						kind: "updated",
						pluginId: id,
						diskLines,
						hash,
						oldHash: existing.metadata.hash,
					});
					emit({ type: "tool_call", pluginId: id, kind: "updated", oldHash: existing.metadata.hash });
				} else {
					pending.set(event.toolCallId, { kind: "new", pluginId: id, absPath, diskLines, hash });
					emit({ type: "tool_call", pluginId: id, kind: "new" });
				}
			} catch (err) {
				console.error("[piwpi] onToolCall error:", err);
			}
		},

		/** 计划 §4.3：按 pending.kind 分支（new/increment/noop/updated）。 */
		async onToolResult(event: ToolResultEvent, _ctx: ExtensionContext): Promise<ToolResultEventResult | undefined> {
			try {
				if (event.toolName !== "read") return undefined;
				const p = pending.get(event.toolCallId);
				if (!p) return undefined;
				pending.delete(event.toolCallId);
				if (event.isError) return undefined; // 错误结果原样透传
				if (event.content.some((c) => c.type === "image")) return undefined; // 图片 read 不接管（v1 只文本）
				if (event.content[0]?.type !== "text") return undefined;

				const input = event.input as ReadInputLike;
				if (p.kind === "noop") {
					const plugin = store.get(p.pluginId);
					if (!plugin) return undefined;
					const mounted = mountedRanges(plugin).map(formatRange).join(", ");
					emit({ type: "noop", pluginId: p.pluginId, mounted });
					return {
						content: [
							{
								type: "text",
								text: `[piwpi: ${plugin.source.identity} 内容无变化（${mounted} 已挂载于上文），不重复挂载]`,
							},
						],
					};
				}
				const text = event.content[0].text;

				const startLine = Math.max(1, typeof input.offset === "number" ? input.offset : 1);
				const truncation = (event.details as { truncation?: TruncationResult } | undefined)?.truncation;
				let gotEnd: number;
				if (truncation?.firstLineExceedsLimit) {
					return undefined; // 输出是 bash 提示而非文件文本 → 不挂载（原生透传）
				}
				if (truncation) {
					gotEnd = startLine + truncation.outputLines - 1; // 精确：truncation 按完整行计
				} else if (typeof input.limit === "number") {
					const limit = Math.max(0, input.limit);
					gotEnd = startLine + Math.min(limit, p.diskLines.length - startLine + 1) - 1;
				} else {
					gotEnd = p.diskLines.length;
				}
				if (gotEnd < startLine) return undefined;
				const got: LineRange = { start: startLine, end: gotEnd };

				switch (p.kind) {
					case "new": {
						const existing = store.get(p.pluginId);
						if (existing && isSourceMeta(existing)) {
							// 并行竞态（计划 §4.3）：第一个 new 已落地 → 转 increment，anchor 先到先得
							const plugin = sourceAdapter.ingest(input, text, existing, {
								absPath: existing.metadata.absPath,
								hash: p.hash,
								diskLines: p.diskLines,
								anchorToolCallId: existing.metadata.anchorToolCallId,
								got,
								mode: "increment",
							});
							store.upsert(plugin);
							emit({ type: "mounted", pluginId: plugin.id, kind: "increment", hash: p.hash, got });
							const all = mountedRanges(plugin).map(formatRange).join(", ");
							const body = sliceText(p.diskLines, got);
							return {
								content: [
									{
										type: "text",
										text: `[piwpi: ${plugin.source.identity} 已挂载 ${all}，本次新增 ${formatRange(got)}]\n\n${body}`,
									},
								],
							};
						}
						// 保留全文：此消息即锚点（anchorToolCallId = 本次 toolCallId）
						const plugin = sourceAdapter.ingest(input, text, undefined, {
							absPath: p.absPath,
							hash: p.hash,
							diskLines: p.diskLines,
							anchorToolCallId: event.toolCallId,
							got,
							mode: "new",
						});
						// M5 新模型：新文件首次挂载 → 标记 pending（记忆只在新增驱动，修改走失效）
						const newMeta = plugin.metadata as { memoryState?: "pending" | "done" };
						plugin.metadata = { ...newMeta, memoryState: "pending" };
						plugin.content = render(plugin);
						store.upsert(plugin);
						persistPlugin(plugin);
						emit({ type: "mounted", pluginId: plugin.id, kind: "new", hash: p.hash, got });
						// 累计达到阈值（文件数/行数）→ 批量整理（经串行链，不阻塞主流程）
						const stats = pendingStats();
						emit({
							type: "memory_queued",
							pluginId: plugin.id,
							kind: "new",
							pendingFiles: stats.files,
							pendingLines: stats.lines,
						});
						if (stats.files >= memoryBatchFiles || stats.lines >= memoryBatchLines) {
							memoryQueue.enqueueTask(() => runMemoryBatch(recentDialogue));
						}
						return undefined;
					}
					case "increment": {
						const existing = store.get(p.pluginId);
						if (!existing || !isSourceMeta(existing)) return undefined;
						const plugin = sourceAdapter.ingest(input, text, existing, {
							absPath: existing.metadata.absPath,
							hash: p.hash,
							diskLines: p.diskLines,
							anchorToolCallId: existing.metadata.anchorToolCallId,
							got,
							mode: "increment",
						});
						store.upsert(plugin);
						emit({ type: "mounted", pluginId: plugin.id, kind: "increment", hash: p.hash, got });
						const all = mountedRanges(plugin).map(formatRange).join(", ");
						const body = sliceText(p.diskLines, got);
						return {
							content: [
								{
									type: "text",
									text: `[piwpi: ${plugin.source.identity} 已挂载 ${all}，本次新增 ${formatRange(got)}]\n\n${body}`,
								},
							],
						};
					}
					case "updated": {
						const existing = store.get(p.pluginId);
						if (!existing || !isSourceMeta(existing)) return undefined;
						// M5 新模型：变更量只算"已挂载段"的内容变化——旧段按新行数 clamp 后重切 vs 旧段文本
						// （本次 read 的 got 段是新挂载，不算变更，避免"读新范围"误触发失效）
						let changed = 0;
						for (const seg of (existing.metadata.segments as Segment[] | undefined) ?? []) {
							const c = clamp({ start: seg.start, end: seg.end }, p.diskLines.length);
							if (!c) {
								changed += seg.end - seg.start + 1; // 段被截掉 → 全部算变更
								continue;
							}
							changed += countChangedLines(seg.text.split("\n"), sliceText(p.diskLines, c).split("\n"));
						}
						const accumulated = ((existing.metadata.pendingMemoryLines as number | undefined) ?? 0) + changed;
						const plugin = sourceAdapter.ingest(input, text, existing, {
							absPath: existing.metadata.absPath,
							hash: p.hash,
							diskLines: p.diskLines,
							anchorToolCallId: existing.metadata.anchorToolCallId,
							got,
							mode: "updated",
						});
						if (accumulated >= changeThreshold(p.diskLines.length)) {
							// 修改累计到阈值 → 直接挂载失效 + project map 失效（不跑记忆 Agent）；
							// 本次原生透传，下次 read 走新增流程重建（自愈闭环）。旧 custom entry 无法删除，
							// resume 时哈希不一致 → 段清空，无害。
							store.remove(plugin.id);
							projectMap.delete(plugin.id);
							emit({
								type: "invalidated",
								pluginId: plugin.id,
								changedLines: accumulated,
								oldHash: p.oldHash,
								hash: p.hash,
							});
							return undefined;
						}
						// 未达阈值：累积变更行数，正常重挂载
						const meta = plugin.metadata as { pendingMemoryLines?: number };
						plugin.metadata = { ...meta, pendingMemoryLines: accumulated };
						plugin.content = render(plugin);
						store.upsert(plugin);
						persistPlugin(plugin);
						emit({
							type: "mounted",
							pluginId: plugin.id,
							kind: "updated",
							oldHash: p.oldHash,
							hash: p.hash,
							got,
							pendingMemoryLines: accumulated,
						});
						const all = mountedRanges(plugin).map(formatRange).join(", ");
						const body = sliceText(p.diskLines, got);
						return {
							content: [
								{
									type: "text",
									text: `[piwpi: ${plugin.source.identity} 内容已变化，插件已重挂载 ${all}]\n\n${body}`,
								},
							],
						};
					}
				}
				return undefined;
			} catch (err) {
				console.error("[piwpi] onToolResult error:", err);
				return undefined;
			}
		},

		/** 计划 §4.4：原地刷新锚点消息内容（无变化零改动）。 */
		async onContext(event: ContextEvent, ctx: ExtensionContext): Promise<void> {
			try {
				rememberCtx(ctx);
				// 记录最近一条 user 消息（M5 记忆任务的 localContext 来源）。
				// AgentMessage 联合类型含 BashExecutionMessage（content 为 string），用结构访问防御。
				for (let i = event.messages.length - 1; i >= 0; i--) {
					const m = event.messages[i] as { role?: string; content?: unknown };
					if (m.role !== "user") continue;
					if (Array.isArray(m.content)) {
						lastUserText = m.content
							.filter(
								(c): c is { type: string; text?: string } =>
									typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
							)
							.map((c) => c.text ?? "")
							.join(" ")
							.slice(0, 2000);
					}
					break;
				}
				// M5 新模型：缓存主 Agent 对话尾部摘要（最近 6 条），去重规则——
				// toolResult 只留首行标记（如 `[piwpi:plugin ...]`），与文件挂载内容永不重叠。
				const dialogueParts: string[] = [];
				for (const m of event.messages.slice(-6)) {
					const mm = m as { role?: string; content?: unknown };
					const content = Array.isArray(mm.content) ? mm.content : [];
					const textParts = content
						.filter(
							(c): c is { type: string; text?: string } =>
								typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
						)
						.map((c) => c.text ?? "");
					const role = mm.role ?? "";
					if (role === "toolResult") {
						const firstLine = textParts
							.join("\n")
							.split("\n")
							.find((l) => l.trim().length > 0);
						dialogueParts.push(`[toolResult] ${(firstLine ?? "（无文本）").slice(0, 200)}`);
					} else if (textParts.length > 0) {
						dialogueParts.push(`[${role}] ${textParts.join(" ").slice(0, 600)}`);
					}
				}
				recentDialogue = dialogueParts.join("\n").slice(0, 4000);
				for (const plugin of store.all()) {
					if (!isSourceMeta(plugin)) continue;
					let refreshed = false;
					for (const m of event.messages) {
						const msg = m as { role?: string; toolCallId?: unknown; content?: unknown[] };
						if (msg.role !== "toolResult" || msg.toolCallId !== plugin.metadata.anchorToolCallId) continue;
						// 锚点找到：原地替换 content（引用同一对象，runner 返回的 clone 即被修改）
						const fresh = render(plugin);
						const cur = msg.content?.[0] as { type?: string; text?: string } | undefined;
						if (cur?.type === "text" && cur.text !== fresh) {
							msg.content = [{ type: "text", text: fresh }];
							refreshed = true;
						}
						break;
					}
					if (!refreshed) continue; // 锚点被压缩/裁剪 → 本次跳过（计划 §8 已知限制）
				}
				// 上下文摘要（debug 服务用）：每条消息文本截断，防快照膨胀
				const summaries: DebugMessageSummary[] = event.messages.map((m) => {
					const mm = m as { role?: string; toolCallId?: unknown; content?: unknown };
					const content = Array.isArray(mm.content) ? mm.content : [];
					const text = content
						.filter(
							(c): c is { type: string; text?: string } =>
								typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
						)
						.map((c) => c.text ?? "")
						.join("\n");
					return {
						role: mm.role ?? "",
						toolCallId: typeof mm.toolCallId === "string" ? mm.toolCallId : undefined,
						hasImage: content.some((c) => (c as { type?: string }).type === "image"),
						text: text.slice(0, MAX_CONTEXT_TEXT),
					};
				});
				lastContext = {
					ts: Date.now(),
					messageCount: event.messages.length,
					toolResultCount: event.messages.filter((m) => (m as { role?: string }).role === "toolResult").length,
					messages: summaries,
				};
				emit({
					type: "context",
					messageCount: lastContext.messageCount,
					toolResultCount: lastContext.toolResultCount,
				});
			} catch (err) {
				console.error("[piwpi] onContext error:", err);
			}
		},

		/** 计划 §6.4：resume 时从 custom entries 恢复 store；项目地图懒加载。 */
		async onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
			try {
				rememberCtx(ctx);
				if (!mapLoaded) {
					mapLoaded = true;
					try {
						projectMap.load(await readProjectMapFile(projectMapFilePath(agentDir, cwd)));
					} catch (err) {
						console.error("[piwpi] project map load error:", err);
					}
				}
				if (event.reason === "resume") await restorePlugins();
				emit({ type: "session_start", reason: event.reason });
			} catch (err) {
				console.error("[piwpi] onSessionStart error:", err);
			}
		},

		/** 计划 §6.1/§6.4：flush 记忆队列（5s 超时兜底）+ 项目地图落盘。 */
		async shutdown(): Promise<void> {
			try {
				await memoryQueue.flush(5000);
			} catch (err) {
				console.error("[piwpi] shutdown flush error:", err);
			}
			try {
				if (projectMap.size() > 0) {
					await writeProjectMapFile(projectMapFilePath(agentDir, cwd), projectMap.toJSON());
				}
			} catch (err) {
				console.error("[piwpi] shutdown map save error:", err);
			}
			emit({ type: "shutdown" });
		},

		/** 调试/观测快照（debug HTTP 服务用）。 */
		snapshot(): DebugSnapshot {
			const plugins: DebugSnapshot["plugins"] = store.all().map((p) => ({
				id: p.id,
				category: p.category,
				source: p.source,
				metadata: p.metadata as unknown as DebugSnapshot["plugins"][number]["metadata"],
				content: p.content,
				memory: p.memory,
			}));
			return {
				cwd,
				ts: Date.now(),
				plugins,
				projectMap: projectMap.toJSON(),
				pendingCount: pending.size,
				queuePending: memoryQueue.size(),
				lastUserText,
				context: lastContext,
			};
		},

		/** M5 新模型：Project Map 目录树渲染（read_project_map 工具用）。 */
		projectMapTree(): string {
			return projectMap.renderTree(cwd);
		},
	};
}

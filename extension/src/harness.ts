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
	rangeFromInput,
	resolveAbsPath,
	sliceText,
	sourceAdapter,
	type ReadInputLike,
} from "./adapters/source.ts";
import { hashBuffer } from "./hash.ts";
import { summarize, type MemoryAgentDeps } from "./memory/agent.ts";
import {
	asCustomEntryWriter,
	CUSTOM_ENTRY_TYPE,
	defaultAgentDir,
	projectMapFilePath,
	readProjectMapFile,
	restoreFromEntries,
	serializePlugin,
	writeProjectMapFile,
	type CustomEntryWriter,
} from "./memory/persist.ts";
import { ProjectMap } from "./memory/project-map.ts";
import { MemoryQueue } from "./memory/queue.ts";
import { subtract, clamp, type LineRange } from "./ranges.ts";
import { render } from "./render.ts";
import { PluginStore } from "./store.ts";
import type { Segment, ToolContextPlugin } from "./types.ts";

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
	const mr = modelRegistry as { complete?: (model: unknown, context: unknown, options?: unknown) => Promise<unknown> } | undefined;
	const fn = mr?.complete;
	if (typeof fn !== "function") return undefined;
	return (model, context, options) => fn(model, context, options) as Promise<{ content: { type: string; text?: string }[] }>;
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
	let mapLoaded = false;

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
					// 磁盘已变：段清空、hash 更新；等下一次 read 走 increment 重新挂载（自愈）
					raw.metadata = { ...sourceMeta, hash, totalLines: diskLines.length, segments: [], updatedAtHashChange: false };
					memoryQueue.enqueue({ pluginId: raw.id, oldHash: sourceMeta.hash, newHash: hash, localContext: "" });
				}
			} catch {
				// 文件不可读：段清空，等下一次 read 重建
				raw.metadata = { ...sourceMeta, segments: [] };
			}
			raw.content = render(raw);
			store.upsert(raw);
		}
	}

	// 记忆 worker（M5）：串行、失败不阻断主流程
	memoryQueue.setWorker(async (job) => {
		try {
			const plugin = store.get(job.pluginId);
			if (!plugin) return;
			const deps = memoryDeps();
			if (!deps?.model) {
				console.error(`[piwpi] no model available — skip memory job for ${job.pluginId}`);
				return;
			}
			const output = await summarize(deps, plugin, job);
			if (!output) return;
			plugin.memory = { summary: output.summary, understanding: output.understanding, relations: output.relations };
			const meta = plugin.metadata as { updatedAtHashChange?: boolean };
			plugin.metadata = { ...meta, updatedAtHashChange: false };
			plugin.content = render(plugin);
			store.upsert(plugin);
			if (output.mapEntry) projectMap.update(plugin.id, output.mapEntry);
			await writeProjectMapFile(projectMapFilePath(agentDir, cwd), projectMap.toJSON());
			persistPlugin(plugin);
		} catch (err) {
			console.error("[piwpi] memory worker error:", err);
		}
	});

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
						return;
					}
					// 只补第一段缺失：read 只支持单连续区间（read.ts:271-283）
					const m = missing[0]!;
					input.offset = m.start;
					input.limit = m.end - m.start + 1;
					pending.set(event.toolCallId, { kind: "increment", pluginId: id, diskLines, hash });
				} else if (existing && isSourceMeta(existing)) {
					// 哈希变了：不改参数，让 read 按用户原始意图执行，重挂载在 tool_result 里做（M4）
					pending.set(event.toolCallId, {
						kind: "updated",
						pluginId: id,
						diskLines,
						hash,
						oldHash: existing.metadata.hash,
					});
				} else {
					pending.set(event.toolCallId, { kind: "new", pluginId: id, absPath, diskLines, hash });
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
				if (truncation && truncation.firstLineExceedsLimit) {
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
						store.upsert(plugin);
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
						const plugin = sourceAdapter.ingest(input, text, existing, {
							absPath: existing.metadata.absPath,
							hash: p.hash,
							diskLines: p.diskLines,
							anchorToolCallId: existing.metadata.anchorToolCallId,
							got,
							mode: "updated",
						});
						store.upsert(plugin);
						memoryQueue.enqueue({
							pluginId: plugin.id,
							oldHash: p.oldHash,
							newHash: p.hash,
							localContext: lastUserText,
						});
						persistPlugin(plugin);
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
		},
	};
}

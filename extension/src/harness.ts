import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { type MemoryAgentDeps, summarize } from "./memory/agent.ts";
import { countChangedLines } from "./memory/diff.ts";
import {
	asCustomEntryWriter,
	CUSTOM_ENTRY_TYPE,
	type CustomEntryWriter,
	dataDirFor,
	migrateLegacyProjectMap,
	projectMapFilePath,
	readProjectMapFile,
	restoreFromEntries,
	serializePlugin,
	writeProjectMapFileMerged,
} from "./memory/persist.ts";
import { ProjectMap } from "./memory/project-map.ts";
import { MemoryQueue } from "./memory/queue.ts";
import { FileContentCache } from "./file-cache.ts";
import {
	chunkFingerprint,
	countDelta,
	decodeFingerprint,
	encodeFingerprint,
	lineFingerprint,
} from "./fingerprint.ts";
import { clamp, type LineRange, subtract } from "./ranges.ts";
import { render } from "./render.ts";
import { PluginStore } from "./store.ts";
import type { Segment, ToolContextPlugin } from "./types.ts";

/** P9：per-request trace 日志门（PIWPI_TRACE=1 或 PI_TIMING=1；与 coding-agent timings.ts 同门） */
const TRACE_ENABLED = process.env.PIWPI_TRACE === "1" || process.env.PI_TIMING === "1";

/**
 * Harness：tool_call / tool_result / context / session_start / shutdown（计划 §4，M3+M4+M5）。
 *
 * 异常隔离事实（VERIFICATION.md #3）：
 * - tool_result / context handler 异常会被 runner 捕获（runner.ts:887-916 / 993-1006）
 * - tool_call handler 异常**没有** runner 隔离（runner.ts:941），会阻断工具执行
 *   → onToolCall 内部必须自带 try/catch（计划 §4.5），本文件所有 handler 统一自带。
 *
 * context 事件语义（P0-1 历史不可变 + 尾部增量，替代旧的原地刷新）：
 * runner 在分发前 structuredClone(messages)（runner.ts:984）并把该 clone 传给 handler；
 * handler 返回 { messages } 时 runner 采用之（runner.ts:997-998），否则沿用 clone。
 * → onContext 不再改写任何历史消息：磁盘变化经 buildMountDelta 计算增量文本，
 *   追加到返回数组的最后一条消息 content 尾部（新对象，历史消息逐字节不变）；
 *   delta 为空（无变化挂载）时不返回 messages（runner 沿用 clone，模型视图 = 纯历史）。
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

/** 本地结构类型：上游包根未 re-export ContextEventResult（types.ts:1068-1070 有定义）。
 * runner 只读取 .messages 字段（runner.ts:997-998），用 ContextEvent["messages"] 保持结构一致。 */
export interface ContextResult {
	messages?: ContextEvent["messages"];
}

export interface Harness {
	onToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<void>;
	onToolResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | undefined>;
	/** 返回 { messages }（delta 追加到最后一条）时 runner 采用之；undefined 表示无改动（runner 沿用 clone）。 */
	onContext(event: ContextEvent, ctx: ExtensionContext): Promise<ContextResult | undefined>;
	onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void>;
	/** M5.5：每轮结束阈值递减——未达阈值的小量 pending 在有限轮数内必然触发（触发后重置，攒批保持少调用） */
	onAgentSettled(): void;
	shutdown(): Promise<void>;
	/** 调试/观测快照（debug HTTP 服务用，见 src/debug.ts） */
	snapshot(): DebugSnapshot;
	/** 观测面板"点击实时查看"：从磁盘读取挂载范围当前内容（引用式，磁盘是事实源） */
	liveContent(id: string): Promise<LiveContent | null>;
	/** M5 新模型：Project Map 目录树渲染（read_project_map 工具用） */
	projectMapTree(): string;
}

/** 观测面板"点击实时查看"的返回（debug /api/plugins/:id/live 用） */
export interface LiveContent {
	id: string;
	hash: string;
	totalLines: number;
	segments: { start: number; end: number; text: string }[];
}

/** 测试可注入的依赖（默认全部取自事件 ctx） */
export interface HarnessOptions {
	store?: PluginStore;
	queue?: MemoryQueue;
	projectMap?: ProjectMap;
	/** piwpi 数据目录（project map 落盘处；默认 <cwd>/.piwpi，$PIWPI_DATA_DIR 可覆盖） */
	dataDir?: string;
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

/**
 * tool_call 阶段的登记记录（tool_result 按 toolCallId 匹配，计划 §4.2/§4.3）。
 * 引用式重构后不携带 diskLines（内容按需从 file-cache 取）；updated 保留 oldLines 供 diff。
 */
type Pending =
	| { kind: "noop"; pluginId: string }
	| { kind: "increment"; pluginId: string; hash: string }
	| { kind: "updated"; pluginId: string; hash: string; oldHash: string; oldLines?: string[] }
	| { kind: "new"; pluginId: string; absPath: string; hash: string };

function formatRange(r: LineRange): string {
	return r.start === r.end ? `L${r.start}` : `L${r.start}-${r.end}`;
}

/**
 * 从 ModelRegistry 上安全取 complete（结构访问）。
 * 仓库源码 model-registry.ts:99-107 的 complete 是 runtime.complete 的透传（custom-compaction 即用此通道）；
 * 而 npm 发布版 0.83.0 的 ModelRegistry 是同步兼容门面（无 complete），但 runtime 属性在运行时存在
 * （TS private 不参与运行时），其 ModelRuntime.complete(model, context, options) 形状兼容
 * （auth 由 runtime.prepareRequest 内部解析，返回 AssistantMessage.content 与下方消费形状一致）。
 * 两者都拿不到就返回 undefined → 记忆 Agent 禁用（session_start 自检日志会指出原因，不静默）。
 */
type RegistryComplete = (
	model: unknown,
	context: { systemPrompt?: string; messages: { role: "user"; content: { type: "text"; text: string }[] }[] },
	options?: Record<string, unknown>,
) => Promise<{ content: { type: string; text?: string }[] }>;

/**
 * complete 通道探测：返回来源模式 + 包装函数（供 asCompleteFn 与启动自检共用，逻辑单一）。
 * 必须经对象属性调用（complete 是类方法，内部依赖 this——如 runtime.complete 内部调 this.stream，
 * 门面场景即此形状）；提取成裸函数会丢 this 而崩在调用链深处。
 * 非空断言说明：外层 typeof 守卫保证存在；闭包内 TS 收窄不穿透，且 mr 参数从不重赋值。
 */
function resolveCompleteFn(
	modelRegistry: unknown,
): { mode: "registry" | "runtime"; complete: RegistryComplete } | undefined {
	const mr = modelRegistry as
		| {
				complete?: (model: unknown, context: unknown, options?: unknown) => Promise<unknown>;
				runtime?: { complete?: (model: unknown, context: unknown, options?: unknown) => Promise<unknown> };
		  }
		| undefined;
	if (typeof mr?.complete === "function") {
		return {
			mode: "registry",
			complete: (model, context, options) =>
				mr!.complete!(model, context, options) as Promise<{ content: { type: string; text?: string }[] }>,
		};
	}
	if (typeof mr?.runtime?.complete === "function") {
		return {
			mode: "runtime",
			complete: (model, context, options) =>
				mr!.runtime!.complete!(model, context, options) as Promise<{ content: { type: string; text?: string }[] }>,
		};
	}
	return undefined;
}

function asCompleteFn(modelRegistry: unknown): RegistryComplete | undefined {
	return resolveCompleteFn(modelRegistry)?.complete;
}

/**
 * P0-1 历史不可变机制的状态（buildMountDelta 的确定性输入）：
 * - anchorHashes：锚点消息在历史中显示内容对应的磁盘 hash。挂载（new）/增量（increment）时置为
 *   当时磁盘 hash；scanDiskChanges 的重挂载**不更新**（历史锚点文本没变），store.metadata.hash
 *   会更新 → delta 必须对比 anchorHashes 而非 store hash，否则小改重挂载后模型永远看不到最新内容。
 * - retiredMounts：已失效/删除但锚点仍在历史中的挂载（插件已不在 store，store.all() 扫不到）；
 *   同名插件重新挂载（new）时清除。两个 Map 都是纯状态，delta 是状态的纯函数 → 相同输入→相同字节。
 */
interface RetiredMount {
	absPath: string;
	/** 增量条目文本（"挂载已失效…"/"文件已删除…"） */
	reason: string;
}

export function createHarness(options: HarnessOptions = {}): Harness {
	const store = options.store ?? new PluginStore();
	const memoryQueue = options.queue ?? new MemoryQueue(options.debounceMs);
	const projectMap = options.projectMap ?? new ProjectMap();
	/** 引用式内容缓存：唯一读盘入口（磁盘是事实源） */
	const fileCache = new FileContentCache();
	/** P0-1：锚点历史内容对应的磁盘 hash（见 RetiredMount 注释） */
	const anchorHashes = new Map<string, string>();
	/** P0-1：已失效/删除、锚点仍在历史中的挂载 */
	const retiredMounts = new Map<string, RetiredMount>();
	const pending = new Map<string, Pending>();
	/** P0-4：会话代次——记忆整理等异步任务提交前校验（LLM 往返期间会话切换 → 结果丢弃） */
	let sessionGeneration = 0;
	/** P1-1：shutdown 已开始 → 不再启动任何新模型调用 */
	let shuttingDown = false;
	/** P1-2：记忆模型配置（null = 未配置；undefined = 尚未读取） */
	let memoryModelConfig: { providerId: string; modelId: string } | null | undefined;
	/** P1-2：记忆模型缺失/未配置只告警一次 */
	let memoryModelWarned = false;
	/** P9：记忆运行统计（debug 快照） */
	let memoryRunCount = 0;
	let memoryTokenTotal = 0;

	let cwd = options.cwd ?? process.cwd();
	/** piwpi 数据目录（惰性取：cwd 随会话变化，数据目录必须跟随当前项目） */
	const dataDir = () => options.dataDir ?? dataDirFor(cwd);
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
	/** 当前生效的文件数阈值（M5.5：每轮 settled 递减，下限 1；触发整理后重置为初始值——攒批保持少调用） */
	let memoryBatchFilesLeft = memoryBatchFiles;
	/** 渐进式扫描：清单 ≤ SCAN_FULL_LIMIT → 每轮全量；否则每轮 SCAN_BATCH 个 FIFO 循环（单轮成本固定） */
	const SCAN_FULL_LIMIT = 64;
	const SCAN_BATCH = 32;
	let scanQueue: string[] = [];
	let scanCursor = 0;
	/** P1-5：磁盘扫描移出请求关键路径——turn 边界（settled/session_start）置位，turn 内首个 provider 请求前扫描一次 */
	let scanPending = true;

	/** 调试事件（debug 服务用；无监听者时零开销）。ts 在此填充。 */
	function emit(event: Omit<DebugEvent, "ts">): void {
		options.onEvent?.({ ...event, ts: Date.now() } as DebugEvent);
	}

	function rememberCtx(ctx: ExtensionContext): void {
		cwd = ctx.cwd;
		modelRegistry ??= ctx.modelRegistry;
		// 只在有值时更新：后续事件（onToolCall/onContext）的 ctx 可能缺 model，无条件覆盖会冲掉已提取的模型
		if (ctx.model) currentModel = ctx.model;
		// 会话 writer/entries 必须跟随当前会话：会话切换（switch_session/switch_project）会重建
		// sessionManager，??= 会保留旧会话的 writer（挂载写进旧会话 JSONL）；options 注入优先（测试隔离）
		customEntryWriter = options.customEntryWriter ?? asCustomEntryWriter(ctx.sessionManager);
		entriesProvider = options.entriesProvider ?? (() => (ctx.sessionManager.getEntries() ?? []) as SessionEntry[]);
	}

	/** 记忆 Agent LLM 通道自检（session_start 输出一次，杜绝"功能未生效但无日志"） */
	function memoryChannelMode(): string {
		if (options.memoryDeps) return "injected (HarnessOptions.memoryDeps)";
		if (!modelRegistry || !currentModel) {
			return `unavailable (modelRegistry=${!!modelRegistry}, currentModel=${!!currentModel})`;
		}
		const resolved = resolveCompleteFn(modelRegistry);
		if (!resolved) return "unavailable (ModelRegistry 无 complete 通道)";
		return resolved.mode === "registry" ? "registry.complete" : "runtime.complete (fallback)";
	}

	let warnedNoDeps = false; // 记忆 Agent 依赖缺失只警告一次，避免每轮批量刷屏
	function memoryDeps(): MemoryAgentDeps | undefined {
		if (options.memoryDeps) return options.memoryDeps;
		if (!modelRegistry || !currentModel) {
			if (!warnedNoDeps) {
				warnedNoDeps = true;
				console.error(`[piwpi] memory deps unavailable: modelRegistry=${!!modelRegistry} currentModel=${!!currentModel}`);
			}
			return undefined;
		}
		const complete = asCompleteFn(modelRegistry);
		if (!complete) {
			if (!warnedNoDeps) {
				warnedNoDeps = true;
				console.error("[piwpi] memory deps unavailable: ModelRegistry 无 complete 通道（发布版门面缺 runtime.complete？）");
			}
			return undefined;
		}
		// P1-2：配置了记忆模型 → 用指定低成本模型 + maxTokens 1024（限制输出）；未配置 → 主模型（手动触发路径）
		const cfg = resolveMemoryModelConfig();
		if (cfg) {
			// find 可能缺失（宿主门面形状）→ 解析不到即视为未配置，跳过自动路径
			const m = typeof modelRegistry.find === "function" ? modelRegistry.find(cfg.providerId, cfg.modelId) : undefined;
			if (m) {
				// P9：记忆调用独立 usage 日志（complete 契约不含 usage 时记提示）
				const wrapped = async (
					model: unknown,
					context: Parameters<MemoryAgentDeps["complete"]>[1],
					callOptions?: Record<string, unknown>,
				) => {
					memoryRunCount++;
					const res = await complete(model, context, callOptions);
					const usage = (res as { usage?: { input?: number; output?: number; totalTokens?: number } }).usage;
					const mid = (model as { id?: string } | undefined)?.id ?? "?";
					if (usage) {
						memoryTokenTotal += usage.totalTokens ?? 0;
						console.debug(`[memory] model=${mid} input=${usage.input ?? 0} output=${usage.output ?? 0}`);
					} else {
						console.debug(`[memory] model=${mid} input=? output=?（当前 complete 通道不返回 usage）`);
					}
					return res;
				};
				return { complete: wrapped, model: m, maxTokens: 1024 };
			}
			if (!memoryModelWarned) {
				memoryModelWarned = true;
				console.warn(`[piwpi] memory model ${cfg.providerId}/${cfg.modelId} 未在供应商配置中找到，自动记忆整理跳过（手动路径回退主模型）`);
			}
			return undefined;
		}
		return { complete, model: currentModel };
	}

	/**
	 * P1-2：记忆模型配置读取（惰性一次）：
	 * `~/.pi/agent/models.json` 的 memoryModel（与 bridge readModelsConfig 同一文件）→
	 * 其次 `PIWPI_MEMORY_MODEL` env（`providerId/modelId`，命令行专用）→ 都没有 → null。
	 */
	function resolveMemoryModelConfig(): { providerId: string; modelId: string } | null {
		if (memoryModelConfig !== undefined) return memoryModelConfig;
		const env = process.env.PIWPI_MEMORY_MODEL;
		if (env) {
			const i = env.indexOf("/");
			memoryModelConfig =
				i > 0 && i < env.length - 1
					? { providerId: env.slice(0, i), modelId: env.slice(i + 1) }
					: null;
			return memoryModelConfig;
		}
		try {
			const modelsPath = join(homedir(), ".pi", "agent", "models.json");
			const cfg = JSON.parse(readFileSync(modelsPath, "utf8")) as {
				memoryModel?: { providerId?: unknown; modelId?: unknown } | null;
			};
			memoryModelConfig =
				cfg.memoryModel &&
				typeof cfg.memoryModel.providerId === "string" &&
				typeof cfg.memoryModel.modelId === "string"
					? { providerId: cfg.memoryModel.providerId, modelId: cfg.memoryModel.modelId }
					: null;
		} catch {
			memoryModelConfig = null; // 文件缺失/损坏 → 未配置
		}
		return memoryModelConfig;
	}

	/** P1-2：自动记忆整理入口（触发点先过此门）——未配置记忆模型 → 跳过并只提示一次。
	 * options.memoryDeps 注入（测试/宿主显式提供）视为已配置，直接放行。 */
	function memoryAutoAllowed(): boolean {
		if (options.memoryDeps) return true;
		if (resolveMemoryModelConfig() !== null) return true;
		if (!memoryModelWarned) {
			memoryModelWarned = true;
			console.warn("[piwpi] 未配置记忆 Agent 模型（models.json memoryModel 或 PIWPI_MEMORY_MODEL），自动记忆整理已跳过");
		}
		return false;
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

	/**
	 * 已挂载段相对新磁盘的变更行数：oldLines 为旧磁盘全文（来自 file-cache 的 old），
	 * 旧段按新行数 clamp 后与旧段行比较。本次新读的 got 段不算变更（避免"读新范围"误触发失效）。
	 * 无旧文本（resume 首轮 / 大文件 / 缓存被逐出）→ 返回 null：不判定阈值，只重挂载并更新哈希，
	 * 判定留给下次变更（下次缓存有旧文本）。
	 */
	function changedLinesOf(
		plugin: ToolContextPlugin,
		oldLines: string[] | undefined,
		newLines: string[],
	): number | null {
		if (!oldLines) return null;
		let changed = 0;
		for (const seg of (plugin.metadata.segments as Segment[] | undefined) ?? []) {
			const c = clamp({ start: seg.start, end: seg.end }, newLines.length);
			if (!c) {
				changed += seg.end - seg.start + 1; // 段被截掉 → 全部算变更
				continue;
			}
			changed += countChangedLines(oldLines.slice(seg.start - 1, seg.end), newLines.slice(c.start - 1, c.end));
		}
		return changed;
	}

	/** 段范围按新总行数 clamp（旧范围可能超出新行数；超出部分视为截断） */
	function clampSegments(plugin: ToolContextPlugin, totalLines: number): Segment[] {
		const out: Segment[] = [];
		for (const s of (plugin.metadata.segments as Segment[] | undefined) ?? []) {
			const c = clamp({ start: s.start, end: s.end }, totalLines);
			if (c) out.push({ start: c.start, end: c.end });
		}
		return out;
	}

	/** 插件 id 构造（与 source.ts identifyPath 一致：`source:file:` + win32 小写路径） */
	function pluginIdOf(absPath: string): string {
		return `source:file:${process.platform === "win32" ? absPath.toLowerCase() : absPath}`;
	}

	/** 扫描清单 = 挂载文件 + 非 stale map 条目文件（Set 去重；只存 absPath，双重校验运行时推导） */
	function buildScanQueue(): string[] {
		const set = new Set<string>();
		for (const p of store.all()) {
			if (!isSourceMeta(p)) continue;
			const abs = p.metadata.absPath;
			if (typeof abs === "string" && abs.length > 0) set.add(abs);
		}
		for (const id of projectMap.keys()) {
			const e = projectMap.get(id);
			if (e?.stale) continue;
			const abs = projectMap.pathOf(id);
			if (abs) set.add(abs);
		}
		return [...set];
	}

	/** 渐进式分批：≤64 全量（cursor 归零）；>64 取 32 个 FIFO 循环 */
	function pickScanBatch(): string[] {
		scanQueue = buildScanQueue();
		if (scanQueue.length === 0) return [];
		if (scanQueue.length <= SCAN_FULL_LIMIT) {
			scanCursor = 0;
			return scanQueue;
		}
		const batch: string[] = [];
		for (let i = 0; i < SCAN_BATCH; i++) {
			batch.push(scanQueue[scanCursor]!);
			scanCursor = (scanCursor + 1) % scanQueue.length;
		}
		return batch;
	}

	/**
	 * 单条消息 → debug 摘要（文本截断，防快照膨胀）。
	 * onContext（实时快照）与恢复（历史消息）共用，保证结构一致。
	 */
	function toDebugSummary(m: unknown): DebugMessageSummary {
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
	}

	/**
	 * 恢复上下文消息摘要（resume 时从会话 entries 重建 lastContext）。
	 * 消息已持久化在会话 JSONL（type:"message" 条目），无需单独保存——只读内存 entries 重建，无 IO。
	 * 空会话不覆盖（保持 null，前端显示"等待第一次 LLM 请求…"）。
	 */
	function restoreContextFromEntries(): void {
		if (!entriesProvider) return;
		let entries: SessionEntry[];
		try {
			entries = entriesProvider();
		} catch (err) {
			console.error("[piwpi] restore context error:", err);
			return;
		}
		const messages: DebugMessageSummary[] = [];
		let toolResultCount = 0;
		for (const e of entries) {
			if (e.type !== "message") continue;
			const summary = toDebugSummary(e.message);
			if (summary.role === "toolResult") toolResultCount++;
			messages.push(summary);
		}
		if (messages.length === 0) return;
		lastContext = { ts: Date.now(), messageCount: messages.length, toolResultCount, messages };
	}

	/**
	 * 主动磁盘扫描（onContext 每轮调用）。文件被外部修改后**不依赖下一次 read**——
	 * 引用式：经 file-cache 的 stat 快速通道，文件未变（hash 同）→ 完全跳过，零读盘零渲染。
	 * 按渐进式队列迭代（挂载文件 + map 条目文件，一次 get 双重校验）：
	 * 挂载插件：变化量判定（会话内 LCS / 跨会话行指纹）→ 达阈值挂载失效（记入 retiredMounts）/
	 * 未达主动重挂载（anchorHashes 不动）；map 条目：磁盘驱动校验（hash/chunks 自证过期）→
	 * 累计 → 达阈值软删除（stale），写回合并落盘。
	 * P0-1：失效/删除信息不原地改写历史消息，由 buildMountDelta 产出增量条目。
	 */
	async function scanDiskChanges(): Promise<void> {
		const traceStart = Date.now();
		let traceReads = 0;
		let mapDirty = false;
		const scanTargets = pickScanBatch()
			.map((absPath) => {
				const id = pluginIdOf(absPath);
				return {
					absPath,
					id,
					plugin: store.get(id), // 可能 undefined（纯 map 条目文件）
					mapEntry: projectMap.get(id), // 可能 undefined（纯挂载文件）
				};
			})
			.filter(({ plugin, mapEntry }) => plugin || (mapEntry && !mapEntry.stale));

		for (const { absPath, plugin } of scanTargets) {
			if (plugin) fileCache.pin(absPath);
		}
		const scanResults = await Promise.all(
			scanTargets.map(async (target) => ({
				...target,
				result: await fileCache.get(target.absPath),
			})),
		);

		for (const { absPath, id, plugin, mapEntry, result: r } of scanResults) {
			if (!r) {
				// ④ 文件删除/不可读：挂载失效 + map 条目软删除（磁盘事实自证过期）
				if (plugin && isSourceMeta(plugin)) {
					fileCache.unpin(absPath);
					store.remove(plugin.id);
					sessionGeneration++; // P0-4：挂载移除 → 在途记忆结果作废
					// P0-1：锚点仍在历史中 → 记入 retired，delta 每轮提示，直到重新挂载
					retiredMounts.set(plugin.id, { absPath, reason: "文件已删除，挂载失效" });
				}
				if (mapEntry && !mapEntry.stale) {
					mapEntry.stale = true;
					mapDirty = true;
				}
				continue;
			}
			const { entry, old } = r;
			// —— 挂载插件校验（一次 get 双重校验的一半）——
			if (plugin && isSourceMeta(plugin) && entry.hash !== plugin.metadata.hash) {
				traceReads++; // P9：磁盘变更分支必然触发一次显式读
				const diskLines = entry.lines ?? (await fileCache.readLines(absPath));
				const changed = changedLinesOf(plugin, old?.lines, diskLines);
				// 跨会话量化：进程内无旧文本（resume 首轮/大文件/缓存被逐出）但有持久化行指纹
				let crossDelta: number | undefined;
				if (changed === null) {
					const base = decodeFingerprint(plugin.metadata.lineHashes ?? "");
					if (base !== undefined) crossDelta = countDelta(base, lineFingerprint(diskLines));
				}
				const accumulated =
					changed !== null
						? ((plugin.metadata.pendingMemoryLines as number | undefined) ?? 0) + changed
						: crossDelta !== undefined
							? ((plugin.metadata.pendingMemoryLines as number | undefined) ?? 0) + crossDelta
							: 0; // 无旧文本且无指纹：归零，判定留给下次变更（现状语义）
				const oldHash = plugin.metadata.hash;
				if (accumulated >= changeThreshold(diskLines.length)) {
					// 达阈值（会话内 LCS 累计 或 跨会话一次性判定）→ 挂载失效（与 updated 分支同语义）
					// 磁盘驱动：不再 projectMap.delete（map 由条目校验自证过期，不归会话管理）
					fileCache.unpin(absPath);
					store.remove(plugin.id);
					sessionGeneration++; // P0-4：挂载失效 → 在途记忆结果作废
					// P0-1：锚点仍在历史中 → 记入 retired，delta 每轮提示，直到重新挂载
					retiredMounts.set(plugin.id, {
						absPath,
						reason: `文件大改（${accumulated} 行），挂载已失效，请重新 read`,
					});
					emit({
						type: "invalidated",
						pluginId: plugin.id,
						changedLines: accumulated,
						oldHash,
						hash: entry.hash,
					});
					continue;
				}
				// 未达阈值（含跨会话小改追平）：按旧段 clamp 重切重挂载 + 累积 + 行指纹基准追平
				// P0-1：这里**不更新** anchorHashes——历史锚点文本未变（store hash 已更新到磁盘值，
				// delta 必须对比 anchorHashes，否则模型下一轮看到的仍是旧锚点内容）
				plugin.metadata = {
					...plugin.metadata,
					hash: entry.hash,
					totalLines: diskLines.length,
					segments: clampSegments(plugin, diskLines.length),
					pendingMemoryLines: accumulated,
					lineHashes: encodeFingerprint(lineFingerprint(diskLines)),
					updatedAtHashChange: false,
				};
				store.upsert(plugin);
				persistPlugin(plugin);
				emit({
					type: "mounted",
					pluginId: plugin.id,
					kind: "updated",
					oldHash,
					hash: entry.hash,
					changedLines: changed ?? crossDelta ?? 0,
					pendingMemoryLines: accumulated,
				});
			}
			// —— map 条目校验（磁盘驱动：hash/chunks 自证过期；旧条目无 hash → 跳过）——
			if (mapEntry && !mapEntry.stale && typeof mapEntry.hash === "string") {
				if (entry.hash !== mapEntry.hash) {
					const diskLines = entry.lines ?? (await fileCache.readLines(absPath));
					const base = decodeFingerprint(mapEntry.chunks ?? "");
					const delta =
						base === undefined ? diskLines.length : countDelta(base, chunkFingerprint(diskLines));
					const pending = (mapEntry.pendingLines ?? 0) + delta;
					if (pending >= changeThreshold(diskLines.length)) {
						mapEntry.stale = true;
						emit({ type: "map_stale", pluginId: id, changedLines: pending });
					} else {
						mapEntry.pendingLines = pending;
					}
					mapDirty = true;
				}
			}
		}
		if (mapDirty) {
			await writeProjectMapFileMerged(projectMapFilePath(dataDir()), projectMap.toJSON());
		}
		// P9：scan trace（PIWPI_TRACE=1）
		if (TRACE_ENABLED) {
			console.debug(`[trace] scan ms=${Date.now() - traceStart} stat=${scanResults.length} read=${traceReads}`);
		}
	}

	/**
	 * P0-1：确定性增量计算（历史不可变）。对比 anchorHashes（锚点历史内容对应 hash）与
	 * fileCache 当前磁盘 hash；不一致 → 产出增量条目；文件缺失 → "文件已删除"；失效/删除挂载
	 * （retiredMounts）→ 失效提示。不变量：
	 * - 不改写任何历史消息（调用方把返回文本追加到最后一条消息的副本尾部）；
	 * - 文本不含时间戳等运行时变化字段，插件按 id 排序遍历 → 相同状态产出逐字节相同文本；
	 * - 空串表示无变化挂载（模型视图 = 纯历史）。
	 */
	async function buildMountDelta(): Promise<string> {
		const entries: string[] = [];
		// 失效/删除的挂载（插件已不在 store，锚点仍在历史）——按 id 排序保证确定性
		const retired = [...retiredMounts.entries()].sort(([a], [b]) => a.localeCompare(b));
		for (const [, info] of retired) {
			entries.push(`- ${info.absPath}：${info.reason}`);
		}
		const plugins = store
			.all()
			.filter(isSourceMeta)
			.filter((p) => typeof p.metadata.absPath === "string")
			.sort((a, b) => a.id.localeCompare(b.id)); // 确定顺序：相同状态 → 相同字节
		for (const plugin of plugins) {
			const absPath = plugin.metadata.absPath;
			const anchorHash = anchorHashes.get(plugin.id);
			if (anchorHash === undefined) continue; // 未跟踪锚点（restore 前不可能有挂载）
			const r = await fileCache.get(absPath);
			if (!r) {
				// 兜底（scanDiskChanges 已先行处理删除，这里覆盖直接构造状态的测试路径）
				entries.push(`- ${absPath}：文件已删除，挂载失效`);
				continue;
			}
			if (r.entry.hash === anchorHash) continue; // 磁盘未变 → 不产出（纯历史视图，无重复注入）
			const lines = r.entry.lines ?? (await fileCache.readLines(absPath));
			const ranges = mountedRanges(plugin).map(formatRange).join(", ");
			entries.push(
				`- ${absPath}（${ranges}）：内容已变化，当前 hash ${r.entry.hash}；当前内容：\n${render(plugin, lines)}`,
			);
		}
		if (entries.length === 0) return "";
		return `[piwpi 挂载更新]\n${entries.join("\n")}`;
	}

	/** delta 追加到最后一条消息的副本尾部（历史消息对象不变；返回新数组）。 */
	function appendDeltaToLast(
		messages: ContextEvent["messages"],
		delta: string,
	): ContextEvent["messages"] {
		if (messages.length === 0) return messages;
		const lastMsg = messages[messages.length - 1] as unknown as { content?: unknown };
		const content = lastMsg.content;
		let nextContent: unknown;
		if (typeof content === "string") {
			nextContent = `${content}\n\n${delta}`;
		} else if (Array.isArray(content)) {
			nextContent = [...content, { type: "text", text: delta }];
		} else {
			return messages; // 最后一条 content 形态无法承载文本 → 不追加
		}
		const copy = { ...(lastMsg as Record<string, unknown>), content: nextContent };
		return [...messages.slice(0, -1), copy] as unknown as ContextEvent["messages"];
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
	 * M5 新模型：批量整理。只在“新增”驱动——收集全部 pending 插件，整批一次调 LLM
	 * （输入域：各文件挂载内容 + 对话尾部去重摘要 + map 精简列表），写 Project Map。
	 * 经 memoryQueue 串行链调度，不阻塞主流程；失败仅记日志，pending 保留下轮再试。
	 */
	async function runMemoryBatch(dialogueContext: string): Promise<void> {
		// P0-4：捕获任务开始时的会话代次与 abort signal（提交前校验；LLM 往返期间状态变化 → 丢弃）
		const gen = sessionGeneration;
		const signal = memoryQueue.signal;
		if (signal?.aborted) return; // shutdown 超时中止：不再发起新模型调用
		const targets = store
			.all()
			.filter(isSourceMeta)
			.filter((p) => p.metadata.memoryState === "pending");
		if (targets.length === 0) return;
		const deps = memoryDeps();
		if (!deps?.model) {
			console.error(`[piwpi] no model available — skip memory batch (${targets.length} files)`);
			emit({ type: "memory_skipped", reason: "no-model", pendingFiles: targets.length });
			return; // pending 保留，下次触发再试
		}
		const files: { plugin: ToolContextPlugin; lines: string[]; hash: string }[] = [];
		for (const plugin of targets) {
			if (signal?.aborted) return;
			// 引用式：渲染时点统一为任务开始时取到的磁盘内容（LLM 往返期间的变化下轮 scan 自愈）
			const r = await fileCache.get(plugin.metadata.absPath);
			if (!r) continue;
			const lines = r.entry.lines ?? (await fileCache.readLines(plugin.metadata.absPath));
			files.push({ plugin, lines, hash: r.entry.hash });
		}
		if (files.length === 0) return;
		const mapBrief = projectMap.renderBrief(cwd);
		const output = await summarize(
			deps,
			files.map(({ plugin, lines }) => ({ plugin, lines })),
			lastUserText,
			dialogueContext,
			mapBrief,
			{ signal },
		);
		if (signal?.aborted) return; // 结果作废（flush 超时）
		const entries = output?.entries;
		let done = 0;
		if (entries) {
			for (const { plugin, lines, hash } of files) {
				const entry = entries[plugin.id];
				if (!entry) continue; // 模型漏掉该文件：保留 pending，下轮再试
				// P0-4：提交前复核——任一项不满足 → 丢弃该插件结果（旧条目绝不写回）
				if (gen !== sessionGeneration) {
					console.debug("[piwpi] stale memory result dropped (session changed)");
					continue;
				}
				if (signal?.aborted) return;
				if (!store.get(plugin.id)) {
					console.debug("[piwpi] stale memory result dropped (plugin removed)");
					continue;
				}
				const now = await fileCache.get(plugin.metadata.absPath);
				if (!now || now.entry.hash !== hash) {
					console.debug("[piwpi] stale memory result dropped (disk changed)");
					continue;
				}
				// 磁盘驱动：整理即记录基准（hash/chunks = 本时点磁盘状态；pendingLines 归零/stale 清除由 update 内部强制）
				projectMap.update(plugin.id, {
					role: entry.role,
					responsibilities: entry.responsibilities,
					hash,
					chunks: encodeFingerprint(chunkFingerprint(lines)),
				});
				plugin.metadata = { ...plugin.metadata, memoryState: "done" };
				store.upsert(plugin);
				persistPlugin(plugin);
				emit({ type: "memory_updated", pluginId: plugin.id });
				done++;
			}
			if (done > 0) await writeProjectMapFileMerged(projectMapFilePath(dataDir()), projectMap.toJSON());
		}
		emit({ type: "memory_batch_done", files: done, total: targets.length });
	}

	/**
	 * 计划 §6.4：resume 时回放 custom entries 重建 store。
	 * 引用式重构：只恢复元数据（路径/范围/哈希），不读盘重切——磁盘未变时锚点消息历史文本
	 * 即正确（不需要渲染）；磁盘已变时由 scan/read 按哈希变化自愈。
	 */
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
			// 历史条目可能带 text 冗余字段：归一为纯范围（多余字段无害）
			raw.metadata = {
				...sourceMeta,
				segments: (sourceMeta.segments ?? []).map((s) => ({ start: s.start, end: s.end })),
			};
			fileCache.pin(sourceMeta.absPath);
			store.upsert(raw);
			// P0-1：假定历史锚点文本反映持久化 hash；磁盘已变时 delta 会按 hash 差产出
			if (typeof sourceMeta.hash === "string") anchorHashes.set(raw.id, sourceMeta.hash);
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
				// 引用式：经 file-cache（stat 快速通道）取哈希与总行数；文件未变时零读盘
				const r = await fileCache.get(absPath);
				if (!r) return; // 读不到 → 完全走原生（read 自身报错）
				const { entry, old } = r;
				const hash = entry.hash;
				const identity = sourceAdapter.identify(input, ctx.cwd);
				if (!identity) return;
				const id = `source:${identity}`;
				const existing = store.get(id);

				if (existing && isSourceMeta(existing) && existing.metadata.hash === hash) {
					const want = rangeFromInput(input, entry.totalLines);
					if (want.start > entry.totalLines) return; // 越界：让 read 原生报错
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
					pending.set(event.toolCallId, { kind: "increment", pluginId: id, hash });
					emit({ type: "tool_call", pluginId: id, kind: "increment", missing: m });
				} else if (existing && isSourceMeta(existing)) {
					// 哈希变了：不改参数，让 read 按用户原始意图执行，重挂载在 tool_result 里做（M4）
					pending.set(event.toolCallId, {
						kind: "updated",
						pluginId: id,
						hash,
						oldHash: existing.metadata.hash,
						// 旧文本来自本 get 替换前的缓存（diff 用；大文件/缓存被逐出时为 undefined → 不判定阈值）
						oldLines: old?.lines,
					});
					emit({ type: "tool_call", pluginId: id, kind: "updated", oldHash: existing.metadata.hash });
				} else {
					pending.set(event.toolCallId, { kind: "new", pluginId: id, absPath, hash });
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
				if (truncation?.firstLineExceedsLimit) {
					return undefined; // 输出是 bash 提示而非文件文本 → 不挂载（原生透传）
				}
				// 引用式：总行数从 file-cache 取（tool_call 后文件被改的 TOCTOU 由各分支 hash 比对兜底）
				const existing0 = p.kind === "new" ? undefined : store.get(p.pluginId);
				const absPath0 =
					p.kind === "new" ? p.absPath : existing0 && isSourceMeta(existing0) ? existing0.metadata.absPath : undefined;
				if (!absPath0) return undefined;
				const r0 = await fileCache.get(absPath0);
				if (!r0) return undefined;
				const totalLines = r0.entry.totalLines;
				let gotEnd: number;
				if (truncation) {
					gotEnd = startLine + truncation.outputLines - 1; // 精确：truncation 按完整行计
				} else if (typeof input.limit === "number") {
					const limit = Math.max(0, input.limit);
					gotEnd = startLine + Math.min(limit, totalLines - startLine + 1) - 1;
				} else {
					gotEnd = totalLines;
				}
				if (gotEnd < startLine) return undefined;
				const got: LineRange = { start: startLine, end: gotEnd };

				/** 引用式：取当前磁盘行（缓存命中零读盘），并对 tool_call 后的变化（TOCTOU）透传 */
				async function currentLines(absPath: string, expectHash: string): Promise<string[] | undefined> {
					const r = await fileCache.get(absPath);
					if (!r || r.entry.hash !== expectHash) return undefined; // 不可读/文件已变 → 原生透传，下轮 scan 自愈
					return r.entry.lines ?? (await fileCache.readLines(absPath));
				}

				switch (p.kind) {
					case "new": {
						const existing = store.get(p.pluginId);
						if (existing && isSourceMeta(existing)) {
							// 并行竞态（计划 §4.3）：第一个 new 已落地 → 转 increment，anchor 先到先得
							const lines = await currentLines(existing.metadata.absPath, p.hash);
							if (!lines) return undefined;
							const plugin = sourceAdapter.ingest(input, text, existing, {
								absPath: existing.metadata.absPath,
								hash: p.hash,
								totalLines: lines.length,
								anchorToolCallId: existing.metadata.anchorToolCallId,
								got,
								mode: "increment",
							});
							fileCache.pin(existing.metadata.absPath);
							anchorHashes.set(plugin.id, p.hash); // 增量扩展：锚点历史内容仍对应 p.hash
							store.upsert(plugin);
							emit({ type: "mounted", pluginId: plugin.id, kind: "increment", hash: p.hash, got });
							const all = mountedRanges(plugin).map(formatRange).join(", ");
							const body = sliceText(lines, got);
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
							totalLines: r0.entry.totalLines,
							anchorToolCallId: event.toolCallId,
							got,
							mode: "new",
						});
						// M5 新模型：新文件首次挂载 → 标记 pending（记忆只在新增驱动，修改走失效）
						const newMeta = plugin.metadata as { memoryState?: "pending" | "done" };
						// 首次挂载即建立跨会话行指纹基准（r0 刚读盘，≤3000 行缓存命中；大文件 readLines 一次）
						const newLines = r0.entry.lines ?? (await fileCache.readLines(p.absPath));
						plugin.metadata = {
							...newMeta,
							memoryState: "pending",
							lineHashes: encodeFingerprint(lineFingerprint(newLines)),
						};
						fileCache.pin(p.absPath);
						// P0-1：锚点创建 → 记录其内容对应 hash；同名旧挂载的失效提示清除
						anchorHashes.set(plugin.id, p.hash);
						retiredMounts.delete(plugin.id);
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
						if (stats.files >= memoryBatchFilesLeft || stats.lines >= memoryBatchLines) {
							memoryBatchFilesLeft = memoryBatchFiles; // 触发即新一轮攒批
							// P1-2/P1-1：未配置记忆模型或已 shutdown → 不排队（只提示一次）
							if (!shuttingDown && memoryAutoAllowed()) {
								memoryQueue.enqueueTask(() => runMemoryBatch(recentDialogue));
							}
						}
						return undefined;
					}
					case "increment": {
						const existing = store.get(p.pluginId);
						if (!existing || !isSourceMeta(existing)) return undefined;
						const lines = await currentLines(existing.metadata.absPath, p.hash);
						if (!lines) return undefined;
						const plugin = sourceAdapter.ingest(input, text, existing, {
							absPath: existing.metadata.absPath,
							hash: p.hash,
							totalLines: lines.length,
							anchorToolCallId: existing.metadata.anchorToolCallId,
							got,
							mode: "increment",
						});
						fileCache.pin(existing.metadata.absPath);
						anchorHashes.set(plugin.id, p.hash); // 增量在相同 hash 上：锚点历史内容仍对应 p.hash
						store.upsert(plugin);
						emit({ type: "mounted", pluginId: plugin.id, kind: "increment", hash: p.hash, got });
						const all = mountedRanges(plugin).map(formatRange).join(", ");
						const body = sliceText(lines, got);
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
						const lines = await currentLines(existing.metadata.absPath, p.hash);
						if (!lines) return undefined;
						// M5 新模型：变更量只算"已挂载段"的内容变化（本次 read 的 got 段是新挂载，不算变更）
						const changed = changedLinesOf(existing, p.oldLines, lines);
						const accumulated =
							changed === null
								? 0 // 无旧文本：不判定阈值，累积归零（判定留给下次变更）
								: ((existing.metadata.pendingMemoryLines as number | undefined) ?? 0) + changed;
						const plugin = sourceAdapter.ingest(input, text, existing, {
							absPath: existing.metadata.absPath,
							hash: p.hash,
							totalLines: lines.length,
							anchorToolCallId: existing.metadata.anchorToolCallId,
							got,
							mode: "updated",
						});
						if (changed !== null && accumulated >= changeThreshold(lines.length)) {
							// 修改累计到阈值 → 直接挂载失效（不跑记忆 Agent）；本次改写为失效提示
							// （旧 custom entry 无法删除，resume 时哈希不一致 → 段清空，无害）。
							// 磁盘驱动：不再 projectMap.delete（map 由条目校验自证过期，不归会话管理）
							fileCache.unpin(existing.metadata.absPath);
							store.remove(plugin.id);
							// P0-1：失效提示已在本 tool result（真实历史）中，锚点旧内容仍在 → 记 retired 持续提示
							retiredMounts.set(plugin.id, {
								absPath: existing.metadata.absPath,
								reason: `文件大改（${accumulated} 行），挂载已失效，请重新 read`,
							});
							emit({
								type: "invalidated",
								pluginId: plugin.id,
								changedLines: accumulated,
								oldHash: p.oldHash,
								hash: p.hash,
							});
							return {
								content: [
									{
										type: "text",
										text: `[piwpi: ${plugin.source.identity} 文件大改（${accumulated} 行），挂载已失效，请重新 read]`,
									},
								],
							};
						}
						// 未达阈值：累积变更行数，正常重挂载 + 行指纹基准追平
						const meta = plugin.metadata as { pendingMemoryLines?: number };
						plugin.metadata = {
							...meta,
							pendingMemoryLines: accumulated,
							lineHashes: encodeFingerprint(lineFingerprint(lines)),
						};
						fileCache.pin(existing.metadata.absPath);
						// P0-1：锚点（首次挂载消息）仍显示旧内容 → anchorHashes 不动，delta 携带当前全文；
						// 若更新 anchorHashes，模型下一轮将看不到旧范围内已变化的行
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
						const body = sliceText(lines, got);
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

		/** P0-1：历史不可变 + 尾部增量（不再原地改写任何历史消息）。 */
		async onContext(event: ContextEvent, ctx: ExtensionContext): Promise<ContextResult | undefined> {
			try {
				rememberCtx(ctx);
				// P1-5：磁盘扫描移出请求关键路径——turn 内多次 provider 请求只扫一次
				// （工具自写内容本就在 tool result 里，无信息损失；外部编辑延迟到 turn 结束可见）
				if (scanPending) {
					scanPending = false;
					// M5 新模型：主动磁盘扫描——外部修改不依赖下一次 read 即可触发失效/重挂载；
					// 引用式：stat 快速通道，文件未变零读盘；失效/删除记入 retiredMounts
					await scanDiskChanges();
				}
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
				// P0-1：确定性增量——磁盘/失效状态 → delta 文本（空 = 无变化挂载）。
				// 历史消息原样透传；delta 追加到最后一条消息的副本尾部（不落历史）。
				const delta = await buildMountDelta();
				// P1-5：上下文摘要按需生成——仅 debug 监听者存在时映射（无监听者零开销）
				if (options.onEvent) {
					const summaries: DebugMessageSummary[] = event.messages.map((m) => toDebugSummary(m));
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
				} else {
					lastContext = null;
				}
				if (!delta) return undefined; // 无变化挂载：runner 沿用 clone，模型视图 = 纯历史
				return { messages: appendDeltaToLast(event.messages, delta) };
			} catch (err) {
				console.error("[piwpi] onContext error:", err);
				return undefined;
			}
		},

		/** 计划 §6.4：resume 时从 custom entries 恢复 store；项目地图懒加载。 */
		async onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
			try {
				rememberCtx(ctx);
				sessionGeneration++; // P0-4：会话切换/启动 → 旧代次在途任务作废
				scanPending = true; // P1-5：新会话首轮请求前必须扫描一次
				console.log(`[piwpi] memory agent LLM channel: ${memoryChannelMode()}`);
				if (!mapLoaded) {
					mapLoaded = true;
					try {
						// 旧位置（~/.pi/agent/piwpi/<safeCwd>/）→ 项目内 .piwpi/ 一次性迁移（新位置已有则跳过）
						await migrateLegacyProjectMap(cwd, dataDir());
						projectMap.load(await readProjectMapFile(projectMapFilePath(dataDir())));
					} catch (err) {
						console.error("[piwpi] project map load error:", err);
					}
				}
				if (event.reason === "resume") {
					await restorePlugins();
					restoreContextFromEntries(); // 消息同样从会话 entries 重建（无单独保存）
				}
				emit({ type: "session_start", reason: event.reason });
			} catch (err) {
				console.error("[piwpi] onSessionStart error:", err);
			}
		},

		/** P1-1：shutdown 语义——取消未开始任务、只等已运行链（5s 超时中止），不启动任何新模型调用。 */
		async shutdown(): Promise<void> {
			try {
				shuttingDown = true;
				memoryQueue.cancelPending(); // 未开始任务直接丢弃（不派发）
				await memoryQueue.flush(5000); // 只等待已运行链；超时 → abort 在途任务，结果作废
			} catch (err) {
				console.error("[piwpi] shutdown flush error:", err);
			}
			try {
				if (projectMap.size() > 0) {
					// 写前合并：不覆盖其他会话并发写入的条目
					await writeProjectMapFileMerged(projectMapFilePath(dataDir()), projectMap.toJSON());
				}
			} catch (err) {
				console.error("[piwpi] shutdown map save error:", err);
			}
			emit({ type: "shutdown" });
		},

		/** 调试/观测快照（debug HTTP 服务用）。引用式：快照只含元数据，不含内容文本。 */
		snapshot(): DebugSnapshot {
			const plugins: DebugSnapshot["plugins"] = store.all().map((p) => ({
				id: p.id,
				category: p.category,
				source: p.source,
				metadata: p.metadata as unknown as DebugSnapshot["plugins"][number]["metadata"],
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
				memoryRunCount,
				memoryTokenTotal,
			};
		},

		/** 观测面板"点击实时查看"：从磁盘读取挂载范围当前内容（引用式，磁盘是事实源）。 */
		async liveContent(id: string): Promise<LiveContent | null> {
			const plugin = store.get(id);
			if (!plugin || !isSourceMeta(plugin)) return null;
			const r = await fileCache.get(plugin.metadata.absPath);
			if (!r) return null;
			const lines = r.entry.lines ?? (await fileCache.readLines(plugin.metadata.absPath));
			const segments = ((plugin.metadata.segments as Segment[] | undefined) ?? [])
				.filter((s) => s.start <= s.end)
				.map((s) => ({ start: s.start, end: s.end, text: sliceText(lines, s) }));
			return { id, hash: r.entry.hash, totalLines: lines.length, segments };
		},

		/** M5 新模型：Project Map 目录树渲染（read_project_map 工具用）。 */
		projectMapTree(): string {
			return projectMap.renderTree(cwd);
		},

		/** M5.5：每轮结束阈值递减——未达阈值的小量 pending 在有限轮数内必然触发（触发后重置，攒批保持少调用） */
		onAgentSettled(): void {
			scanPending = true; // P1-5：turn 边界置位 → 下一轮 provider 请求前扫描一次
			// P1-2/P1-1：未配置记忆模型或已 shutdown → 自动路径整体跳过
			if (shuttingDown || !memoryAutoAllowed()) return;
			if (memoryBatchFilesLeft > 1) memoryBatchFilesLeft--;
			const stats = pendingStats();
			if (stats.files >= memoryBatchFilesLeft || stats.lines >= memoryBatchLines) {
				memoryBatchFilesLeft = memoryBatchFiles; // 触发即新一轮攒批
				memoryQueue.enqueueTask(() => runMemoryBatch(recentDialogue));
			}
		},
	};
}

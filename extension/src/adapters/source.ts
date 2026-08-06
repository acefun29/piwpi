import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { LineRange } from "../ranges.ts";
import { clamp } from "../ranges.ts";
import { render } from "../render.ts";
import type { PluginCategory, Segment, SourcePluginMeta, ToolContextPlugin } from "../types.ts";

/**
 * Source Adapter：read 工具专用（计划 §3，M2 实现）。
 *
 * 事实依据（VERIFICATION.md）：
 * - read 参数：path 必填；offset = 1-based 起始行号；limit = 最大行数（read.ts:20-24）
 * - 输出不含行号；结果上限 2000 行 / 50KB（truncate.ts），实际行数在 details.truncation.outputLines
 *
 * 与计划 §2.1 接口的两处有据偏差（保持基接口不变，Source 用特化子接口）：
 * 1. identify(input, cwd) —— 相对路径必须对 cwd resolve（计划 §4.1 本身就是 (path, cwd) 签名）；
 * 2. ingest(input, output, current, facts) —— segment 文本必须从磁盘字节重切（计划 §3.3 的字节哈希原则），
 *    harness 在 tool_call 阶段已持有 Buffer，故通过 facts 传入快照与"实际返回范围"，而不是用 output 文本
 *    （output 保留为接口兼容参数，本适配器不使用，避免尾注/截断噪声进 segment）。
 */

/** read 工具的输入（本地结构类型） */
export interface ReadInputLike {
	path?: unknown;
	offset?: unknown;
	limit?: unknown;
}

/** ingest 所需的工具侧事实（由 Harness 从 tool_call/tool_result 事件计算） */
export interface SourceIngestFacts {
	absPath: string;
	hash: string;
	diskLines: string[];
	anchorToolCallId: string;
	/** 本次 read 实际返回的行范围（按 truncation.outputLines 精确推算） */
	got: LineRange;
	mode: "new" | "increment" | "updated" | "noop";
}

/**
 * Source 适配器特化接口（见文件头两处偏差说明）。
 * 故意**不** extends ToolContextAdapter：方法参数增多时接口继承会被严格逆变检查拒绝，
 * 结构兼容性（bivariance）已足够，运行时/赋值均按结构类型工作。
 */
export interface SourceToolContextAdapter {
	category: PluginCategory;
	identify(input: unknown, cwd: string): string;
	ingest(
		input: unknown,
		output: string,
		current: ToolContextPlugin | undefined,
		facts: SourceIngestFacts,
	): ToolContextPlugin;
	render(plugin: ToolContextPlugin): string;
}

/** ~ 展开 + 绝对/相对路径解析（read 语义简化版：不复刻 NFD/弯引号等边角变体，见计划 §8 已知限制） */
export function resolveAbsPath(path: string, cwd: string): string {
	const p = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** 插件身份：`file:<规范化绝对路径>`；Windows 大小写不敏感（计划 §4.1） */
export function identifyPath(path: string, cwd: string): string {
	const abs = resolveAbsPath(path, cwd);
	return `file:${process.platform === "win32" ? abs.toLowerCase() : abs}`;
}

/** read 参数 → 期望行范围（1-based 闭区间；limit 为最大行数，end 为 limit 覆盖的最后一行） */
export function rangeFromInput(input: ReadInputLike, totalLines: number): LineRange {
	const offset = typeof input.offset === "number" ? Math.max(1, input.offset) : 1;
	const limit = typeof input.limit === "number" ? Math.max(0, input.limit) : undefined;
	const end = limit !== undefined ? offset + limit - 1 : totalLines;
	return { start: offset, end: Math.min(end, totalLines) };
}

/** 从磁盘行切片取文本（1-based 闭区间 → 数组切片） */
export function sliceText(diskLines: string[], r: LineRange): string {
	return diskLines.slice(r.start - 1, r.end).join("\n");
}

/**
 * 合并段（重叠/相邻合并，计划 §3.2 normalize 语义）。
 * 合并后范围可能超出单段的文本覆盖，故合并时一律从 diskLines 重切文本 → 逐字节确定。
 */
export function mergeSegments(segments: Segment[], diskLines: string[]): Segment[] {
	const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
	const out: Segment[] = [];
	for (const seg of sorted) {
		const last = out[out.length - 1];
		if (last && seg.start <= last.end + 1) {
			last.end = Math.max(last.end, seg.end);
			last.text = sliceText(diskLines, last);
		} else {
			out.push({ ...seg });
		}
	}
	return out;
}

/** 已挂载范围列表（供 subtract 计算缺失部分） */
export function mountedRanges(plugin: ToolContextPlugin): LineRange[] {
	const meta = plugin.metadata as Partial<SourcePluginMeta> | undefined;
	return (meta?.segments ?? []).map((s) => ({ start: s.start, end: s.end }));
}

/** 类型守卫：metadata 是否为完整的 SourcePluginMeta */
export function isSourceMeta(plugin: ToolContextPlugin): plugin is ToolContextPlugin & { metadata: SourcePluginMeta } {
	return typeof (plugin.metadata as unknown as SourcePluginMeta).absPath === "string";
}

function buildPlugin(facts: SourceIngestFacts, current: ToolContextPlugin | undefined): ToolContextPlugin {
	const identity = identifyPath(facts.absPath, "");
	const meta: SourcePluginMeta = (() => {
		if (facts.mode === "new" || !current) {
			const valid = facts.got.start <= facts.got.end && facts.got.end <= facts.diskLines.length;
			return {
				absPath: facts.absPath,
				hash: facts.hash,
				totalLines: facts.diskLines.length,
				segments: valid
					? [{ start: facts.got.start, end: facts.got.end, text: sliceText(facts.diskLines, facts.got) }]
					: [],
				anchorToolCallId: facts.anchorToolCallId,
				updatedAtHashChange: false,
			};
		}
		const old = current.metadata as unknown as SourcePluginMeta;
		if (facts.mode === "updated") {
			// M4：重切旧范围（clamp 到新行数），补本次 got；被截掉的段记 truncatedNote
			const newTotal = facts.diskLines.length;
			let truncatedNote: string | undefined;
			const reSliced: Segment[] = [];
			for (const s of old.segments) {
				const c = clamp({ start: s.start, end: s.end }, newTotal);
				if (!c || c.end !== s.end) truncatedNote ??= `[truncated: file shrank to ${newTotal} lines]`;
				if (!c) continue;
				reSliced.push({ start: c.start, end: c.end, text: sliceText(facts.diskLines, c) });
			}
			if (facts.got.start <= facts.got.end && facts.got.end <= newTotal) {
				reSliced.push({ start: facts.got.start, end: facts.got.end, text: sliceText(facts.diskLines, facts.got) });
			}
			return {
				absPath: old.absPath,
				hash: facts.hash,
				totalLines: newTotal,
				segments: mergeSegments(reSliced, facts.diskLines),
				anchorToolCallId: old.anchorToolCallId,
				updatedAtHashChange: true,
				truncatedNote,
			};
		}
		// increment：hash 未变 → 磁盘内容与旧段文本一致，合并安全
		const add: Segment = { start: facts.got.start, end: facts.got.end, text: sliceText(facts.diskLines, facts.got) };
		return { ...old, segments: mergeSegments([...old.segments, add], facts.diskLines) };
	})();

	const plugin: ToolContextPlugin = {
		id: `source:${identity}`,
		category: "source",
		source: { toolName: "read", identity },
		content: "",
		metadata: meta as unknown as Record<string, unknown>,
		memory: current?.memory,
	};
	plugin.content = render(plugin);
	return plugin;
}

export const sourceAdapter: SourceToolContextAdapter = {
	category: "source",
	identify(input: unknown, cwd: string): string {
		const p = (input as ReadInputLike).path;
		return typeof p === "string" ? identifyPath(p, cwd) : "";
	},
	ingest(
		_input: unknown,
		_output: string,
		current: ToolContextPlugin | undefined,
		facts: SourceIngestFacts,
	): ToolContextPlugin {
		if (facts.mode === "noop") return current!;
		return buildPlugin(facts, current);
	},
	render,
};

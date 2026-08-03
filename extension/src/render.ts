import type { SourcePluginMeta, ToolContextPlugin } from "./types.ts";

/**
 * 插件渲染：确定性输出（计划 §3.4）。
 *
 * 格式（同一插件状态 → 逐字节相同，prompt 缓存前缀稳定，依据 anthropic-messages.ts:1256）：
 *   [piwpi:plugin file:src/auth.ts hash:9f3a2c1e mounted:L20-80]
 *   --- L20-40 ---
 *   <原始文本>
 *   [piwpi:memory 负责 JWT 签发与刷新；依赖 config.ts]
 *
 * 规则：segments 按 start 升序输出；不重排行号、不加行号前缀；memory 段仅当 summary 存在时输出。
 * 说明：memory 行不含日期——日期会随天变化破坏逐字节确定性，需要时由记忆 Agent 写进 summary 内容。
 */

function formatRange(start: number, end: number): string {
	return start === end ? `L${start}` : `L${start}-${end}`;
}

export function render(plugin: ToolContextPlugin): string {
	const meta = plugin.metadata as Partial<SourcePluginMeta> | undefined;
	if (!meta) return "";

	const segments = [...(meta.segments ?? [])].sort((a, b) => a.start - b.start || a.end - b.end);
	const lines: string[] = [];
	const mounted = segments.map((s) => formatRange(s.start, s.end)).join(", ");
	const hash = meta.hash ? meta.hash.slice(0, 8) : "";
	lines.push(`[piwpi:plugin ${plugin.source.identity} hash:${hash} mounted:${mounted}]`);
	if (meta.truncatedNote) lines.push(meta.truncatedNote);
	for (const seg of segments) {
		lines.push(`--- ${formatRange(seg.start, seg.end)} ---`);
		lines.push(seg.text);
	}
	if (plugin.memory?.summary) {
		const parts = [plugin.memory.summary];
		if (plugin.memory.relations?.length) parts.push(plugin.memory.relations.join("；"));
		lines.push(`[piwpi:memory ${parts.join("；")}]`);
	}
	return lines.join("\n");
}

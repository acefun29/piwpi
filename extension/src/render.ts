import type { SourcePluginMeta, ToolContextPlugin } from "./types.ts";

/**
 * 插件渲染：确定性输出（计划 §3.4）。
 *
 * 格式（同一插件状态 → 逐字节相同，prompt 缓存前缀稳定，依据 anthropic-messages.ts:1256）：
 *   [piwpi:plugin file:src/auth.ts hash:9f3a2c1e mounted:L20-80]
 *   --- L20-40 ---
 *   <原始文本>
 *
 * 规则：segments 按 start 升序输出；不重排行号、不加行号前缀。
 * 说明：挂载引用式重构后段文本不驻留插件，由调用方从 file-cache 取磁盘行传入；
 * 段范围按新行数 clamp（越界 slice 自动截断，调用方已保证 clamp）。
 */

function formatRange(start: number, end: number): string {
	return start === end ? `L${start}` : `L${start}-${end}`;
}

export function render(plugin: ToolContextPlugin, lines: string[]): string {
	const meta = plugin.metadata as Partial<SourcePluginMeta> | undefined;
	if (!meta) return "";

	const segments = [...(meta.segments ?? [])].sort((a, b) => a.start - b.start || a.end - b.end);
	const out: string[] = [];
	const mounted = segments.map((s) => formatRange(s.start, s.end)).join(", ");
	const hash = meta.hash ? meta.hash.slice(0, 8) : "";
	out.push(`[piwpi:plugin ${plugin.source.identity} hash:${hash} mounted:${mounted}]`);
	if (meta.truncatedNote) out.push(meta.truncatedNote);
	for (const seg of segments) {
		out.push(`--- ${formatRange(seg.start, seg.end)} ---`);
		out.push(lines.slice(seg.start - 1, seg.end).join("\n"));
	}
	return out.join("\n");
}

import type { ToolContextPlugin } from "./types.ts";

/**
 * 插件渲染：确定性输出（计划 §3.4，M2 实现）。
 *
 * 格式（逐字节确定，缓存友好）：
 *   [piwpi:plugin file:src/auth.ts hash:9f3a2c1e mounted:L20-80]
 *   --- L20-40 ---
 *   <原始文本>
 *   [piwpi:memory 负责 JWT 签发与刷新；依赖 config.ts；2026-08-04 更新]
 *
 * 规则：segments 按 start 升序输出；不重排行号、不加行号前缀；memory 段仅当 summary 存在时输出。
 */
export function render(plugin: ToolContextPlugin): string {
	throw new Error("TODO(M2): 计划 §3.4");
}

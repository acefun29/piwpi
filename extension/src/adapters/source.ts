import type { ToolContextAdapter, ToolContextPlugin } from "../types.ts";

/**
 * Source Adapter：read 工具专用（计划 §3，M2 实现）。
 *
 * 事实依据（VERIFICATION.md）：
 * - read 参数：path 必填；offset = 1-based 起始行号；limit = 最大行数（tools/read.ts）
 * - 输出不含行号；结果上限 2000 行 / 50KB（truncate.ts），截断信息在 details.truncation.outputLines
 */
export const sourceAdapter: ToolContextAdapter = {
	category: "source",
	identify(_input: unknown): string {
		throw new Error("TODO(M2): 计划 §4.1 路径解析");
	},
	ingest(_input: unknown, _output: string, _current?: ToolContextPlugin): ToolContextPlugin {
		throw new Error("TODO(M2): 计划 §4.3");
	},
	render(_plugin: ToolContextPlugin): string {
		throw new Error("TODO(M2): 计划 §3.4");
	},
};

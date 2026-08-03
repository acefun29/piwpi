import type { ToolContextPlugin } from "./types.ts";

/**
 * 插件存储：内存注册表（计划 §2.3，M1 实现）。
 * 验收：同 id 重复 upsert 只保留一份；findByAnchor 命中正确。
 */
export class PluginStore {
	get(id: string): ToolContextPlugin | undefined {
		throw new Error("TODO(M1): 计划 §2.3");
	}

	upsert(plugin: ToolContextPlugin): void {
		throw new Error("TODO(M1): 计划 §2.3");
	}

	all(): ToolContextPlugin[] {
		throw new Error("TODO(M1): 计划 §2.3");
	}

	findByAnchor(toolCallId: string): ToolContextPlugin | undefined {
		throw new Error("TODO(M1): 计划 §2.3");
	}
}

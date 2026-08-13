import type { SourcePluginMeta, ToolContextPlugin } from "./types.ts";

/**
 * 插件存储：内存注册表（计划 §2.3）。
 *
 * 验收（计划 §2.3）：同 id 重复 upsert 只保留一份；findByAnchor 命中正确。
 * 单写者入口：M3 Harness 是唯一调用方（tool_call/tool_result 路径），并发安全由调用侧串行化保证。
 */
export class PluginStore {
	private byId = new Map<string, ToolContextPlugin>();

	get(id: string): ToolContextPlugin | undefined {
		return this.byId.get(id);
	}

	/** 同 id 覆盖（保留一份）。 */
	upsert(plugin: ToolContextPlugin): void {
		this.byId.set(plugin.id, plugin);
	}

	/** 移除插件（M5 新模型：修改达标 → 挂载失效）。 */
	remove(id: string): void {
		this.byId.delete(id);
	}

	all(): ToolContextPlugin[] {
		return [...this.byId.values()];
	}

	/** 按锚点 toolCallId 反查插件（SourcePluginMeta.anchorToolCallId，计划 §2.2/§2.3）。 */
	findByAnchor(toolCallId: string): ToolContextPlugin | undefined {
		for (const plugin of this.byId.values()) {
			const meta = plugin.metadata as Partial<SourcePluginMeta> | undefined;
			if (meta && meta.anchorToolCallId === toolCallId) return plugin;
		}
		return undefined;
	}

	/** 清空（M5 session 重建时用）。 */
	clear(): void {
		this.byId.clear();
	}
}

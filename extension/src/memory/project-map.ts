import type { MapEntry } from "../types.ts";

/**
 * 项目地图聚合（计划 §6.3）。
 * 内存结构 Map<pluginId, MapEntry>；增量更新不重写（依赖/职责等取并集去重，决定按时间追加去重）。
 */
export class ProjectMap {
	private entries = new Map<string, MapEntry>();

	get(pluginId: string): MapEntry | undefined {
		return this.entries.get(pluginId);
	}

	/** 增量更新：已有条目在旧值上取并集（PRD §5"在原有理解上继续更新"）。 */
	update(pluginId: string, entry: MapEntry): void {
		const old = this.entries.get(pluginId);
		if (!old) {
			this.entries.set(pluginId, entry);
			return;
		}
		const merge = (a: string[], b: string[]) => [...new Set([...a, ...b])];
		this.entries.set(pluginId, {
			role: entry.role || old.role,
			responsibilities: merge(old.responsibilities, entry.responsibilities),
			keyStructures: merge(old.keyStructures, entry.keyStructures),
			dependencies: merge(old.dependencies, entry.dependencies),
			dependents: merge(old.dependents, entry.dependents),
			decisions: merge(old.decisions, entry.decisions),
		});
	}

	size(): number {
		return this.entries.size;
	}

	/** 渲染为 Markdown 项目地图（调试与后续阶段注入用，计划 §6.3）。 */
	renderMarkdown(): string {
		const lines: string[] = ["# 项目地图"];
		for (const [pluginId, e] of [...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			lines.push("", `## ${pluginId}`);
			if (e.role) lines.push(`- 角色: ${e.role}`);
			if (e.responsibilities.length) lines.push(`- 职责: ${e.responsibilities.join("; ")}`);
			if (e.keyStructures.length) lines.push(`- 关键结构: ${e.keyStructures.join("; ")}`);
			if (e.dependencies.length) lines.push(`- 依赖: ${e.dependencies.join("; ")}`);
			if (e.dependents.length) lines.push(`- 被依赖: ${e.dependents.join("; ")}`);
			if (e.decisions.length) lines.push(`- 决策: ${e.decisions.join("; ")}`);
		}
		return lines.join("\n");
	}

	toJSON(): Record<string, MapEntry> {
		return Object.fromEntries(this.entries);
	}

	/** 从持久化数据载入（M5 会话启动懒加载）。 */
	load(data: unknown): void {
		if (typeof data !== "object" || data === null) return;
		for (const [pluginId, entry] of Object.entries(data as Record<string, unknown>)) {
			if (typeof entry !== "object" || entry === null) continue;
			this.entries.set(pluginId, entry as MapEntry);
		}
	}
}

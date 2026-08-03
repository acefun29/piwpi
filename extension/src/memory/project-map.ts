import type { MapEntry } from "../types.ts";

/**
 * 项目地图聚合（计划 §6.3，M5 实现）。
 * 内存结构 Map<pluginId, MapEntry>；增量更新不重写（依赖/职责取并集、决定按时间追加）。
 */
export class ProjectMap {
	get(pluginId: string): MapEntry | undefined {
		throw new Error("TODO(M5): 计划 §6.3");
	}

	update(pluginId: string, entry: MapEntry): void {
		throw new Error("TODO(M5): 计划 §6.3");
	}

	renderMarkdown(): string {
		throw new Error("TODO(M5): 计划 §6.3");
	}
}

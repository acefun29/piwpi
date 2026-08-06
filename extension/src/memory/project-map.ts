import { relative } from "node:path";
import type { MapEntry } from "../types.ts";

/** pluginId 前缀：`source:file:<absPath>`（win32 下 absPath 小写，见 identifyPath） */
const FILE_ID_PREFIX = "source:file:";

/**
 * 项目地图聚合（计划 §6.3）。
 * 内存结构 Map<pluginId, MapEntry>；增量更新不重写（依赖/职责等取并集去重，决定按时间追加去重）。
 * 存储 = 按路径索引的 JSON 字典；渲染 = 目录分组 Markdown 缩进树（LLM 与人两用）；依赖图仅在
 * 计算循环依赖/影响面时临时构建（协议见 docs/project-map-protocol.md）。
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

	/** 失效语义：删除条目（无 tombstone，协议见 project-map-protocol.md）。 */
	delete(pluginId: string): void {
		this.entries.delete(pluginId);
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

	/**
	 * 目录分组渲染：相对 cwd 的 Markdown 缩进树（M5 新模型，read_project_map 返回此格式）。
	 * 目录节点合并共享前缀；文件行 `<basename> — <role>`（role 空时用首条职责）。
	 */
	renderTree(cwd: string): string {
		const root: TreeNode = { name: "", files: [], dirs: new Map() };
		const base = process.platform === "win32" ? cwd.toLowerCase() : cwd;
		for (const [pluginId, entry] of this.entries) {
			const abs = absPathOf(pluginId);
			if (!abs) {
				root.files.push({ name: pluginId, entry });
				continue;
			}
			const rel = relative(base, abs).replace(/\\/g, "/");
			const parts = rel.split("/").filter(Boolean);
			let node = root;
			for (const part of parts.slice(0, -1)) {
				let next = node.dirs.get(part);
				if (!next) {
					next = { name: part, files: [], dirs: new Map() };
					node.dirs.set(part, next);
				}
				node = next;
			}
			node.files.push({ name: parts.at(-1) ?? abs, entry });
		}
		const lines: string[] = ["# 项目地图"];
		emitTree(root, 0, lines);
		return lines.length === 1 ? `${lines[0]}\n（暂无条目）` : lines.join("\n");
	}

	/** 精简列表（路径 — 角色；依赖），记忆 Agent 整理时的参考上下文（每项一行，控制 token）。 */
	renderBrief(cwd: string): string {
		const base = process.platform === "win32" ? cwd.toLowerCase() : cwd;
		const lines: string[] = [];
		for (const [pluginId, e] of [...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			const abs = absPathOf(pluginId);
			const label = abs ? relative(base, abs).replace(/\\/g, "/") : pluginId;
			const role = e.role || e.responsibilities[0] || "";
			const dep = e.dependencies.length ? `；依赖: ${e.dependencies.join(", ")}` : "";
			lines.push(`${label} — ${role}${dep}`);
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

/** 目录树节点 */
interface TreeNode {
	name: string;
	files: { name: string; entry: MapEntry }[];
	dirs: Map<string, TreeNode>;
}

/** 从 `source:file:<abs>` 提取绝对路径；非 source:file 前缀返回 undefined */
function absPathOf(pluginId: string): string | undefined {
	if (!pluginId.startsWith(FILE_ID_PREFIX)) return undefined;
	const abs = pluginId.slice(FILE_ID_PREFIX.length);
	return abs.length > 0 ? abs : undefined;
}

function emitTree(node: TreeNode, depth: number, lines: string[]): void {
	const indent = "  ".repeat(depth);
	// 目录按名字排序、文件按名字排序（目录在前）
	for (const dirName of [...node.dirs.keys()].sort()) {
		const dir = node.dirs.get(dirName)!;
		lines.push(`${indent}${dirName}/`);
		emitTree(dir, depth + 1, lines);
	}
	const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
	for (const f of files) {
		const role = f.entry.role || f.entry.responsibilities[0] || "";
		lines.push(`${indent}${f.name}${role ? ` — ${role}` : ""}`);
	}
}

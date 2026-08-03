import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SourcePluginMeta, ToolContextPlugin } from "../types.ts";

/**
 * 双通道持久化（计划 §6.4）。
 *
 * | 数据 | 通道 |
 * |---|---|
 * | 插件状态（不含大段文本，恢复时按范围从磁盘重切） | ctx.sessionManager.appendCustomEntry("piwpi:plugin", data) |
 * | 项目地图（跨会话长期资产） | 独立文件 join(getAgentDir(), "piwpi", safeCwd, "project-map.json") |
 *
 * 恢复：session_start（reason === "resume"）时回放 custom entries 重建 store（Harness 内实现重切逻辑）。
 * 注意：ExtensionContext.sessionManager 的类型是 ReadonlySessionManager（Pick 自 SessionManager），
 * 不含 appendCustomEntry；运行时传入的是完整 SessionManager 实例，用 asCustomEntryWriter 安全取用。
 */

/** custom entry 类型名（SessionManager.appendCustomEntry 的 customType） */
export const CUSTOM_ENTRY_TYPE = "piwpi:plugin";

/** 持久化载荷：版本 + 插件状态（segments 不含 text，恢复时按范围+哈希从磁盘重切） */
export interface PersistedPluginData {
	version: 1;
	plugin: ToolContextPlugin;
}

/** 从 ReadonlySessionManager 上安全取 appendCustomEntry（运行时存在，类型未暴露） */
export type CustomEntryWriter = (customType: string, data?: unknown) => string;

export function asCustomEntryWriter(sessionManager: unknown): CustomEntryWriter | undefined {
	const sm = sessionManager as { appendCustomEntry?: (t: string, d?: unknown) => string } | undefined;
	return typeof sm?.appendCustomEntry === "function" ? (t, d) => sm.appendCustomEntry!(t, d) : undefined;
}

/** 与 pi session-manager.ts:476-489 一致的 safe cwd 编码（`--` + 剥首分隔符 + 分隔符/冒号替换为 `-` + `--`） */
export function safeCwd(cwd: string): string {
	const resolved = resolve(cwd);
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** 项目地图文件路径（计划 §6.4） */
export function projectMapFilePath(agentDir: string, cwd: string): string {
	return join(agentDir, "piwpi", safeCwd(cwd), "project-map.json");
}

/** 默认 agent 目录：$PI_AGENT_DIR 或 ~/.pi/agent（config.ts:515-521） */
export function defaultAgentDir(): string {
	if (process.env.PI_AGENT_DIR) return process.env.PI_AGENT_DIR;
	return join(homedir(), ".pi", "agent");
}

/** 序列化插件状态：segments 只保留范围（计划 §6.4"不含大段文本"） */
export function serializePlugin(plugin: ToolContextPlugin): PersistedPluginData {
	const meta = plugin.metadata as unknown as SourcePluginMeta;
	return {
		version: 1,
		plugin: {
			...plugin,
			metadata: {
				...meta,
				segments: meta.segments.map((s) => ({ start: s.start, end: s.end, text: "" })),
			},
		},
	};
}

/** 从 session entries 中收集 piwpi custom entries（恢复用）。 */
export function restoreFromEntries(entries: SessionEntry[]): PersistedPluginData[] {
	const out: PersistedPluginData[] = [];
	for (const e of entries) {
		if (e.type !== "custom" || e.customType !== CUSTOM_ENTRY_TYPE) continue;
		const data = e.data as Partial<PersistedPluginData> | undefined;
		if (typeof data?.plugin?.id !== "string") continue;
		out.push({ version: 1, plugin: data.plugin });
	}
	return out;
}

/** 项目地图文件读写（IO 失败一律静默返回 undefined / 抛给调用方记录，绝不影响主流程）。 */
export async function readProjectMapFile(filePath: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

export async function writeProjectMapFile(filePath: string, data: unknown): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

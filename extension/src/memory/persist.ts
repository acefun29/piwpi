import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MapEntry, ToolContextPlugin } from "../types.ts";

/**
 * 双通道持久化（计划 §6.4）。
 *
 * | 数据 | 通道 |
 * |---|---|
 * | 插件状态（不含大段文本，恢复时按范围从磁盘重切） | ctx.sessionManager.appendCustomEntry("piwpi:plugin", data) |
 * | 项目地图（跨会话长期资产） | 独立文件 <项目>/.piwpi/project-map.json（数据跟项目走） |
 *
 * 恢复：session_start（reason === "resume"）时回放 custom entries 重建 store（Harness 内实现重切逻辑）。
 * 注意：ExtensionContext.sessionManager 的类型是 ReadonlySessionManager（Pick 自 SessionManager），
 * 不含 appendCustomEntry；运行时传入的是完整 SessionManager 实例，用 asCustomEntryWriter 安全取用。
 */

/** custom entry 类型名（SessionManager.appendCustomEntry 的 customType） */
export const CUSTOM_ENTRY_TYPE = "piwpi:plugin";

/** 持久化载荷：版本 + 插件状态（引用式：只存路径/范围/哈希，内容按需从磁盘读取） */
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

/** piwpi 数据目录：$PIWPI_DATA_DIR 覆盖 → 默认 <cwd>/.piwpi（数据跟项目走，M6 新模型） */
export function dataDirFor(cwd: string): string {
	if (process.env.PIWPI_DATA_DIR) return process.env.PIWPI_DATA_DIR;
	return join(cwd, ".piwpi");
}

/** 项目地图文件路径（M6 新模型：数据目录内单文件，不再按 safeCwd 分目录——数据目录本身即 per-project） */
export function projectMapFilePath(dataDir: string): string {
	return join(dataDir, "project-map.json");
}

/** 默认 agent 目录：$PI_CODING_AGENT_DIR 或 ~/.pi/agent（与 pi config.ts ENV_AGENT_DIR 一致；仅旧数据迁移用） */
export function defaultAgentDir(): string {
	if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
	return join(homedir(), ".pi", "agent");
}

/**
 * 旧位置 → 新位置一次性迁移：~/.pi/agent/piwpi/<safeCwd>/project-map.json → <dataDir>/project-map.json。
 * 旧位置无文件或新位置已有文件（不覆盖新数据）则跳过；返回是否执行了迁移。
 */
export async function migrateLegacyProjectMap(cwd: string, dataDir: string): Promise<boolean> {
	const legacy = join(defaultAgentDir(), "piwpi", safeCwd(cwd), "project-map.json");
	const target = projectMapFilePath(dataDir);
	try {
		await access(legacy);
	} catch {
		return false;
	}
	try {
		await access(target);
		return false;
	} catch {
		// target 不存在 → 执行迁移
	}
	try {
		await mkdir(dirname(target), { recursive: true });
		await copyFile(legacy, target);
		return true;
	} catch {
		return false;
	}
}

/**
 * 序列化插件状态（引用式重构后插件本身不携带文本；历史条目可能带 text/content 冗余字段，
 * 恢复时多余字段无害，不 version bump）。
 */
export function serializePlugin(plugin: ToolContextPlugin): PersistedPluginData {
	return { version: 1, plugin };
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

/**
 * 写前合并（多会话并发写防护）：以磁盘最新为基准 merge（本内存条目覆盖/新增），再写回。
 * 窗口内另一会话写入的条目不会丢失（丢失窗口 ≈ 一次读+写，代价 = 一次重新整理，不做锁）。
 * 项目地图是项目级共享资产，任何会话写都不得覆盖他人沉淀。
 */
export async function writeProjectMapFileMerged(
	filePath: string,
	data: Record<string, MapEntry>,
): Promise<void> {
	const disk = await readProjectMapFile(filePath);
	const merged: Record<string, MapEntry> = {};
	if (disk && typeof disk === "object" && !Array.isArray(disk)) {
		for (const [k, v] of Object.entries(disk as Record<string, unknown>)) {
			if (v && typeof v === "object") merged[k] = v as MapEntry;
		}
	}
	for (const [k, v] of Object.entries(data)) merged[k] = v;
	await writeProjectMapFile(filePath, merged);
}

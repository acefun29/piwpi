/**
 * piwpi 核心类型（M0 先行落地类型层，纯类型无逻辑）。
 * 来源：docs/阶段一开发计划.md §2.1/§2.2（M1 内容，按计划逐字落地）。
 */

/** 插件类别 */
export type PluginCategory = "source" | "execution" | "evidence";

/** 上下文插件：一个工具调用在上下文中的固定挂载单元（计划 §2.1） */
export interface ToolContextPlugin {
	/** `${category}:${identity}` */
	id: string;
	category: PluginCategory;
	source: { toolName: string; identity: string };
	/** 保留：render 的冗余缓存或调试用 */
	content: string;
	/** Source 插件内部结构见 SourcePluginMeta */
	metadata: Record<string, unknown>;
	memory?: {
		summary?: string;
		understanding?: string;
		relations?: string[];
	};
}

/** 工具上下文适配器（计划 §2.1） */
export interface ToolContextAdapter {
	category: PluginCategory;
	identify(input: unknown): string;
	ingest(input: unknown, output: string, current?: ToolContextPlugin): ToolContextPlugin;
	render(plugin: ToolContextPlugin): string;
}

/** PRD §6：v1 不实现，见需求.md §6 */
export interface ExecutionContextAdapter extends ToolContextAdapter {
	executionKey(input: unknown): string;
	mergeRuns(previous: ToolContextPlugin, nextOutput: string): ToolContextPlugin;
}

/** PRD §6：v1 不实现，见需求.md §6 */
export interface EvidenceContextAdapter extends ToolContextAdapter {
	evidenceKey(input: unknown): string;
	createMemoryJob(plugin: ToolContextPlugin, localContext: string): MemoryJob;
}

/** Source 插件内部状态（放 metadata，计划 §2.2） */
export interface SourcePluginMeta {
	/** 规范化绝对路径 */
	absPath: string;
	/** 磁盘内容 sha256(hex) */
	hash: string;
	/** 最近一次读到哈希时的总行数 */
	totalLines: number;
	/** 已挂载内容，按 start 升序 */
	segments: Segment[];
	/** 插件在消息历史中的锚点消息（首次 read 的 toolCallId） */
	anchorToolCallId: string;
	/** 自上次哈希变化后是否已通知记忆队列 */
	updatedAtHashChange: boolean;
	/** 文件变短被截掉段时的提示行（M4），render 输出在头部；无则缺省 */
	truncatedNote?: string;
	/** 记忆整理状态：首次挂载未整理 = pending，批量整理完成 = done（缺省视为 done） */
	memoryState?: "pending" | "done";
	/** 自上次失效/整理以来累积的变更行数（达阈值触发失效，M5 新模型） */
	pendingMemoryLines?: number;
}

/** 已挂载内容段：1-based，闭区间（计划 §2.2） */
export interface Segment {
	start: number;
	end: number;
	text: string;
}

/** 记忆整理任务（M5 新模型：仅在新增批量整理时投递） */
export interface MemoryJob {
	pluginId: string;
	/** 当前用户消息（可能为空） */
	localContext: string;
	/** 主 Agent 对话尾部摘要（onContext 缓存，与文件挂载内容去重） */
	dialogueContext?: string;
}

/** 项目地图条目（计划 §6.2 模型输出 mapEntry / §6.3） */
export interface MapEntry {
	role: string;
	responsibilities: string[];
	keyStructures: string[];
	dependencies: string[];
	dependents: string[];
	decisions: string[];
}

import { render } from "../render.ts";
import type { MapEntry, ToolContextPlugin } from "../types.ts";

/**
 * 记忆 Agent（计划 §6.2）。
 * 通过注入的 complete 函数调 LLM，不碰密钥（实证：custom-compaction.ts:90-102 的
 * ctx.modelRegistry.complete(ctx.model, ...)）。
 * 输出严格 JSON；解析失败 → 返回 null，由调用方保留旧 memory 并记日志（绝不影响主流程）。
 *
 * 依赖用本地结构类型而非 import pi 内部类型（计划 §0：换宿主只需重写挂接层）。
 */

/** 记忆 Agent 的 LLM 依赖 */
export interface MemoryAgentDeps {
	complete: (
		model: unknown,
		context: {
			systemPrompt?: string;
			messages: { role: "user"; content: { type: "text"; text: string }[] }[];
		},
		options?: Record<string, unknown>,
	) => Promise<{ content: { type: string; text?: string }[]; usage?: MemoryUsage }>;
	model: unknown;
	/** P1-2：输出上限（配置记忆模型时 1024，限制输出成本） */
	maxTokens?: number;
}

/** 记忆调用 usage（complete 结果可选字段；缺失时调用方记提示） */
export interface MemoryUsage {
	input?: number;
	output?: number;
	totalTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** 模型要求输出的严格 JSON 形状（M5 新模型：整理产物只进 Project Map，整批一次调用） */
export interface MemoryOutput {
	entries?: Record<string, MapEntry>;
}

/** 批量整理的单文件输入：挂载插件 + 磁盘行（调用方渲染，渲染时点与调用方一致） */
export interface MemoryFileInput {
	plugin: ToolContextPlugin;
	lines: string[];
}

export const MEMORY_SYSTEM_PROMPT =
	`You are piwpi's project-map curator. A coding agent has just mounted several source files into its context. Define the identity of each listed file and record it in the project map.

You have NO external tools. Base your output ONLY on the inputs provided in the task:
1. each file's mounted content
2. the agent's recent conversation (deduplicated — tool results keep only their marker line, so they never overlap with the mounted content)
3. the existing project map entries (brief — for naming consistency)

Output ONE strict JSON object and nothing else:

{
  "entries": {
    "<pluginId>": {
      "role": "one-line identity of this file's role in the project",
      "responsibilities": ["concise responsibilities, 3-8 items"]
    }
  }
}

Rules:
- Output an entry for EVERY pluginId listed in the task, and for no other id.
- Use the language of the code comments / user message.
- Only include facts visible in the provided inputs. Never invent.
- Keep role and responsibilities short; the project map is a lightweight overview, not documentation.
- Do not wrap the JSON in markdown fences. Do not add any text outside the JSON.`.trim();

/**
 * 组装 LLM 输入（纯函数，可单测）。M5 新模型：整批一次调用，输入域严格限定为三段——
 * ① 各文件挂载内容 ② 主 Agent 对话尾部（去重）③ Project Map 精简列表。
 * 引用式：挂载内容由调用方传入磁盘行（lines）渲染，渲染时点与调用方一致。
 */
export function buildMemoryPrompt(
	files: MemoryFileInput[],
	localContext: string,
	dialogueContext: string,
	mapBrief: string,
): string {
	const out: string[] = [];
	out.push("# piwpi 记忆整理任务（批量身份定义）");
	out.push("待整理文件（pluginId → identity）：");
	for (const f of files) out.push(`- ${f.plugin.id} → ${f.plugin.source.identity}`);
	out.push(`当前用户消息：${localContext || "（无）"}`);
	out.push("");
	out.push("## 输入一：各文件挂载内容（确定性渲染）");
	for (const f of files) {
		out.push(`### ${f.plugin.id}`);
		out.push(render(f.plugin, f.lines));
		out.push("");
	}
	out.push("## 输入二：主 Agent 最近对话（已去重：工具结果仅保留标记行，与挂载内容不重叠）");
	out.push(dialogueContext || "（无）");
	out.push("");
	out.push("## 输入三：Project Map 已有条目（精简）");
	out.push(mapBrief || "（无）");
	out.push("");
	out.push("输出 entries JSON（key 为上述 pluginId），只输出一个 JSON 对象，不要输出任何其他内容。");
	return out.join("\n");
}

/** 解析模型输出为 MemoryOutput；任何不合法输入 → null（调用方保留现状，绝不影响主流程） */
export function parseMemoryJson(text: string): MemoryOutput | null {
	let cleaned = text.trim();
	const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	if (fence) cleaned = fence[1]!.trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned.slice(start, end + 1));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const obj = parsed as Record<string, unknown>;
	const raw = obj.entries;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const entries: Record<string, MapEntry> = {};
	for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!v || typeof v !== "object" || Array.isArray(v)) continue;
		const m = v as Record<string, unknown>;
		entries[id] = {
			role: typeof m.role === "string" && m.role.trim() ? m.role.trim() : "",
			responsibilities: Array.isArray(m.responsibilities)
				? m.responsibilities.filter((x): x is string => typeof x === "string")
				: [],
		};
	}
	return { entries };
}

/**
 * 执行一次批量记忆整理：调 LLM → 解析。不修改任何状态（写回由调用方负责）。
 * 返回 null 表示无可用结果（无模型 / LLM 调用失败 / JSON 解析失败）。
 * P1-1：options.signal 已 abort 时不再发起新调用（shutdown 超时中止语义）。
 */
export async function summarize(
	deps: MemoryAgentDeps,
	files: MemoryFileInput[],
	localContext: string,
	dialogueContext: string,
	mapBrief: string,
	options?: { signal?: AbortSignal },
): Promise<MemoryOutput | null> {
	if (!deps.model) return null;
	if (options?.signal?.aborted) return null; // 已中止：不发起新模型调用
	const prompt = buildMemoryPrompt(files, localContext, dialogueContext, mapBrief);
	try {
		const completeOptions: Record<string, unknown> = {};
		if (deps.maxTokens !== undefined) completeOptions.maxTokens = deps.maxTokens;
		if (options?.signal) completeOptions.signal = options.signal;
		const response = await deps.complete(deps.model, {
			systemPrompt: MEMORY_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
		}, completeOptions);
		const text = (response.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n")
			.trim();
		if (!text) return null;
		return parseMemoryJson(text);
	} catch (err) {
		console.error("[piwpi] memory LLM call failed:", err);
		return null;
	}
}

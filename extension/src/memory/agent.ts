import { render } from "../render.ts";
import type { MapEntry, MemoryJob, ToolContextPlugin } from "../types.ts";

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
	) => Promise<{ content: { type: string; text?: string }[] }>;
	model: unknown;
}

/** 模型要求输出的严格 JSON 形状（M5 新模型：整理产物只进 Project Map） */
export interface MemoryOutput {
	lifecycle?: "keep" | "shrink";
	mapEntry?: MapEntry;
}

export const MEMORY_SYSTEM_PROMPT =
	`You are piwpi's project-map curator. You define the identity of a source file that an agent has just mounted into its context, and record it in the project map.

You have NO external tools. Base your output ONLY on the three inputs provided in the task:
1. the file's mounted content
2. the agent's recent conversation (deduplicated — tool results keep only their marker line, so they never overlap with the mounted content)
3. the existing project map entries (brief — to infer dependencies/dependents and avoid redefining known files)

Output ONE strict JSON object and nothing else:

{
  "mapEntry": {
    "role": "one-line identity of this file's role in the project",
    "responsibilities": ["concise responsibilities, 3-8 items"],
    "keyStructures": ["class/function/module names defined here"],
    "dependencies": ["names of files/modules this file depends on — match existing map entries when possible"],
    "dependents": ["names of files/modules that depend on this file — infer from conversation and map"],
    "decisions": ["notable design decisions visible in this file"]
  },
  "lifecycle": "keep" | "shrink"
}

Rules:
- Use the language of the code comments / user message.
- Only include facts visible in the provided inputs. Never invent.
- Reference other files by the same names/paths used in the existing project map.
- Do not wrap the JSON in markdown fences. Do not add any text outside the JSON.`.trim();

/**
 * 组装 LLM 输入（纯函数，可单测）。M5 新模型：输入域严格限定为三段——
 * ① 该文件挂载内容 ② 主 Agent 对话尾部（去重）③ Project Map 精简列表。
 */
export function buildMemoryPrompt(plugin: ToolContextPlugin, job: MemoryJob, mapBrief: string): string {
	const lines: string[] = [];
	lines.push("# piwpi 记忆整理任务（首次身份定义）");
	lines.push(`文件：${plugin.source.identity}`);
	lines.push(`当前用户消息：${job.localContext || "（无）"}`);
	lines.push("");
	lines.push("## 输入一：该文件挂载内容（确定性渲染）");
	lines.push(render(plugin));
	lines.push("");
	lines.push("## 输入二：主 Agent 最近对话（已去重：工具结果仅保留标记行，与挂载内容不重叠）");
	lines.push(job.dialogueContext || "（无）");
	lines.push("");
	lines.push("## 输入三：Project Map 已有条目（精简，用于推断依赖/被依赖、避免重复定义）");
	lines.push(mapBrief || "（无）");
	lines.push("");
	lines.push("输出该文件的 Project Map 条目（mapEntry JSON），只输出一个 JSON 对象，不要输出任何其他内容。");
	return lines.join("\n");
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
	const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
	const strArr = (v: unknown): string[] | undefined =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
	const output: MemoryOutput = {};
	if (obj.lifecycle === "keep" || obj.lifecycle === "shrink") output.lifecycle = obj.lifecycle;
	if (obj.mapEntry && typeof obj.mapEntry === "object") {
		const m = obj.mapEntry as Record<string, unknown>;
		output.mapEntry = {
			role: str(m.role) ?? "",
			responsibilities: strArr(m.responsibilities) ?? [],
			keyStructures: strArr(m.keyStructures) ?? [],
			dependencies: strArr(m.dependencies) ?? [],
			dependents: strArr(m.dependents) ?? [],
			decisions: strArr(m.decisions) ?? [],
		};
	}
	return output;
}

/**
 * 执行一次记忆整理：调 LLM → 解析。不修改任何状态（写回由调用方负责）。
 * 返回 null 表示无可用结果（无模型 / LLM 调用失败 / JSON 解析失败）。
 */
export async function summarize(
	deps: MemoryAgentDeps,
	plugin: ToolContextPlugin,
	job: MemoryJob,
	mapBrief: string,
): Promise<MemoryOutput | null> {
	if (!deps.model) return null;
	const prompt = buildMemoryPrompt(plugin, job, mapBrief);
	try {
		const response = await deps.complete(deps.model, {
			systemPrompt: MEMORY_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
		});
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

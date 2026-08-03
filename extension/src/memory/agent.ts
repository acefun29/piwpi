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

/** 模型要求输出的严格 JSON 形状（计划 §6.2） */
export interface MemoryOutput {
	summary?: string;
	understanding?: string;
	relations?: string[];
	lifecycle?: "keep" | "shrink";
	mapEntry?: MapEntry;
}

export const MEMORY_SYSTEM_PROMPT = `You are piwpi's memory curator. You keep concise, durable memory of a source file that an agent is working with.

Read the mounted file content and the current user message, then output ONE strict JSON object and nothing else:

{
  "summary": "one or two sentences describing what this file does",
  "understanding": "current understanding of how it fits the task",
  "relations": ["related file or concept names"],
  "lifecycle": "keep" | "shrink",
  "mapEntry": {
    "role": "one-line role description",
    "responsibilities": ["..."],
    "keyStructures": ["class/function names"],
    "dependencies": ["names of things this file depends on"],
    "dependents": ["names of things that depend on this file"],
    "decisions": ["notable design decisions"]
  }
}

Rules:
- Use the language of the code comments / user message.
- Only include facts visible in the provided content. Never invent.
- If the file changed, update the summary and relations incrementally (keep prior knowledge).
- Do not wrap the JSON in markdown fences. Do not add any text outside the JSON.`.trim();

/** 组装 LLM 输入（纯函数，可单测） */
export function buildMemoryPrompt(plugin: ToolContextPlugin, job: MemoryJob): string {
	const lines: string[] = [];
	lines.push("# piwpi 记忆整理任务");
	lines.push(`当前用户消息：${job.localContext || "（无）"}`);
	lines.push("");
	lines.push("## 插件当前挂载内容（确定性渲染）");
	lines.push(render(plugin));
	if (job.oldHash && job.newHash) {
		lines.push("");
		lines.push(`## 文件变化\n文件哈希从 ${job.oldHash.slice(0, 8)} 变为 ${job.newHash.slice(0, 8)}，以上挂载内容已按新内容重切。`);
	}
	if (plugin.memory) {
		lines.push("");
		lines.push("## 旧记忆（增量更新，不要凭空重写）");
		lines.push(JSON.stringify(plugin.memory, null, 2));
	}
	lines.push("");
	lines.push("只输出一个 JSON 对象，不要输出任何其他内容。");
	return lines.join("\n");
}

/** 解析模型输出为 MemoryOutput；任何不合法输入 → null（调用方保留旧记忆） */
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
	const output: MemoryOutput = {
		summary: str(obj.summary),
		understanding: str(obj.understanding),
		relations: strArr(obj.relations),
	};
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
): Promise<MemoryOutput | null> {
	if (!deps.model) return null;
	const prompt = buildMemoryPrompt(plugin, job);
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

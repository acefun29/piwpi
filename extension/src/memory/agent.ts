import type { MemoryJob, ToolContextPlugin } from "../types.ts";

/**
 * 记忆 Agent（计划 §6.2，M5 实现）。
 * 通过 ctx.modelRegistry.complete(ctx.model, ...) 调 LLM，不碰密钥。
 * 输出严格 JSON；解析失败 → 丢弃本次结果、保留旧 memory、记日志。
 */
export const MEMORY_SYSTEM_PROMPT = `
// TODO(M5): 计划 §6.2 —— 记忆整理系统提示词（要求模型输出严格 JSON）
`.trim();

export function summarize(plugin: ToolContextPlugin, job: MemoryJob): Promise<void> {
	throw new Error("TODO(M5): 计划 §6.2");
}

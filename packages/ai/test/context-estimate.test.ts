import { describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { AssistantMessage, Context, Model, Tool, Usage } from "../src/types.ts";
import { estimateContextBreakdown, estimateContextTokens } from "../src/utils/estimate.ts";

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(timestamp: number, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "kept" }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 8_000,
};

describe("context token estimation", () => {
	it("ignores stale assistant usage after a newer message is inserted before it", () => {
		const context: Context = {
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "x".repeat(4_000), timestamp: 300 },
			],
		};

		expect(estimateContextTokens(context)).toEqual({
			tokens: 1_005,
			usageTokens: 0,
			trailingTokens: 1_005,
			lastUsageIndex: null,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(4_899);
	});

	it("uses assistant usage again after a response to the inserted context", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "new prompt", timestamp: 300 },
				createAssistant(400, 2_000),
				{ role: "user", content: "tail", timestamp: 500 },
			],
		};

		expect(estimateContextTokens(context)).toEqual({
			tokens: 2_001,
			usageTokens: 2_000,
			trailingTokens: 1,
			lastUsageIndex: 3,
		});
	});
});

describe("context breakdown estimation", () => {
	it("returns all zeros for an empty context", () => {
		expect(estimateContextBreakdown({ messages: [] })).toEqual({
			system: 0,
			tools: 0,
			user: 0,
			assistant: 0,
			thinking: 0,
			toolCalls: 0,
			toolResults: 0,
			images: 0,
			total: 0,
		});
	});

	it("buckets every message kind into its category", () => {
		const tools: Tool[] = [{ name: "read", description: "read a file", parameters: { type: "object" } }];
		const context: Context = {
			systemPrompt: "abcdabcd", // 8 chars → 2 tokens
			tools,
			messages: [
				{ role: "user", content: "aaaa", timestamp: 1 }, // 1
				{
					role: "user",
					content: [{ type: "image", data: "iVBOR", mimeType: "image/png" }],
					timestamp: 2,
				}, // 1200
				{
					role: "assistant",
					content: [
						{ type: "text", text: "bbbb" }, // 1
						{ type: "thinking", thinking: "cccc" }, // 1
						{ type: "toolCall", id: "call-1", name: "bash", arguments: { x: 1 } }, // 4 + 7 = 11 chars → 3
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: createUsage(0),
					stopReason: "stop",
					timestamp: 3,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "dddd" }], // 1
					isError: false,
					timestamp: 4,
				},
			],
		};

		const breakdown = estimateContextBreakdown(context);
		expect(breakdown.system).toBe(2);
		expect(breakdown.tools).toBeGreaterThan(0);
		expect(breakdown.user).toBe(1);
		expect(breakdown.assistant).toBe(1);
		expect(breakdown.thinking).toBe(1);
		expect(breakdown.toolCalls).toBe(3);
		expect(breakdown.toolResults).toBe(1);
		expect(breakdown.images).toBe(1200);
		expect(breakdown.total).toBe(
			breakdown.system +
				breakdown.tools +
				breakdown.user +
				breakdown.assistant +
				breakdown.thinking +
				breakdown.toolCalls +
				breakdown.toolResults +
				breakdown.images,
		);
	});

	it("treats string user content as text and counts image tokens per block", () => {
		const breakdown = estimateContextBreakdown({
			messages: [
				{ role: "user", content: "eeee", timestamp: 1 }, // 1
				{
					role: "toolResult",
					toolCallId: "call-2",
					toolName: "read",
					content: [
						{ type: "text", text: "ffff" }, // 1
						{ type: "image", data: "iVBOR", mimeType: "image/png" }, // 1200
					],
					isError: false,
					timestamp: 2,
				},
			],
		});

		expect(breakdown.user).toBe(1);
		expect(breakdown.toolResults).toBe(1);
		expect(breakdown.images).toBe(1200);
		expect(breakdown.total).toBe(1 + 1 + 1200);
	});
});

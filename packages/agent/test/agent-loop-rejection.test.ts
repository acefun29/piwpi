import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage, UserMessage } from "../src/types.ts";

/**
 * P2-4：agentLoop 内部拒绝（如 convertToLlm 抛错）→ 流必须终止，result() 不挂死。
 */
describe("agentLoop rejection handling (P2-4)", () => {
	function createModel(): Model<"openai-responses"> {
		return {
			id: "mock",
			name: "mock",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		};
	}

	function createUserMessage(text: string): UserMessage {
		return { role: "user", content: text, timestamp: Date.now() };
	}

	it("convertToLlm 抛错 → for-await 终止、result() resolve（不永久 pending）", async () => {
		const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
		const prompt: AgentMessage = createUserMessage("hi");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: () => {
				throw new Error("boom");
			},
		};
		const streamFn = vi.fn(() => {
			throw new Error("streamFn should not be reached");
		});

		const stream = agentLoop([prompt], context, config, undefined, streamFn);

		const events: string[] = [];
		for await (const event of stream) {
			events.push(event.type);
		}

		// 流已终止（迭代器不挂死）；result() 返回（值为 undefined——无消息可交付）
		const result = await stream.result();
		expect(events.length).toBeGreaterThanOrEqual(1); // agent_start 已发出
		expect(result).toBeUndefined();
		expect(streamFn).not.toHaveBeenCalled();
	});
});

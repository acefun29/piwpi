import { describe, expect, it } from "vitest";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

/**
 * P1-7：EventStream.end() 无 result（EOF 无终止事件）不得留下永久 pending 的 finalResult。
 */
describe("event-stream terminal semantics (P1-7)", () => {
	it("AssistantMessageEventStream.end() 无 result → result() resolve 为 aborted 终止消息", async () => {
		const stream = new AssistantMessageEventStream();
		stream.end();
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toContain("Stream ended without a terminal event");
	});

	it("end() 带 result → result() 返回该 result（既有语义不回退）", async () => {
		const stream = new AssistantMessageEventStream();
		const message = {
			role: "assistant" as const,
			content: [],
			api: "unknown",
			provider: "unknown",
			model: "unknown",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
		stream.end(message);
		expect(await stream.result()).toBe(message);
	});

	it("push(终止事件) 先行 → end() 无 result 不覆盖已 resolve 的结果", async () => {
		const stream = new AssistantMessageEventStream();
		const errorMessage = {
			role: "assistant" as const,
			content: [],
			api: "unknown",
			provider: "unknown",
			model: "unknown",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error" as const,
			errorMessage: "boom",
			timestamp: Date.now(),
		};
		stream.push({ type: "error", reason: "error", error: errorMessage });
		stream.end(); // 兜底：不应覆盖
		expect(await stream.result()).toBe(errorMessage);
	});

	it("end() 后 for-await 正常终止（迭代器不挂死）", async () => {
		const stream = new AssistantMessageEventStream();
		stream.push({
			type: "start",
			partial: { role: "assistant", content: [], stopReason: "pending", timestamp: 0 } as never,
		});
		stream.end();
		const seen: string[] = [];
		for await (const event of stream) {
			seen.push(event.type);
		}
		expect(seen).toEqual(["start"]);
	});
});

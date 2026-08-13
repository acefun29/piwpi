import type { Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { streamProxy } from "../src/proxy.ts";

/**
 * P1-7：streamProxy 远端 EOF（无终止事件）→ 消费者收到 error 事件、result() resolve（不挂死）。
 */
describe("streamProxy terminal semantics (P1-7)", () => {
	const model: Model<"openai-responses"> = {
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
	const context: Context = { systemPrompt: "s", messages: [], tools: [] };

	function sseResponse(chunks: string[]): Response {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const c of chunks) controller.enqueue(encoder.encode(c));
				controller.close(); // EOF：无 done/error 终止事件
			},
		});
		return new Response(stream, { status: 200 });
	}

	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("EOF 无终止事件 → for-await 收到 error 事件，result() resolve 为 error 消息", async () => {
		globalThis.fetch = vi.fn(async () =>
			sseResponse(['data: {"type":"start"}\n\n', 'data: {"type":"text_start","contentIndex":0}\n\n']),
		) as never;

		const stream = streamProxy(model, context, {
			authToken: "t",
			proxyUrl: "https://proxy.invalid",
		});

		const seen: string[] = [];
		for await (const event of stream) {
			seen.push(event.type);
		}
		expect(seen).toEqual(["start", "text_start", "error"]); // EOF 由 error 事件显式终止

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Connection closed without a terminal event");
	});
});

import { describe, expect, it } from "vitest";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { createHarness } from "../src/harness.ts";

/**
 * M0 冒烟测试：骨架可加载、handler 全部放行（与原生行为一致）。
 * 伪造事件对象的合法性：事件类型从 @earendil-works/pi-coding-agent import（计划 §7.1）。
 */

describe("harness skeleton (M0)", () => {
	it("createHarness 返回完整 handler 集合", () => {
		const h = createHarness();
		expect(typeof h.onToolCall).toBe("function");
		expect(typeof h.onToolResult).toBe("function");
		expect(typeof h.onContext).toBe("function");
		expect(typeof h.onSessionStart).toBe("function");
		expect(typeof h.shutdown).toBe("function");
	});

	it("onToolResult 返回 undefined（放行，不改内容）", async () => {
		const h = createHarness();
		const event = {
			type: "tool_result",
			toolName: "read",
			toolCallId: "t1",
			input: { path: "a.ts", offset: 1 },
			content: [{ type: "text", text: "hi" }],
			isError: false,
			details: undefined,
		} satisfies ToolResultEvent;
		const ctx = { cwd: process.cwd() } as unknown as ExtensionContext;
		expect(await h.onToolResult(event, ctx)).toBeUndefined();
	});

	it("onContext 返回 undefined（不动消息）", async () => {
		const h = createHarness();
		const event = { type: "context", messages: [] } satisfies ContextEvent;
		const ctx = { cwd: process.cwd() } as unknown as ExtensionContext;
		expect(await h.onContext(event, ctx)).toBeUndefined();
	});

	it("index 默认导出为工厂函数，且订阅 5 个事件", async () => {
		const mod = await import("../index.ts");
		expect(typeof mod.default).toBe("function");

		const subscribed: string[] = [];
		const pi = {
			on: (event: string) => {
				subscribed.push(event);
			},
		} as unknown as ExtensionAPI;
		mod.default(pi);

		expect(subscribed).toEqual([
			"tool_call",
			"tool_result",
			"context",
			"session_start",
			"session_shutdown",
		]);
	});
});

/**
 * piwpi e2e（计划 §7.2 验收清单 + §7.3 token 对比实验）。
 *
 * 基建：pi 测试 harness（test/test-harness.ts 的 createHarnessWithExtensions），
 * faux provider 以声明式响应序列驱动完整 AgentSession（真实工具执行、真实扩展运行时）。
 *
 * 注意：扩展是"纯类型依赖" pi-coding-agent（import type 全部擦除），运行时只依赖 node 内置模块，
 * 因此可直接从 extension/ 源码加载工厂，无需构建。
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import piwpiFactory from "../../../extension/index.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { createHarness, createHarnessWithExtensions, type Harness } from "./test-harness.ts";

const FACTORY = { factory: piwpiFactory as ExtensionFactory, path: "piwpi" };

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

function fileLines(n: number): string {
	return Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n");
}

function textOf(msg: { content: unknown[] }): string {
	return msg.content
		.filter(
			(c): c is TextContent =>
				typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
		)
		.map((c) => c.text)
		.join("\n");
}

describe("piwpi e2e（计划 §7.2 验收）", () => {
	it("验收 #1：读 20-40 再读 30-60 → 第二次实际执行 41-60，LLM 收到短引用+新增文本", async () => {
		harness = await createHarnessWithExtensions({
			responses: [
				{ toolCalls: [{ name: "read", args: { path: "a.ts", offset: 20, limit: 21 } }] },
				{ toolCalls: [{ name: "read", args: { path: "a.ts", offset: 30, limit: 31 } }] },
				"done",
			],
			extensionFactories: [FACTORY],
		});
		writeFileSync(join(harness.tempDir, "a.ts"), fileLines(100));
		await harness.session.prompt("read a.ts lines 20-40 and then 30-60");

		expect(harness.faux.callCount).toBe(3);
		const toolResults = harness.faux.contexts[2]!.messages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(2);

		// 第一次 read：原生全文保留（该消息即锚点）
		const first = textOf(toolResults[0]!);
		expect(first).toContain("line20");
		expect(first).toContain("line40");
		expect(first).not.toContain("[piwpi:");

		// 第二次 read：参数被改写为 41-60 执行，结果替换为短引用 + 新增文本
		const second = textOf(toolResults[1]!);
		expect(second).toContain("[piwpi:");
		expect(second).toContain("已挂载 L20-60，本次新增 L41-60");
		expect(second).toContain("line41");
		expect(second).toContain("line60");
	});

	it("验收 #2：读已全覆盖范围 → 参数不改，结果为无变化短引用（不重复挂载）", async () => {
		harness = await createHarnessWithExtensions({
			responses: [
				{ toolCalls: [{ name: "read", args: { path: "a.ts", offset: 20, limit: 41 } }] },
				{ toolCalls: [{ name: "read", args: { path: "a.ts", offset: 30, limit: 21 } }] },
				"done",
			],
			extensionFactories: [FACTORY],
		});
		writeFileSync(join(harness.tempDir, "a.ts"), fileLines(100));
		await harness.session.prompt("read a.ts");

		const toolResults = harness.faux.contexts[2]!.messages.filter((m) => m.role === "toolResult");
		const second = textOf(toolResults[1]!);
		expect(second).toContain("内容无变化");
		expect(second).toContain("L20-60");
		expect(second).not.toContain("line30"); // 未重复挂载文件文本
	});

	it("验收 #3：改文件后再读 → 重挂载标记、短引用返回（记忆 job 静默跳过：无模型）", async () => {
		harness = await createHarnessWithExtensions({
			responses: [
				{ toolCalls: [{ name: "read", args: { path: "a.ts", offset: 20, limit: 21 } }] },
				{ toolCalls: [{ name: "read", args: { path: "a.ts", offset: 30, limit: 21 } }] },
				"done",
				{ toolCalls: [{ name: "read", args: { path: "a.ts", offset: 30, limit: 21 } }] },
				"done",
			],
			extensionFactories: [FACTORY],
		});
		writeFileSync(join(harness.tempDir, "a.ts"), fileLines(100));
		await harness.session.prompt("read a.ts"); // read 20-40 → read 30-50 → done
		appendFileSync(join(harness.tempDir, "a.ts"), "\nline101"); // 文件变化
		await harness.session.prompt("file changed, read again"); // read 30-50 → updated → done

		const lastContext = harness.faux.contexts[harness.faux.contexts.length - 1]!;
		const toolResults = lastContext.messages.filter((m) => m.role === "toolResult");
		const last = textOf(toolResults[toolResults.length - 1]!);
		expect(last).toContain("内容已变化，插件已重挂载");
	});

	it("验收 #6：Harness 抛错注入等价场景——文件不存在 → read 行为与原生一致", async () => {
		harness = await createHarnessWithExtensions({
			responses: [{ toolCalls: [{ name: "read", args: { path: "missing.ts", offset: 1 } }] }, "done"],
			extensionFactories: [FACTORY],
		});
		await harness.session.prompt("read missing.ts");

		const toolResults = harness.faux.contexts[1]!.messages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(textOf(toolResults[0]!)).not.toContain("[piwpi:"); // 原生错误透传
	});
});

describe("piwpi e2e（计划 §7.3 token 对比实验，红线）", () => {
	async function runScenario(
		withPiwpi: boolean,
	): Promise<{ requestBytesFromSecond: number; total: number }> {
		const responses = [
			{ toolCalls: [{ name: "read", args: { path: "a.ts", offset: 1, limit: 2000 } }] },
			{ toolCalls: [{ name: "read", args: { path: "a.ts", offset: 1, limit: 2000 } }] },
			{ toolCalls: [{ name: "read", args: { path: "a.ts", offset: 1, limit: 2000 } }] },
			"done",
		];
		const h = withPiwpi
			? await createHarnessWithExtensions({ responses, extensionFactories: [FACTORY] })
			: await createHarness({ responses });
		writeFileSync(join(h.tempDir, "a.ts"), fileLines(2000));
		await h.session.prompt("read a.ts");
		const contexts = h.faux.contexts;
		// "第二次起请求体量"：从第 2 次请求开始，每次请求 messages 的字符量之和
		const requestBytesFromSecond = contexts
			.slice(1)
			.reduce((acc, ctx) => acc + JSON.stringify(ctx.messages).length, 0);
		const total = JSON.stringify(contexts).length;
		h.cleanup();
		return { requestBytesFromSecond, total };
	}

	it("第二次起请求体量必须显著小于 off 组（on/off 各跑一次）", async () => {
		const off = await runScenario(false);
		const on = await runScenario(true);

		// 红线（计划 §7.3）：第二次起请求体量显著小于 off 组。off 组每次重读携带全量 2000 行文本，
		// on 组第 2、3 次 read 全部命中已挂载范围 → 只携带几十字节的 noop 短引用。
		console.log(
			`[piwpi-token] requestBytesFromSecond on=${on.requestBytesFromSecond} off=${off.requestBytesFromSecond}`,
		);
		console.log(`[piwpi-token] total contexts on=${on.total} off=${off.total}`);
		expect(on.requestBytesFromSecond).toBeLessThan(off.requestBytesFromSecond);
		expect(on.requestBytesFromSecond / off.requestBytesFromSecond).toBeLessThan(0.7);

		// 全量请求体量（含首次全量读与系统提示的公共基数）也须更小
		expect(on.total).toBeLessThan(off.total);
	});
});

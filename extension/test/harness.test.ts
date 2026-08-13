import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	ToolCallEvent,
	ToolResultEvent,
	TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness } from "../src/harness.ts";
import { hashBuffer } from "../src/hash.ts";
import { CUSTOM_ENTRY_TYPE, projectMapFilePath, serializePlugin } from "../src/memory/persist.ts";
import { ProjectMap } from "../src/memory/project-map.ts";
import { MemoryQueue } from "../src/memory/queue.ts";
import { render } from "../src/render.ts";
import { PluginStore } from "../src/store.ts";
import type { Segment, SourcePluginMeta, ToolContextPlugin } from "../src/types.ts";

/**
 * Harness 集成测试（M3/M4/M5）：用真实 tmp 文件 + 伪造事件对象驱动 handler。
 * 伪造事件对象的合法性：事件类型从 @earendil-works/pi-coding-agent import（计划 §7.1）。
 */

let tmp: string;
const FILE = "a.ts";
let absFile: string;

function lines(n: number): string {
	return Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n");
}
/** 总行数 total 的文件中取 [start, end]（1-based 闭区间）文本 */
function sliceOf(total: number, start: number, end: number): string {
	return lines(total)
		.split("\n")
		.slice(start - 1, end)
		.join("\n");
}
const sliceTextOf = (start: number, end: number) => sliceOf(80, start, end);

const text20_40 = sliceTextOf(20, 40);
const text41_60 = sliceTextOf(41, 60);
const text20_60 = sliceTextOf(20, 60);

const fileId = (p: string) => `source:file:${process.platform === "win32" ? p.toLowerCase() : p}`;

beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "piwpi-harness-"));
	absFile = join(tmp, FILE);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function ctx(): ExtensionContext {
	return { cwd: tmp } as unknown as ExtensionContext;
}

function readCall(toolCallId: string, input: Record<string, unknown>): ToolCallEvent {
	return { type: "tool_call", toolName: "read", toolCallId, input } as unknown as ToolCallEvent;
}

function readResult(
	toolCallId: string,
	input: Record<string, unknown>,
	over: { text?: string; isError?: boolean; truncation?: Partial<TruncationResult> } = {},
): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "read",
		toolCallId,
		input,
		content: [{ type: "text", text: over.text ?? "" }],
		isError: over.isError ?? false,
		details: over.truncation ? { truncation: over.truncation } : undefined,
	} as unknown as ToolResultEvent;
}

function sourceMeta(p: ToolContextPlugin): SourcePluginMeta {
	return p.metadata as unknown as SourcePluginMeta;
}

function write80Lines(): void {
	writeFileSync(absFile, lines(80));
}

describe("M3 §4.2/§4.3：拦截与增量读取", () => {
	it("首次 read：不改参数、保留全文（锚点），插件入库", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });

		const call = readCall("t1", { path: FILE, offset: 20, limit: 21 });
		await h.onToolCall(call, ctx());
		expect(call.input).toEqual({ path: FILE, offset: 20, limit: 21 }); // 首次不改参数

		const res = await h.onToolResult(
			readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }),
			ctx(),
		);
		expect(res).toBeUndefined(); // 锚点保留全文

		const p = store.get(fileId(absFile));
		expect(p).toBeDefined();
		expect(sourceMeta(p!).segments).toEqual([{ start: 20, end: 40 }]);
		expect(sourceMeta(p!).anchorToolCallId).toBe("t1");
		expect(sourceMeta(p!).memoryState).toBe("pending"); // M5 新模型：新挂载标记 pending
	});

	it("增量 read：参数被改写为缺失段，结果替换为短引用+新文本", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());

		const call = readCall("t2", { path: FILE, offset: 30, limit: 31 }); // 请求 30-60
		await h.onToolCall(call, ctx());
		expect((call.input as { offset?: number }).offset).toBe(41); // 只补缺失段 41-60
		expect((call.input as { limit?: number }).limit).toBe(20);

		const res = await h.onToolResult(
			readResult("t2", { path: FILE, offset: 41, limit: 20 }, { text: text41_60 }),
			ctx(),
		);
		expect(res?.content?.[0]?.text).toContain("已挂载 L20-60，本次新增 L41-60");
		expect(res?.content?.[0]?.text).toContain(text41_60);

		const p = store.get(fileId(absFile))!;
		expect(sourceMeta(p).segments).toEqual([{ start: 20, end: 60 }]);
		expect(sourceMeta(p).anchorToolCallId).toBe("t1"); // anchor 不变
	});

	it("全覆盖 read：参数不改，结果替换为无变化短引用", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 41 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 41 }, { text: text20_60 }), ctx());

		const call = readCall("t2", { path: FILE, offset: 30, limit: 21 }); // 30-50 已覆盖
		await h.onToolCall(call, ctx());
		expect((call.input as { offset?: number }).offset).toBe(30); // 参数未被改写

		const res = await h.onToolResult(
			readResult("t2", { path: FILE, offset: 30, limit: 21 }, { text: text20_40 }),
			ctx(),
		);
		expect(res?.content?.[0]?.text).toContain("内容无变化");
		expect(res?.content?.[0]?.text).toContain("L20-60");
	});

	it("截断 read：got 按 truncation.outputLines 精确推算", async () => {
		writeFileSync(absFile, lines(5000));
		const store = new PluginStore();
		const h = createHarness({ store });

		await h.onToolCall(readCall("t1", { path: FILE, offset: 1 }), ctx()); // 无 limit → 全文件
		const res = await h.onToolResult(
			readResult(
				"t1",
				{ path: FILE, offset: 1 },
				{
					text: `${sliceOf(5000, 1, 2000)}\n\n[Showing lines 1-2000 of 5000. Use offset=2001 to continue.]`,
					truncation: {
						outputLines: 2000,
						totalLines: 5000,
						truncated: true,
						truncatedBy: "lines",
						firstLineExceedsLimit: false,
					},
				},
			),
			ctx(),
		);
		expect(res).toBeUndefined();
		const p = store.get(fileId(absFile))!;
		expect(sourceMeta(p).segments).toEqual([{ start: 1, end: 2000 }]);
	});

	it("firstLineExceedsLimit → 不挂载（原生透传）", async () => {
		writeFileSync(absFile, lines(80));
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 1 }), ctx());
		const res = await h.onToolResult(
			readResult("t1", { path: FILE, offset: 1 }, { truncation: { firstLineExceedsLimit: true, outputLines: 0 } }),
			ctx(),
		);
		expect(res).toBeUndefined();
		expect(store.all()).toHaveLength(0);
	});

	it("并行两次首次 read：后到者转 increment，anchor 先到先得（计划 §4.3）", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("p1", { path: FILE, offset: 1, limit: 10 }), ctx());
		await h.onToolCall(readCall("p2", { path: FILE, offset: 50, limit: 10 }), ctx());
		const r1 = await h.onToolResult(
			readResult("p1", { path: FILE, offset: 1, limit: 10 }, { text: sliceTextOf(1, 10) }),
			ctx(),
		);
		expect(r1).toBeUndefined();
		const r2 = await h.onToolResult(
			readResult("p2", { path: FILE, offset: 50, limit: 10 }, { text: sliceTextOf(50, 59) }),
			ctx(),
		);
		expect(r2?.content?.[0]?.text).toContain("本次新增 L50-59");
		const p = store.get(fileId(absFile))!;
		expect(sourceMeta(p).anchorToolCallId).toBe("p1");
		expect(sourceMeta(p).segments).toEqual([
			{ start: 1, end: 10 },
			{ start: 50, end: 59 },
		]);
	});
});

describe("M3 §4.4 / P0-1：历史不可变 + 尾部增量", () => {
	it("磁盘变化后：历史锚点消息逐字节不变，delta 追加到最后一条消息（含当前内容、无时间戳）", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());

		// 磁盘变为 100 行（hash 变化；已挂载段 L20-40 内容未变 → 走小改重挂载路径，锚点历史文本不变）
		writeFileSync(absFile, lines(100));

		const messages = [
			{ role: "user", content: [{ type: "text", text: "继续" }] },
			{ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "ORIGINAL" }] },
		] as unknown as ContextEvent["messages"];
		const ev = { type: "context", messages } as unknown as ContextEvent;
		const r = await h.onContext(ev, ctx());
		expect(r).toBeDefined();
		expect(r!.messages).toHaveLength(2);
		// 历史消息原样透传：同一对象引用（不可变断言）
		expect(r!.messages![0]).toBe(messages[0]);
		// 最后一条是副本：原对象未被改写
		expect(r!.messages![1]).not.toBe(messages[1]);
		expect((messages[1] as unknown as { content: { type: string; text?: string }[] }).content[0]!.text).toBe(
			"ORIGINAL",
		);
		const last = r!.messages![1] as unknown as { content: { type: string; text?: string }[] };
		expect(last.content[0]!.text).toBe("ORIGINAL");
		const deltaText = last.content[1]!.text!;
		expect(deltaText).toContain("[piwpi 挂载更新]");
		expect(deltaText).toContain("内容已变化");
		expect(deltaText).toContain(hashBuffer(readFileSync(absFile))); // 当前完整 hash
		expect(deltaText).toContain("line20"); // 当前内容（新正文）
		expect(deltaText).not.toMatch(/\d{4}-\d{2}-\d{2}/); // 无时间戳（确定性）

		// 确定性：相同状态第二次调用 → delta 逐字节相同
		const r2 = await h.onContext({ type: "context", messages } as unknown as ContextEvent, ctx());
		const last2 = r2!.messages![1] as unknown as { content: { type: string; text?: string }[] };
		expect(last2.content[1]!.text).toBe(deltaText);
	});

	it("磁盘未变化 → delta 为空，不返回 messages（模型视图 = 纯历史）", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());

		const messages = [
			{ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "ORIGINAL" }] },
		] as unknown as ContextEvent["messages"];
		const r = await h.onContext({ type: "context", messages } as unknown as ContextEvent, ctx());
		expect(r).toBeUndefined(); // 无变化挂载 → 不追加任何内容
		expect(messages).toHaveLength(1); // 输入未被改动
	});

	it("文件删除 → delta 含「文件已删除，挂载失效」，挂载从 store 移除", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
		expect(store.get(fileId(absFile))).toBeDefined();

		rmSync(absFile); // 外部删除
		const messages = [
			{ role: "user", content: [{ type: "text", text: "继续" }] },
		] as unknown as ContextEvent["messages"];
		const r = await h.onContext({ type: "context", messages } as unknown as ContextEvent, ctx());
		expect(r).toBeDefined();
		expect(store.get(fileId(absFile))).toBeUndefined(); // 挂载已失效
		const last = r!.messages![0] as unknown as { content: { type: string; text?: string }[] };
		const deltaText = last.content[1]!.text!;
		expect(deltaText).toContain("文件已删除，挂载失效");
	});

	it("锚点缺失（被压缩）→ 跳过，不抛错", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		] as unknown as ContextEvent["messages"];
		const ev = { type: "context", messages } as unknown as ContextEvent;
		await expect(h.onContext(ev, ctx())).resolves.toBeUndefined();
	});
});

describe("M4 §5 / M5 新模型：文件变化（updated 分支）", () => {
	it("小改（不影响已挂载段）：正常重挂载，变更量 0，不触发记忆", async () => {
		write80Lines();
		const store = new PluginStore();
		const complete = vi.fn(
			async (_model: unknown, _context: { messages: { content: { type: string; text?: string }[] }[] }) => ({
				content: [{ type: "text", text: "" }],
			}),
		);
		const h = createHarness({
			store,
			queue: new MemoryQueue(0),
			memoryDeps: { complete, model: { provider: "faux" } },
		});
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
		const oldHash = sourceMeta(store.get(fileId(absFile))!).hash;

		appendFileSync(absFile, "\nline81"); // 尾部追加 1 行：已挂载段 [20,40] 内容不变 → 变更量 0
		const call = readCall("t2", { path: FILE, offset: 30, limit: 21 });
		await h.onToolCall(call, ctx());
		expect((call.input as { offset?: number }).offset).toBe(30); // updated 不改参数

		const res = await h.onToolResult(
			readResult("t2", { path: FILE, offset: 30, limit: 21 }, { text: sliceTextOf(30, 50) }),
			ctx(),
		);
		expect(res?.content?.[0]?.text).toContain("内容已变化，插件已重挂载");

		const p = store.get(fileId(absFile))!;
		const meta = sourceMeta(p);
		expect(meta.hash).toBe(hashBuffer(readFileSync(absFile)));
		expect(meta.hash).not.toBe(oldHash);
		// 旧范围 20-40 clamp 到新磁盘 + 本次 30-50 → 合并 20-50
		const merged = meta.segments.map((s) => `${s.start}-${s.end}`).join(",");
		expect(merged).toBe("20-50");
		expect(meta.updatedAtHashChange).toBe(true);
		// 尾部追加不影响已挂载段 → 变更量 0，不触发记忆（pendingMemoryLines 保持 0）
		expect(complete).not.toHaveBeenCalled();
		expect((meta.pendingMemoryLines as number | undefined) ?? 0).toBe(0);
	});

	it("修改累计达阈值（max(8, 总行数×10%)）→ 挂载失效 + 原生透传（map 条目保留，由磁盘驱动校验软删）", async () => {
		write80Lines();
		const store = new PluginStore();
		const projectMap = new ProjectMap();
		projectMap.update(fileId(absFile), {
			role: "旧角色",
			responsibilities: [],
		});
		const events: string[] = [];
		const h = createHarness({ store, projectMap, onEvent: (e) => events.push(e.type) });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 41 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 41 }, { text: text20_60 }), ctx());
		expect(sourceMeta(store.get(fileId(absFile))!).memoryState).toBe("pending"); // 新挂载标记 pending

		// 大幅修改（50 行 > 阈值 max(8, 100×10%)=10）
		const big = Array.from({ length: 100 }, (_, i) => `new${i + 1}`).join("\n");
		writeFileSync(absFile, big);
		const call = readCall("t2", { path: FILE, offset: 20, limit: 41 });
		await h.onToolCall(call, ctx());
		const res = await h.onToolResult(
			readResult("t2", { path: FILE, offset: 20, limit: 41 }, { text: big.split("\n").slice(19, 60).join("\n") }),
			ctx(),
		);
		expect(res?.content?.[0]?.text).toContain("挂载已失效"); // 失效提示行（替换原生透传）
		expect(store.get(fileId(absFile))).toBeUndefined(); // 挂载失效
		expect(projectMap.get(fileId(absFile))).toBeDefined(); // map 条目保留：失效不归会话管理，由磁盘驱动校验软删
		expect(events).toContain("invalidated");
	});

	it("已挂载段内的小改：变更量累积（替换 1 行 = 2），未达阈值前不失效，累积达标后失效", async () => {
		write80Lines();
		const store = new PluginStore();
		const projectMap = new ProjectMap();
		const h = createHarness({ store, projectMap });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());

		// 每次替换已挂载段内 1 行（added+removed = 2），阈值 max(8, 80×10%)=8
		const edits: Array<[number, string]> = [
			[24, "x"],
			[29, "y"],
			[34, "z"],
			[37, "w"],
		];
		for (const [idx, val] of edits) {
			// 在当前磁盘内容上累积修改（每次只变 1 行）
			const disk = readFileSync(absFile, "utf8").split("\n");
			disk[idx] = val;
			writeFileSync(absFile, disk.join("\n"));
			const call = readCall(`t${idx}`, { path: FILE, offset: 20, limit: 21 });
			await h.onToolCall(call, ctx());
			const res = await h.onToolResult(
				readResult(`t${idx}`, { path: FILE, offset: 20, limit: 21 }, { text: disk.slice(19, 40).join("\n") }),
				ctx(),
			);
			const plugin = store.get(fileId(absFile));
			if (!plugin) {
				// 达阈值 → 已失效：失效提示行 + map 删除
				expect(res?.content?.[0]?.text).toContain("挂载已失效");
				expect(projectMap.get(fileId(absFile))).toBeUndefined();
				continue;
			}
			const accumulated = (sourceMeta(plugin).pendingMemoryLines as number | undefined) ?? 0;
			expect(accumulated).toBeLessThan(8);
			expect(res?.content?.[0]?.text).toContain("内容已变化，插件已重挂载");
		}
		// 4 次替换 → 累积 8 ≥ 8 → 最终失效
		expect(store.get(fileId(absFile))).toBeUndefined();
		expect(projectMap.get(fileId(absFile))).toBeUndefined();
	});

	it("文件小幅变短：段被 clamp，render 带 truncated 提示（不失效）", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 61 }), ctx());
		await h.onToolResult(
			readResult("t1", { path: FILE, offset: 20, limit: 61 }, { text: sliceTextOf(20, 80) }),
			ctx(),
		);

		writeFileSync(absFile, lines(75)); // 缩短 5 行：已挂载段 [20,80] clamp 到 [20,75]，变更量 5 < 阈值 8 → 不失效
		await h.onToolCall(readCall("t2", { path: FILE, offset: 10, limit: 11 }), ctx());
		await h.onToolResult(
			readResult("t2", { path: FILE, offset: 10, limit: 11 }, { text: sliceOf(75, 10, 20) }),
			ctx(),
		);

		const p = store.get(fileId(absFile))!;
		const meta = sourceMeta(p);
		expect(meta.truncatedNote).toBe("[truncated: file shrank to 75 lines]");
		for (const s of meta.segments) {
			expect(s.end).toBeLessThanOrEqual(75);
		}
		expect(render(p, readFileSync(absFile, "utf8").split("\n"))).toContain(meta.truncatedNote!);
		expect(store.get(fileId(absFile))).toBeDefined(); // 小缩短不失效
	});

	it("onContext 主动扫描：外部大改（超阈值）→ 失效（无需下一次 read）", async () => {
		write80Lines();
		const store = new PluginStore();
		const projectMap = new ProjectMap();
		projectMap.update(fileId(absFile), {
			role: "旧角色",
			responsibilities: [],
		});
		const events: string[] = [];
		const h = createHarness({ store, projectMap, onEvent: (e) => events.push(e.type) });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 41 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 41 }, { text: text20_60 }), ctx());
		expect(store.get(fileId(absFile))).toBeDefined();

		// 外部大改：重写整个文件（已挂载段全变）
		const big = Array.from({ length: 80 }, (_, i) => `new${i + 1}`).join("\n");
		writeFileSync(absFile, big);

		// 只触发 onContext（不 read）
		const messages = [
			{ role: "user", content: [{ type: "text", text: "继续" }] },
		] as unknown as ContextEvent["messages"];
		await h.onContext({ type: "context", messages } as unknown as ContextEvent, ctx());
		expect(store.get(fileId(absFile))).toBeUndefined();
		expect(projectMap.get(fileId(absFile))).toBeDefined(); // map 条目保留：失效不归会话管理，由磁盘驱动校验软删
		expect(events).toContain("invalidated");
	});

	it("onContext 主动扫描：小改 → 主动重挂载 + 累积，hash 更新，后续 read 走 increment", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());

		// 外部改已挂载段内 2 行（替换 2 行 = changed 4 < 阈值 8）
		const disk = readFileSync(absFile, "utf8").split("\n");
		disk[24] = "x";
		disk[29] = "y";
		writeFileSync(absFile, disk.join("\n"));

		await h.onContext(
			{
				type: "context",
				messages: [{ role: "user", content: [{ type: "text", text: "继续" }] }],
			} as unknown as ContextEvent,
			ctx(),
		);

		const p = store.get(fileId(absFile))!;
		const meta = sourceMeta(p);
		expect(meta.hash).toBe(hashBuffer(readFileSync(absFile))); // 已更新为磁盘值
		expect(meta.pendingMemoryLines).toBe(4); // 累积

		// 后续 read：hash 一致 → 走 increment（只补缺失段 41-50）
		const call = readCall("t2", { path: FILE, offset: 30, limit: 21 });
		await h.onToolCall(call, ctx());
		expect((call.input as { offset?: number }).offset).toBe(41);
	});
});

describe("M5 新模型：记忆批量整理与持久化", () => {
	it("新文件挂载 → 计数达标 → 批量整理：entries 写 project map、memoryState 置 done、custom entry 写入", async () => {
		write80Lines();
		const store = new PluginStore();
		const dataDir = join(tmp, "agent");
		const complete = vi.fn(
			async (_model: unknown, _context: { messages: { content: { type: string; text?: string }[] }[] }) => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							entries: {
								[fileId(absFile)]: { role: "auth", responsibilities: ["jwt"] },
							},
						}),
					},
				],
			}),
		);
		const written: Array<[string, unknown]> = [];
		const h = createHarness({
			store,
			queue: new MemoryQueue(0),
			dataDir,
			cwd: tmp,
			memoryDeps: { complete, model: { provider: "faux", model: "faux-1" } },
			memoryBatchFiles: 1, // 注入小阈值：1 个文件即触发批量整理
			customEntryWriter: (t, d) => {
				written.push([t, d]);
				return "id";
			},
		});
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());

		// 批量整理经队列串行链执行 → flush 等待完成
		await h.shutdown();

		const p = store.get(fileId(absFile))!;
		expect(sourceMeta(p).memoryState).toBe("done");
		expect(complete).toHaveBeenCalledTimes(1);
		// 整理 prompt 含三段输入
		const prompt = complete.mock.calls[0]![1]!.messages[0]!.content[0]!.text ?? "";
		expect(prompt).toContain("输入一：各文件挂载内容");
		expect(prompt).toContain("输入二：主 Agent 最近对话");
		expect(prompt).toContain("输入三：Project Map 已有条目");

		expect(written.length).toBeGreaterThan(0);
		const persisted = written[written.length - 1]![1] as { plugin: ToolContextPlugin };
		// 引用式：持久化只含范围，不含文本字段
		const segs = persisted.plugin.metadata as unknown as { segments: Segment[] };
		expect(segs.segments.every((s) => !("text" in s))).toBe(true);

		const mapFile = projectMapFilePath(dataDir);
		expect(existsSync(mapFile)).toBe(true);
		const mapData = JSON.parse(readFileSync(mapFile, "utf8")) as Record<string, { role: string }>;
		expect(mapData[fileId(absFile)]?.role).toBe("auth");
	});

	it("两个 pending 文件 → 整批一次 LLM 调用；未知 pluginId 被忽略、真实文件按各自条目落库", async () => {
		write80Lines();
		const absFile2 = join(tmp, "b.ts");
		writeFileSync(absFile2, lines(80));
		const store = new PluginStore();
		const projectMap = new ProjectMap();
		const complete = vi.fn(
			async (_model: unknown, _context: { messages: { content: { type: string; text?: string }[] }[] }) => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							entries: {
								[fileId(absFile)]: { role: "auth", responsibilities: ["jwt"] },
								[fileId(absFile2)]: { role: "队列", responsibilities: ["串行"] },
								"source:file:unknown": { role: "编造", responsibilities: [] },
							},
						}),
					},
				],
			}),
		);
		const h = createHarness({
			store,
			projectMap,
			queue: new MemoryQueue(0),
			cwd: tmp,
			memoryDeps: { complete, model: { provider: "faux" } },
			memoryBatchFiles: 2, // 两个 pending 文件同时达阈值 → 只调一次 LLM
		});
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
		await h.onToolCall(readCall("t2", { path: "b.ts", offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t2", { path: "b.ts", offset: 20, limit: 21 }, { text: text20_40 }), ctx());

		await h.shutdown(); // flush 批量整理链

		expect(complete).toHaveBeenCalledTimes(1); // 整批一次，而非逐文件 N 次
		expect(sourceMeta(store.get(fileId(absFile))!).memoryState).toBe("done");
		expect(sourceMeta(store.get(fileId(absFile2))!).memoryState).toBe("done");
		expect(projectMap.get(fileId(absFile))?.role).toBe("auth");
		expect(projectMap.get(fileId(absFile2))?.role).toBe("队列");
		expect(projectMap.get("source:file:unknown")).toBeUndefined(); // 编造 id 被忽略
	});

	it("agent_settled 阈值递减：未达阈值的小量 pending 在有限轮数内攒批触发（非每轮一次）", async () => {
		write80Lines();
		const store = new PluginStore();
		const projectMap = new ProjectMap();
		const queue = new MemoryQueue(0);
		const complete = vi.fn(
			async (_model: unknown, _context: { messages: { content: { type: string; text?: string }[] }[] }) => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							entries: {
								[fileId(absFile)]: { role: "auth", responsibilities: ["jwt"] },
							},
						}),
					},
				],
			}),
		);
		const h = createHarness({
			store,
			projectMap,
			queue,
			cwd: tmp,
			memoryDeps: { complete, model: { provider: "faux" } },
			// memoryBatchFiles 保持默认 5：1 个 pending 不触发挂载路径，靠 settled 逐轮递减（5→1）触发
		});
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());

		// 未达阈值：批量整理尚未排队
		expect(sourceMeta(store.get(fileId(absFile))!).memoryState).toBe("pending");

		// 前 3 轮 settled：阈值 5→4→3→2，pending=1 未达标 → 不调用 LLM（攒批，不每轮整理）
		h.onAgentSettled();
		h.onAgentSettled();
		h.onAgentSettled();
		await queue.flush();
		expect(complete).not.toHaveBeenCalled();
		expect(sourceMeta(store.get(fileId(absFile))!).memoryState).toBe("pending");

		// 第 4 轮 settled：阈值降到 1 → 触发，整批一次调用
		h.onAgentSettled();
		await queue.flush();
		expect(complete).toHaveBeenCalledTimes(1);
		expect(sourceMeta(store.get(fileId(absFile))!).memoryState).toBe("done");
		expect(projectMap.get(fileId(absFile))?.role).toBe("auth");
		expect(projectMap.get(fileId(absFile))?.responsibilities).toEqual(["jwt"]);

		// 触发后已重置；无 pending 时后续 settled 直接返回（幂等，无副作用）
		h.onAgentSettled();
		await queue.flush();
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("批量整理无模型 → memory_skipped，pending 保留（下次触发再试）", async () => {
		write80Lines();
		const store = new PluginStore();
		const events: string[] = [];
		const prevEnv = process.env.PIWPI_MEMORY_MODEL;
		process.env.PIWPI_MEMORY_MODEL = "faux/faux-1"; // P1-2：配置记忆模型 → 自动路径放行，缺 complete 通道 → memory_skipped
		try {
			const h = createHarness({
				store,
				queue: new MemoryQueue(0),
				memoryBatchFiles: 1,
				onEvent: (e) => events.push(e.type),
			});
			await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
			await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
			await h.shutdown();
		} finally {
			if (prevEnv === undefined) delete process.env.PIWPI_MEMORY_MODEL;
			else process.env.PIWPI_MEMORY_MODEL = prevEnv;
		}
		expect(events).toContain("memory_skipped");
		expect(sourceMeta(store.get(fileId(absFile))!).memoryState).toBe("pending");
	});

	it("ModelRegistry 门面无顶层 complete → 回退 runtime.complete：批量整理仍成功（发布版 0.83.0 兼容）", async () => {
		write80Lines();
		const store = new PluginStore();
		const events: string[] = [];
		// 发布版 0.83.0 形状：registry 是同步兼容门面（无 complete），complete 在内部 runtime 上
		// （TS private 不参与运行时，结构访问可触达）；memoryDeps 不注入，走 ctx.modelRegistry 提取通道。
		// 关键：complete 是依赖 this 的类方法（真实实现内部调 this.stream）——裸提取调用会丢 this 崩溃
		const stream = vi.fn(() => ({
			result: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							entries: {
								[fileId(absFile)]: { role: "auth", responsibilities: ["jwt"] },
							},
						}),
					},
				],
			}),
		}));
		const runtime = {
			stream,
			complete() {
				return this.stream().result(); // 真实实现同款：this 依赖
			},
		};
		const fakeRegistry = {
			runtime,
			find: () => ({ provider: "faux", id: "faux-1" }), // 记忆模型解析通道（真实 ModelRegistry 同签名）
		};
		const prevEnv = process.env.PIWPI_MEMORY_MODEL;
		process.env.PIWPI_MEMORY_MODEL = "faux/faux-1"; // P1-2：配置记忆模型 → 自动路径放行（经 env 通道）
		try {
			const h = createHarness({
				store,
				queue: new MemoryQueue(0),
				memoryBatchFiles: 1,
				onEvent: (e) => events.push(e.type),
			});
			await h.onSessionStart(
				{ type: "session_start", reason: "startup" } as never,
				{
					cwd: tmp,
					model: { provider: "faux", id: "faux-1" },
					modelRegistry: fakeRegistry,
					sessionManager: { getEntries: () => [] },
				} as unknown as ExtensionContext,
			);
			await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
			await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
			await h.shutdown();
		} finally {
			if (prevEnv === undefined) delete process.env.PIWPI_MEMORY_MODEL;
			else process.env.PIWPI_MEMORY_MODEL = prevEnv;
		}
		expect(stream).toHaveBeenCalledTimes(1);
		expect(sourceMeta(store.get(fileId(absFile))!).memoryState).toBe("done");
		expect(events).toContain("memory_updated");
	});

	it("P0-4 TOCTOU：LLM 返回前文件已变 → 提交被丢弃，store 与 project-map 不出现旧条目", async () => {
		write80Lines();
		const store = new PluginStore();
		const dataDir = join(tmp, "agent-toctou");
		const projectMap = new ProjectMap();
		const queue = new MemoryQueue(0);
		let releaseGate: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			releaseGate = r;
		});
		const complete = vi.fn(async () => {
			await gate; // 挂起 LLM：期间外部修改文件
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							entries: {
								[fileId(absFile)]: { role: "auth", responsibilities: ["jwt"] },
							},
						}),
					},
				],
			};
		});
		const h = createHarness({
			store,
			projectMap,
			queue,
			dataDir,
			cwd: tmp,
			memoryDeps: { complete, model: { provider: "faux" } },
			memoryBatchFiles: 1,
		});
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
		// 等批量整理任务进入 LLM 调用（捕获 hash 已完成）
		await vi.waitFor(() => expect(complete).toHaveBeenCalled());

		// LLM 往返期间文件被外部修改（hash 变化）
		const disk = readFileSync(absFile, "utf8").split("\n");
		disk[24] = "changed";
		writeFileSync(absFile, disk.join("\n"));

		releaseGate!();
		await queue.flush();

		// 提交被丢弃：memoryState 保持 pending、map 无条目、落盘文件无旧条目
		expect(sourceMeta(store.get(fileId(absFile))!).memoryState).toBe("pending");
		expect(projectMap.get(fileId(absFile))).toBeUndefined();
		const mapFile = projectMapFilePath(dataDir);
		if (existsSync(mapFile)) {
			const mapData = JSON.parse(readFileSync(mapFile, "utf8")) as Record<string, unknown>;
			expect(mapData[fileId(absFile)]).toBeUndefined();
		}
	});

	it("P1-1 shutdown 后不启动新模型调用（自动触发被门禁拦截）", async () => {
		write80Lines();
		const store = new PluginStore();
		const complete = vi.fn(async () => ({ content: [{ type: "text", text: "{}" }] }));
		const h = createHarness({
			store,
			queue: new MemoryQueue(0),
			memoryDeps: { complete, model: { provider: "faux" } },
			memoryBatchFiles: 1,
		});
		await h.shutdown(); // teardown 先行
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
		await new Promise((r) => setTimeout(r, 10));
		expect(complete).not.toHaveBeenCalled(); // shutdown 后自动整理不排队
		expect(sourceMeta(store.get(fileId(absFile))!).memoryState).toBe("pending");
	});

	it("P1-2 未配置记忆模型：自动触发被跳过且仅告警一次", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const prevEnv = process.env.PIWPI_MEMORY_MODEL;
		delete process.env.PIWPI_MEMORY_MODEL;
		const prevHome = process.env.HOME;
		// 指向不存在的 HOME → models.json 读不到 → 未配置
		process.env.HOME = join(tmp, "nonexistent-home");
		const store = new PluginStore();
		try {
			const h = createHarness({
				store,
				queue: new MemoryQueue(0),
				memoryBatchFiles: 1, // 1 个文件即达阈值
			});
			await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
			await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
			await new Promise((r) => setTimeout(r, 10));
			h.onAgentSettled();
			await new Promise((r) => setTimeout(r, 10));
			const warns = warnSpy.mock.calls.filter((c) => String(c[0]).includes("未配置记忆 Agent 模型"));
			expect(warns).toHaveLength(1); // 多触发点只提示一次
			expect(sourceMeta(store.get(fileId(absFile))!).memoryState).toBe("pending"); // 未整理
		} finally {
			warnSpy.mockRestore();
			if (prevEnv === undefined) delete process.env.PIWPI_MEMORY_MODEL;
			else process.env.PIWPI_MEMORY_MODEL = prevEnv;
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
		}
	});

	it("P1-2 配置记忆模型：使用指定模型与 maxTokens=1024", async () => {
		write80Lines();
		const store = new PluginStore();
		const complete = vi.fn(async () => ({ content: [{ type: "text", text: "{}" }] }));
		const found = { provider: "cheap", id: "cheap-1" };
		const registry = {
			complete,
			find: (p: string, id: string) => (p === "cheap" && id === "cheap-1" ? found : undefined),
		};
		const prevEnv = process.env.PIWPI_MEMORY_MODEL;
		process.env.PIWPI_MEMORY_MODEL = "cheap/cheap-1";
		try {
			const h = createHarness({
				store,
				queue: new MemoryQueue(0),
				memoryBatchFiles: 1,
			});
			await h.onSessionStart(
				{ type: "session_start", reason: "startup" } as never,
				{
					cwd: tmp,
					model: { provider: "main", id: "main-1" },
					modelRegistry: registry,
					sessionManager: { getEntries: () => [] },
				} as unknown as ExtensionContext,
			);
			await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
			await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
			await new Promise((r) => setTimeout(r, 10));
			expect(complete).toHaveBeenCalledTimes(1);
			expect(complete.mock.calls[0]![0]).toBe(found); // 用记忆模型而非主模型
			expect(complete.mock.calls[0]![2]).toMatchObject({ maxTokens: 1024 }); // 限制输出
		} finally {
			if (prevEnv === undefined) delete process.env.PIWPI_MEMORY_MODEL;
			else process.env.PIWPI_MEMORY_MODEL = prevEnv;
		}
	});

	it("批量整理输出非法 JSON → 保留 pending、project map 不变、主流程不受影响", async () => {
		write80Lines();
		const store = new PluginStore();
		const projectMap = new ProjectMap();
		const complete = vi.fn(async () => ({ content: [{ type: "text", text: "garbage" }] }));
		const h = createHarness({
			store,
			projectMap,
			queue: new MemoryQueue(0),
			memoryDeps: { complete, model: { provider: "faux" } },
			memoryBatchFiles: 1,
		});
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
		await h.shutdown();
		expect(sourceMeta(store.get(fileId(absFile))!).memoryState).toBe("pending");
		expect(projectMap.size()).toBe(0);
	});
});

describe("M5 §6.4：session_start 恢复", () => {
	function persistedData(over?: Partial<ToolContextPlugin>): unknown {
		const plugin: ToolContextPlugin = {
			id: fileId(absFile),
			category: "source",
			source: { toolName: "read", identity: fileId(absFile).replace("source:", "") },
			metadata: {
				absPath: absFile,
				hash: "PLACEHOLDER",
				totalLines: 80,
				segments: [{ start: 20, end: 40 }],
				anchorToolCallId: "t1",
				updatedAtHashChange: false,
			},
			...over,
		};
		return serializePlugin(plugin);
	}

	function entriesOf(data: unknown): SessionEntry[] {
		return [{ type: "custom", customType: CUSTOM_ENTRY_TYPE, data, id: "e1" }] as unknown as SessionEntry[];
	}

	it("resume：从 custom entries 恢复元数据（引用式不重切文本，磁盘未变时锚点历史文本即正确）", async () => {
		write80Lines();
		const store = new PluginStore();
		const data = persistedData();
		(data as { plugin: { metadata: { hash: string } } }).plugin.metadata.hash = hashBuffer(readFileSync(absFile));
		const h = createHarness({ store, entriesProvider: () => entriesOf(data) });

		await h.onSessionStart({ type: "session_start", reason: "resume" } as never, ctx());
		const p = store.get(fileId(absFile))!;
		expect(sourceMeta(p).segments).toEqual([{ start: 20, end: 40 }]); // 只恢复范围
		expect(sourceMeta(p).anchorToolCallId).toBe("t1");
	});

	it("resume 但磁盘已变：保留原元数据，不投递记忆（等 scan/read 按哈希变化自愈）", async () => {
		write80Lines();
		const store = new PluginStore();
		const data = persistedData(); // hash=PLACEHOLDER ≠ 磁盘
		const complete = vi.fn(
			async (_model: unknown, _context: { messages: { content: { type: string; text?: string }[] }[] }) => ({
				content: [{ type: "text", text: "" }],
			}),
		);
		const h = createHarness({
			store,
			entriesProvider: () => entriesOf(data),
			queue: new MemoryQueue(0),
			memoryDeps: { complete, model: { provider: "faux" } },
		});
		await h.onSessionStart({ type: "session_start", reason: "resume" } as never, ctx());
		const p = store.get(fileId(absFile))!;
		expect(sourceMeta(p).segments).toEqual([{ start: 20, end: 40 }]); // 引用式：不做磁盘判定
		expect(sourceMeta(p).hash).toBe("PLACEHOLDER");
		expect(complete).not.toHaveBeenCalled(); // M5 新模型：resume 不投递记忆，等 read 判定
		// 下一次 read：hash 与磁盘不一致 → 走 updated 重挂载（无旧文本 → 不判定阈值）
		const call = readCall("t9", { path: FILE, offset: 20, limit: 21 });
		await h.onToolCall(call, ctx());
		expect((call.input as { offset?: number }).offset).toBe(20); // updated 不改参数
		await h.onToolResult(readResult("t9", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
		expect(sourceMeta(store.get(fileId(absFile))!).segments).toEqual([{ start: 20, end: 40 }]);
	});

	it("resume：从会话 message entries 恢复上下文消息（无需单独保存，与插件同机制）", async () => {
		const longText = "x".repeat(500);
		const entries = [
			{ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "你好" }] } },
			{
				type: "message",
				id: "m2",
				message: {
					role: "assistant",
					content: [{ type: "text", text: longText }, { type: "image", image: "x" }],
				},
			},
			{
				type: "message",
				id: "m3",
				message: {
					role: "toolResult",
					toolCallId: "t1",
					content: [{ type: "text", text: "ok" }],
				},
			},
		] as unknown as SessionEntry[];
		const h = createHarness({ store: new PluginStore(), entriesProvider: () => entries });

		await h.onSessionStart({ type: "session_start", reason: "resume" } as never, ctx());
		const ctxSnap = h.snapshot().context;
		expect(ctxSnap).not.toBeNull();
		expect(ctxSnap!.messageCount).toBe(3);
		expect(ctxSnap!.toolResultCount).toBe(1);
		expect(ctxSnap!.messages[0]).toEqual({ role: "user", text: "你好", hasImage: false, toolCallId: undefined });
		expect(ctxSnap!.messages[1]).toEqual({
			role: "assistant",
			hasImage: true,
			toolCallId: undefined,
			text: longText.slice(0, 300),
		}); // 截断到 MAX_CONTEXT_TEXT
		expect(ctxSnap!.messages[2]).toEqual({ role: "toolResult", toolCallId: "t1", text: "ok", hasImage: false });
	});

	it("resume 但会话无消息：lastContext 保持 null（前端显示等待首次 LLM 请求）", async () => {
		const h = createHarness({ store: new PluginStore(), entriesProvider: () => [] });
		await h.onSessionStart({ type: "session_start", reason: "resume" } as never, ctx());
		expect(h.snapshot().context).toBeNull();
	});

	it("startup（非 resume）：不恢复消息", async () => {
		const entries = [
			{ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "你好" }] } },
		] as unknown as SessionEntry[];
		const h = createHarness({ store: new PluginStore(), entriesProvider: () => entries });
		await h.onSessionStart({ type: "session_start", reason: "startup" } as never, ctx());
		expect(h.snapshot().context).toBeNull();
	});

	it("startup（非 resume）：不恢复", async () => {
		write80Lines();
		const store = new PluginStore();
		const data = persistedData();
		const h = createHarness({ store, entriesProvider: () => entriesOf(data) });
		await h.onSessionStart({ type: "session_start", reason: "startup" } as never, ctx());
		expect(store.all()).toHaveLength(0);
	});
});

describe("M3 §4.5：降级与兜底", () => {
	it("文件不存在：完全走原生（无 pending、不改参数、结果透传）", async () => {
		const store = new PluginStore();
		const h = createHarness({ store });
		const call = readCall("t1", { path: "missing.ts", offset: 1 });
		await h.onToolCall(call, ctx());
		expect(call.input).toEqual({ path: "missing.ts", offset: 1 });
		const res = await h.onToolResult(readResult("t1", { path: "missing.ts", offset: 1 }), ctx());
		expect(res).toBeUndefined();
		expect(store.all()).toHaveLength(0);
	});

	it("offset 越界：让 read 原生报错（无 pending）", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 99999 }), ctx());
		const res = await h.onToolResult(readResult("t1", { path: FILE, offset: 99999 }), ctx());
		expect(res).toBeUndefined();
		expect(store.all()).toHaveLength(0);
	});

	it("isError 结果：透传并清理 pending，后续 read 正常", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		const res = await h.onToolResult(
			readResult("t1", { path: FILE, offset: 20, limit: 21 }, { isError: true }),
			ctx(),
		);
		expect(res).toBeUndefined();
		expect(store.all()).toHaveLength(0);
		// pending 已清理：再走一遍正常路径
		await h.onToolCall(readCall("t2", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t2", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
		expect(store.all()).toHaveLength(1);
	});

	it("图片 read：不接管", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		const event = {
			type: "tool_result",
			toolName: "read",
			toolCallId: "t1",
			input: { path: FILE, offset: 20, limit: 21 },
			content: [
				{ type: "text", text: "Read image file [png]" },
				{ type: "image", data: "AAA", mimeType: "image/png" },
			],
			isError: false,
			details: undefined,
		} as unknown as ToolResultEvent;
		const res = await h.onToolResult(event, ctx());
		expect(res).toBeUndefined();
		expect(store.all()).toHaveLength(0);
	});

	it("非 read 工具（bash）：完全透传", async () => {
		const h = createHarness({});
		const call = { type: "tool_call", toolName: "bash", toolCallId: "b1", input: { command: "ls" } };
		await h.onToolCall(call as unknown as ToolCallEvent, ctx());
		expect((call as { input: unknown }).input).toEqual({ command: "ls" });
		const res = await h.onToolResult(
			{
				type: "tool_result",
				toolName: "bash",
				toolCallId: "b1",
				input: { command: "ls" },
				content: [{ type: "text", text: "out" }],
				isError: false,
				details: undefined,
			} as unknown as ToolResultEvent,
			ctx(),
		);
		expect(res).toBeUndefined();
	});

	it("harness 骨架可加载，onToolResult/onContext 默认放行", async () => {
		const h = createHarness();
		expect(typeof h.onToolCall).toBe("function");
		expect(typeof h.onToolResult).toBe("function");
		expect(typeof h.onContext).toBe("function");
		expect(typeof h.onSessionStart).toBe("function");
		expect(typeof h.shutdown).toBe("function");
		expect(await h.onToolResult(readResult("x", {}), ctx())).toBeUndefined();
		expect(await h.onContext({ type: "context", messages: [] } as unknown as ContextEvent, ctx())).toBeUndefined();
	});

	it("index 默认导出为工厂函数，且订阅 6 个事件 + 注册 read_project_map 工具", async () => {
		const mod = await import("../index.ts");
		expect(typeof mod.default).toBe("function");
		const subscribed: string[] = [];
		const registered: string[] = [];
		const pi = {
			on: (event: string) => {
				subscribed.push(event);
			},
			registerTool: (tool: { name: string }) => {
				registered.push(tool.name);
			},
		} as unknown as ExtensionAPI;
		mod.default(pi);
		expect(subscribed).toEqual([
			"tool_call",
			"tool_result",
			"context",
			"session_start",
			"agent_settled",
			"session_shutdown",
		]);
		expect(registered).toEqual(["read_project_map", "request_user_input", "update_plan_document"]);
	});
});

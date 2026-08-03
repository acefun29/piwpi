import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	ToolCallEvent,
	ToolResultEvent,
	TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { hashBuffer } from "../src/hash.ts";
import { createHarness, type ToolResultEventResult } from "../src/harness.ts";
import { CUSTOM_ENTRY_TYPE, projectMapFilePath, serializePlugin } from "../src/memory/persist.ts";
import { MemoryQueue } from "../src/memory/queue.ts";
import { render } from "../src/render.ts";
import { PluginStore } from "../src/store.ts";
import type { MemoryJob, Segment, SourcePluginMeta, ToolContextPlugin } from "../src/types.ts";

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
	return lines(total).split("\n").slice(start - 1, end).join("\n");
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
		expect(sourceMeta(p!).segments).toEqual([{ start: 20, end: 40, text: text20_40 }]);
		expect(sourceMeta(p!).anchorToolCallId).toBe("t1");
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

		const res = await h.onToolResult(readResult("t2", { path: FILE, offset: 41, limit: 20 }, { text: text41_60 }), ctx());
		expect(res?.content?.[0]?.text).toContain("已挂载 L20-60，本次新增 L41-60");
		expect(res?.content?.[0]?.text).toContain(text41_60);

		const p = store.get(fileId(absFile))!;
		expect(sourceMeta(p).segments).toEqual([{ start: 20, end: 60, text: text20_60 }]);
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

		const res = await h.onToolResult(readResult("t2", { path: FILE, offset: 30, limit: 21 }, { text: text20_40 }), ctx());
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
					text: sliceOf(5000, 1, 2000) + "\n\n[Showing lines 1-2000 of 5000. Use offset=2001 to continue.]",
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
		expect(sourceMeta(p).segments).toEqual([{ start: 1, end: 2000, text: sliceOf(5000, 1, 2000) }]);
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
		const r1 = await h.onToolResult(readResult("p1", { path: FILE, offset: 1, limit: 10 }, { text: sliceTextOf(1, 10) }), ctx());
		expect(r1).toBeUndefined();
		const r2 = await h.onToolResult(readResult("p2", { path: FILE, offset: 50, limit: 10 }, { text: sliceTextOf(50, 59) }), ctx());
		expect(r2?.content?.[0]?.text).toContain("本次新增 L50-59");
		const p = store.get(fileId(absFile))!;
		expect(sourceMeta(p).anchorToolCallId).toBe("p1");
		expect(sourceMeta(p).segments.map((s) => s.text)).toContain(sliceTextOf(1, 10));
		expect(sourceMeta(p).segments.map((s) => s.text)).toContain(sliceTextOf(50, 59));
	});
});

describe("M3 §4.4：固定上下文区域（锚点刷新）", () => {
	it("锚点消息内容被原地替换为 render；无变化时字节不变", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
		const p = store.get(fileId(absFile))!;
		const fresh = render(p);

		// 第一次：锚点是原生全文 → 被替换为渲染
		const messages = [
			{ role: "user", content: [{ type: "text", text: "继续" }] },
			{ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "ORIGINAL" }] },
		] as unknown as ContextEvent["messages"];
		const ev = { type: "context", messages } as unknown as ContextEvent;
		await h.onContext(ev, ctx());
		expect((messages[1] as unknown as { content: { text: string }[] }).content[0]!.text).toBe(fresh);

		// 第二次：内容已一致 → 零改动
		const messages2 = [
			{ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: fresh }] },
		] as unknown as ContextEvent["messages"];
		const ev2 = { type: "context", messages: messages2 } as unknown as ContextEvent;
		await h.onContext(ev2, ctx());
		expect((messages2[0] as unknown as { content: { text: string }[] }).content[0]!.text).toBe(fresh);
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

describe("M4 §5：文件变化重挂载（updated 分支）", () => {
	it("哈希变化 → 不改参数、重挂载、记忆队列收到任务（含 old/new hash）", async () => {
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

		appendFileSync(absFile, "\nline81"); // 文件变化
		const call = readCall("t2", { path: FILE, offset: 30, limit: 21 });
		await h.onToolCall(call, ctx());
		expect((call.input as { offset?: number }).offset).toBe(30); // updated 不改参数

		const res = await h.onToolResult(readResult("t2", { path: FILE, offset: 30, limit: 21 }, { text: sliceTextOf(30, 50) }), ctx());
		expect(res?.content?.[0]?.text).toContain("内容已变化，插件已重挂载");

		const p = store.get(fileId(absFile))!;
		const meta = sourceMeta(p);
		expect(meta.hash).toBe(hashBuffer(readFileSync(absFile)));
		expect(meta.hash).not.toBe(oldHash);
		// 旧范围 20-40 按新磁盘重切 + 本次 30-50 → 合并 20-50
		const merged = meta.segments.map((s) => `${s.start}-${s.end}`).join(",");
		expect(merged).toBe("20-50");
		for (const s of meta.segments) {
			expect(s.text).toBe(
				readFileSync(absFile, "utf8").split("\n").slice(s.start - 1, s.end).join("\n"),
			);
		}
		expect(meta.updatedAtHashChange).toBe(true);

		// 记忆队列：去抖窗口 0，flush 后 worker 拿到 job（prompt 含 old/new hash 前 8 位）
		await new Promise((r) => setTimeout(r, 10));
		const prompt = complete.mock.calls[0]![1]!.messages[0]!.content[0]!.text ?? "";
		expect(prompt).toContain(oldHash.slice(0, 8));
		expect(prompt).toContain(meta.hash.slice(0, 8));
	});

	it("文件变短：段被 clamp，render 带 truncated 提示", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 61 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 61 }, { text: sliceTextOf(20, 80) }), ctx());

		writeFileSync(absFile, lines(30)); // 变短
		await h.onToolCall(readCall("t2", { path: FILE, offset: 10, limit: 11 }), ctx());
		await h.onToolResult(readResult("t2", { path: FILE, offset: 10, limit: 11 }, { text: sliceTextOf(10, 20) }), ctx());

		const p = store.get(fileId(absFile))!;
		const meta = sourceMeta(p);
		expect(meta.truncatedNote).toBe("[truncated: file shrank to 30 lines]");
		for (const s of meta.segments) {
			expect(s.end).toBeLessThanOrEqual(30);
		}
		expect(render(p)).toContain(meta.truncatedNote!);
	});
});

describe("M5 §6.2/§6.4：记忆 Agent 与持久化", () => {
	it("updated 后记忆 job 执行：plugin.memory 写入、项目地图落盘、custom entry 写入", async () => {
		write80Lines();
		const store = new PluginStore();
		const agentDir = join(tmp, "agent");
		const complete = vi.fn(async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						summary: "负责认证",
						understanding: "签发 JWT",
						relations: ["config.ts"],
						lifecycle: "keep",
						mapEntry: {
							role: "auth",
							responsibilities: ["jwt"],
							keyStructures: ["Auth"],
							dependencies: ["config.ts"],
							dependents: [],
							decisions: [],
						},
					}),
				},
			],
		}));
		const written: Array<[string, unknown]> = [];
		const h = createHarness({
			store,
			queue: new MemoryQueue(0),
			agentDir,
			cwd: tmp,
			memoryDeps: { complete, model: { provider: "faux", model: "faux-1" } },
			customEntryWriter: (t, d) => {
				written.push([t, d]);
				return "id";
			},
		});
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
		appendFileSync(absFile, "\nline81");
		await h.onToolCall(readCall("t2", { path: FILE, offset: 30, limit: 21 }), ctx());
		await h.onToolResult(readResult("t2", { path: FILE, offset: 30, limit: 21 }, { text: sliceTextOf(30, 50) }), ctx());

		await h.shutdown(); // flush 记忆队列 + 项目地图落盘

		const p = store.get(fileId(absFile))!;
		expect(p.memory?.summary).toBe("负责认证");
		expect(p.memory?.relations).toEqual(["config.ts"]);
		expect(sourceMeta(p).updatedAtHashChange).toBe(false); // worker 完成后复位

		expect(written.length).toBeGreaterThan(0);
		expect(written[written.length - 1]![0]).toBe(CUSTOM_ENTRY_TYPE);
		const persisted = written[written.length - 1]![1] as { plugin: ToolContextPlugin };
		expect(persisted.plugin.memory?.summary).toBe("负责认证");
		// 持久化不含大段文本
		const segs = persisted.plugin.metadata as unknown as { segments: Segment[] };
		expect(segs.segments.every((s) => s.text === "")).toBe(true);

		const mapFile = projectMapFilePath(agentDir, tmp);
		expect(existsSync(mapFile)).toBe(true);
		const mapData = JSON.parse(readFileSync(mapFile, "utf8")) as Record<string, { role: string }>;
		expect(mapData[fileId(absFile)]?.role).toBe("auth");
	});

	it("记忆 LLM 输出非法 → 保留旧 memory，主流程不受影响", async () => {
		write80Lines();
		const store = new PluginStore();
		const complete = vi.fn(async () => ({ content: [{ type: "text", text: "garbage" }] }));
		const h = createHarness({
			store,
			queue: new MemoryQueue(0),
			memoryDeps: { complete, model: { provider: "faux" } },
		});
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
		appendFileSync(absFile, "\nline81");
		await h.onToolCall(readCall("t2", { path: FILE, offset: 30, limit: 21 }), ctx());
		await h.onToolResult(readResult("t2", { path: FILE, offset: 30, limit: 21 }, { text: sliceTextOf(30, 50) }), ctx());
		await h.shutdown();
		expect(store.get(fileId(absFile))!.memory).toBeUndefined();
	});
});

describe("M5 §6.4：session_start 恢复", () => {
	function persistedData(over?: Partial<ToolContextPlugin>): unknown {
		const plugin: ToolContextPlugin = {
			id: fileId(absFile),
			category: "source",
			source: { toolName: "read", identity: fileId(absFile).replace("source:", "") },
			content: "",
			metadata: {
				absPath: absFile,
				hash: "PLACEHOLDER",
				totalLines: 80,
				segments: [{ start: 20, end: 40, text: "" }],
				anchorToolCallId: "t1",
				updatedAtHashChange: false,
			},
			memory: { summary: "旧记忆" },
			...over,
		};
		return serializePlugin(plugin);
	}

	function entriesOf(data: unknown): SessionEntry[] {
		return [{ type: "custom", customType: CUSTOM_ENTRY_TYPE, data, id: "e1" }] as unknown as SessionEntry[];
	}

	it("resume：从 custom entries 恢复，segments 按哈希从磁盘重切", async () => {
		write80Lines();
		const store = new PluginStore();
		const data = persistedData();
		(data as { plugin: { metadata: { hash: string } } }).plugin.metadata.hash = hashBuffer(readFileSync(absFile));
		const h = createHarness({ store, entriesProvider: () => entriesOf(data) });

		await h.onSessionStart({ type: "session_start", reason: "resume" } as never, ctx());
		const p = store.get(fileId(absFile))!;
		expect(p.memory?.summary).toBe("旧记忆");
		expect(sourceMeta(p).segments).toEqual([{ start: 20, end: 40, text: text20_40 }]); // 文本重切
		expect(sourceMeta(p).anchorToolCallId).toBe("t1");
	});

	it("resume 但磁盘已变：段清空、hash 更新为磁盘值、投递记忆 job（自愈）", async () => {
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
		expect(sourceMeta(p).segments).toEqual([]);
		expect(sourceMeta(p).hash).toBe(hashBuffer(readFileSync(absFile)));
		// 下一次 read 走 increment 重新挂载
		const call = readCall("t9", { path: FILE, offset: 20, limit: 21 });
		await h.onToolCall(call, ctx());
		expect((call.input as { offset?: number }).offset).toBe(20); // 段为空 → 视为缺失，但走 increment 分支改写为缺失段本身
		await h.onToolResult(readResult("t9", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
		expect(sourceMeta(store.get(fileId(absFile))!).segments).toEqual([{ start: 20, end: 40, text: text20_40 }]);
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
		const res = await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { isError: true }), ctx());
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
		expect(subscribed).toEqual(["tool_call", "tool_result", "context", "session_start", "session_shutdown"]);
	});
});

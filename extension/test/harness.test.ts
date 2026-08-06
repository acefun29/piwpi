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

describe("M3 §4.4：固定上下文区域（锚点刷新）", () => {
	it("锚点消息内容被原地替换为 render；无变化时字节不变", async () => {
		write80Lines();
		const store = new PluginStore();
		const h = createHarness({ store });
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
		const p = store.get(fileId(absFile))!;
		const fresh = render(p, readFileSync(absFile, "utf8").split("\n"));

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

	it("修改累计达阈值（max(8, 总行数×10%)）→ 挂载失效 + project map 失效 + 原生透传", async () => {
		write80Lines();
		const store = new PluginStore();
		const projectMap = new ProjectMap();
		projectMap.update(fileId(absFile), {
			role: "旧角色",
			responsibilities: [],
			keyStructures: [],
			dependencies: [],
			dependents: [],
			decisions: [],
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
		expect(projectMap.get(fileId(absFile))).toBeUndefined(); // project map 失效
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
			keyStructures: [],
			dependencies: [],
			dependents: [],
			decisions: [],
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
		expect(projectMap.get(fileId(absFile))).toBeUndefined();
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
	it("新文件挂载 → 计数达标 → 批量整理：mapEntry 写 project map、memoryState 置 done、custom entry 写入", async () => {
		write80Lines();
		const store = new PluginStore();
		const agentDir = join(tmp, "agent");
		const complete = vi.fn(
			async (_model: unknown, _context: { messages: { content: { type: string; text?: string }[] }[] }) => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
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
			}),
		);
		const written: Array<[string, unknown]> = [];
		const h = createHarness({
			store,
			queue: new MemoryQueue(0),
			agentDir,
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
		expect(prompt).toContain("输入一：该文件挂载内容");
		expect(prompt).toContain("输入二：主 Agent 最近对话");
		expect(prompt).toContain("输入三：Project Map 已有条目");

		expect(written.length).toBeGreaterThan(0);
		const persisted = written[written.length - 1]![1] as { plugin: ToolContextPlugin };
		// 引用式：持久化只含范围，不含文本字段
		const segs = persisted.plugin.metadata as unknown as { segments: Segment[] };
		expect(segs.segments.every((s) => !("text" in s))).toBe(true);

		const mapFile = projectMapFilePath(agentDir, tmp);
		expect(existsSync(mapFile)).toBe(true);
		const mapData = JSON.parse(readFileSync(mapFile, "utf8")) as Record<string, { role: string }>;
		expect(mapData[fileId(absFile)]?.role).toBe("auth");
	});

	it("批量整理无模型 → memory_skipped，pending 保留（下次触发再试）", async () => {
		write80Lines();
		const store = new PluginStore();
		const events: string[] = [];
		const h = createHarness({
			store,
			queue: new MemoryQueue(0),
			memoryBatchFiles: 1,
			onEvent: (e) => events.push(e.type),
		});
		await h.onToolCall(readCall("t1", { path: FILE, offset: 20, limit: 21 }), ctx());
		await h.onToolResult(readResult("t1", { path: FILE, offset: 20, limit: 21 }, { text: text20_40 }), ctx());
		await h.shutdown();
		expect(events).toContain("memory_skipped");
		expect(sourceMeta(store.get(fileId(absFile))!).memoryState).toBe("pending");
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
			memory: { summary: "旧记忆" },
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
		expect(p.memory?.summary).toBe("旧记忆");
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

	it("index 默认导出为工厂函数，且订阅 5 个事件 + 注册 read_project_map 工具", async () => {
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
		expect(subscribed).toEqual(["tool_call", "tool_result", "context", "session_start", "session_shutdown"]);
		expect(registered).toEqual(["read_project_map"]);
	});
});

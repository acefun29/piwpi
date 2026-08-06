import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildMemoryPrompt, MEMORY_SYSTEM_PROMPT, parseMemoryJson, summarize } from "../src/memory/agent.ts";
import { countChangedLines } from "../src/memory/diff.ts";
import {
	asCustomEntryWriter,
	CUSTOM_ENTRY_TYPE,
	projectMapFilePath,
	readProjectMapFile,
	restoreFromEntries,
	safeCwd,
	serializePlugin,
	writeProjectMapFile,
} from "../src/memory/persist.ts";
import { ProjectMap } from "../src/memory/project-map.ts";
import { MemoryQueue } from "../src/memory/queue.ts";
import type { MemoryJob, ToolContextPlugin } from "../src/types.ts";

const tmp = mkdtempSync(join(tmpdir(), "piwpi-memory-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function plugin(over?: Partial<ToolContextPlugin>): ToolContextPlugin {
	return {
		id: "source:file:a",
		category: "source",
		source: { toolName: "read", identity: "file:a" },
		metadata: {
			absPath: "C:\\x\\a.ts",
			hash: "h",
			totalLines: 10,
			segments: [{ start: 1, end: 2 }],
			anchorToolCallId: "t1",
			updatedAtHashChange: false,
		},
		...over,
	};
}

/** 引用式：渲染输入的行数组（与 plugin 的 segments 范围 1-2 对应） */
const LINES = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

const JOB: MemoryJob = { pluginId: "source:file:a", localContext: "改一下认证", dialogueContext: "[user] 看看认证" };

describe("MemoryQueue（计划 §6.1）", () => {
	it("同一 pluginId 去抖合并为一个 job（最后一次的负载生效）", async () => {
		const jobs: MemoryJob[] = [];
		const q = new MemoryQueue(0);
		q.setWorker(async (job) => {
			jobs.push(job);
		});
		q.enqueue({ pluginId: "p1", localContext: "first" });
		q.enqueue({ pluginId: "p1", localContext: "second" });
		await q.flush();
		expect(jobs).toHaveLength(1);
		expect(jobs[0]!.localContext).toBe("second");
	});

	it("不同 pluginId 各自成 job，串行执行", async () => {
		const order: string[] = [];
		const q = new MemoryQueue(0);
		q.setWorker(async (job) => {
			order.push(job.pluginId);
			await new Promise((r) => setTimeout(r, 5));
			order.push(`${job.pluginId}-done`);
		});
		q.enqueue({ pluginId: "a", localContext: "" });
		q.enqueue({ pluginId: "b", localContext: "" });
		await q.flush();
		expect(order).toEqual(["a", "a-done", "b", "b-done"]);
	});

	it("worker 未设置时 enqueue 静默丢弃", async () => {
		const q = new MemoryQueue(0);
		q.enqueue({ pluginId: "p1", localContext: "" });
		await q.flush();
		expect(true).toBe(true);
	});

	it("worker 挂起时 flush 超时兜底（不无限等待）", async () => {
		const q = new MemoryQueue(0);
		q.setWorker(() => new Promise<void>(() => {})); // 永不 resolve
		q.enqueue({ pluginId: "p1", localContext: "" });
		await expect(q.flush(50)).rejects.toThrow(/timed out/);
	});

	it("enqueueTask 串行执行并与 flush 同步等待", async () => {
		const order: string[] = [];
		const q = new MemoryQueue(0);
		q.enqueueTask(async () => {
			order.push("a");
			await new Promise((r) => setTimeout(r, 5));
			order.push("a-done");
		});
		q.enqueueTask(async () => {
			order.push("b");
		});
		await q.flush();
		expect(order).toEqual(["a", "a-done", "b"]);
	});

	it("enqueueTask 任务抛错不打断链", async () => {
		const q = new MemoryQueue(0);
		let reached = false;
		q.enqueueTask(async () => {
			throw new Error("boom");
		});
		q.enqueueTask(async () => {
			reached = true;
		});
		await q.flush();
		expect(reached).toBe(true);
	});
});

describe("countChangedLines（M5 变更量 diff）", () => {
	it("相同内容 → 0", () => {
		expect(countChangedLines(["a", "b", "c"], ["a", "b", "c"])).toBe(0);
	});

	it("尾部追加 → 追加行数", () => {
		expect(countChangedLines(["a", "b"], ["a", "b", "c", "d"])).toBe(2);
	});

	it("删除 → 删除行数", () => {
		expect(countChangedLines(["a", "b", "c"], ["a"])).toBe(2);
	});

	it("中部插入 → 插入行数", () => {
		expect(countChangedLines(["a", "b", "c"], ["a", "x", "y", "b", "c"])).toBe(2);
	});

	it("原地替换 → 替换行数（增+删）", () => {
		expect(countChangedLines(["a", "b", "c"], ["a", "B", "c"])).toBe(2);
	});

	it("完全不同的内容 → 全部行数", () => {
		expect(countChangedLines(["a", "b"], ["x", "y", "z"])).toBe(5);
	});

	it("空内容", () => {
		expect(countChangedLines([], ["a"])).toBe(1);
		expect(countChangedLines(["a"], [])).toBe(1);
	});

	it("超大文件 → Infinity（调用方视为达阈值）", () => {
		const big = Array.from({ length: 3001 }, (_, i) => `l${i}`);
		expect(countChangedLines(big, [...big, "extra"])).toBe(Infinity);
	});
});

describe("记忆 Agent（M5 新模型）", () => {
	it("buildMemoryPrompt 三段输入：挂载内容 / 对话尾部（去重说明）/ map 精简列表", () => {
		const p = plugin();
		const prompt = buildMemoryPrompt(p, JOB, "src/b.ts — auth; 依赖: config.ts", LINES);
		expect(prompt).toContain("改一下认证");
		expect(prompt).toContain("[piwpi:plugin");
		expect(prompt).toContain("[user] 看看认证");
		expect(prompt).toContain("工具结果仅保留标记行");
		expect(prompt).toContain("src/b.ts — auth");
		expect(prompt).toContain("mapEntry");
	});

	it("parseMemoryJson：严格 JSON（mapEntry 六字段清洗）", () => {
		const out = parseMemoryJson(
			JSON.stringify({
				lifecycle: "keep",
				mapEntry: {
					role: "auth",
					responsibilities: ["jwt"],
					keyStructures: [],
					dependencies: ["config"],
					dependents: [],
					decisions: [],
				},
			}),
		);
		expect(out?.lifecycle).toBe("keep");
		expect(out?.mapEntry?.role).toBe("auth");
		expect(out?.mapEntry?.dependencies).toEqual(["config"]);
	});

	it("parseMemoryJson：容忍 markdown fence 与前后杂音", () => {
		const out = parseMemoryJson(
			'好的，以下是结果：\n```json\n{"mapEntry":{"role":"x","responsibilities":[],"keyStructures":[],"dependencies":[],"dependents":[],"decisions":[]}}\n```\n完毕',
		);
		expect(out?.mapEntry?.role).toBe("x");
	});

	it("parseMemoryJson：非法输入返回 null（调用方保留现状）", () => {
		expect(parseMemoryJson("not json at all")).toBeNull();
		expect(parseMemoryJson("")).toBeNull();
		expect(parseMemoryJson('{"mapEntry":')).toBeNull();
		expect(parseMemoryJson("[1,2,3]")).toBeNull();
	});

	it("summarize：成功路径返回解析结果；失败路径返回 null", async () => {
		const complete = vi.fn(async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						mapEntry: {
							role: "新角色",
							responsibilities: [],
							keyStructures: [],
							dependencies: [],
							dependents: [],
							decisions: [],
						},
					}),
				},
			],
		}));
		const out = await summarize({ complete, model: { provider: "faux" } }, plugin(), JOB, "", LINES);
		expect(out?.mapEntry?.role).toBe("新角色");

		const bad = vi.fn(async () => ({ content: [{ type: "text", text: "oops" }] }));
		expect(await summarize({ complete: bad, model: { provider: "faux" } }, plugin(), JOB, "", LINES)).toBeNull();

		const throwing = vi.fn(async () => {
			throw new Error("LLM down");
		});
		expect(
			await summarize({ complete: throwing, model: { provider: "faux" } }, plugin(), JOB, "", LINES),
		).toBeNull();
	});

	it("无模型 → 直接返回 null（不调 LLM）", async () => {
		const complete = vi.fn();
		expect(await summarize({ complete, model: undefined }, plugin(), JOB, "", LINES)).toBeNull();
		expect(complete).not.toHaveBeenCalled();
	});

	it("MEMORY_SYSTEM_PROMPT 要求严格 JSON 且声明无外部工具", () => {
		expect(MEMORY_SYSTEM_PROMPT).toContain("JSON");
		expect(MEMORY_SYSTEM_PROMPT).toContain("NO external tools");
	});
});

describe("ProjectMap（计划 §6.3）", () => {
	it("增量更新取并集去重，不重写", () => {
		const map = new ProjectMap();
		map.update("p1", {
			role: "r",
			responsibilities: ["a"],
			keyStructures: [],
			dependencies: ["x"],
			dependents: [],
			decisions: ["d1"],
		});
		map.update("p1", {
			role: "r2",
			responsibilities: ["a", "b"],
			keyStructures: ["K"],
			dependencies: ["y"],
			dependents: [],
			decisions: ["d1", "d2"],
		});
		const e = map.get("p1")!;
		expect(e.role).toBe("r2");
		expect(e.responsibilities).toEqual(["a", "b"]);
		expect(e.decisions).toEqual(["d1", "d2"]);
	});

	it("renderMarkdown 包含插件节；toJSON/load 往返一致", () => {
		const map = new ProjectMap();
		map.update("p1", {
			role: "auth",
			responsibilities: ["jwt"],
			keyStructures: ["Auth"],
			dependencies: ["config"],
			dependents: [],
			decisions: [],
		});
		const md = map.renderMarkdown();
		expect(md).toContain("## p1");
		expect(md).toContain("auth");

		const map2 = new ProjectMap();
		map2.load(map.toJSON());
		expect(map2.get("p1")?.role).toBe("auth");
	});

	it("delete 移除条目（失效语义 = 删除，无 tombstone）", () => {
		const map = new ProjectMap();
		map.update("p1", {
			role: "r",
			responsibilities: [],
			keyStructures: [],
			dependencies: [],
			dependents: [],
			decisions: [],
		});
		map.delete("p1");
		expect(map.get("p1")).toBeUndefined();
		expect(map.size()).toBe(0);
	});

	it("renderTree：目录分组 Markdown 缩进树（共享前缀合并、按目录排序）", () => {
		const map = new ProjectMap();
		const entry = (role: string) => ({
			role,
			responsibilities: [],
			keyStructures: [],
			dependencies: [],
			dependents: [],
			decisions: [],
		});
		map.update(`source:file:${join(tmp, "src", "auth.ts").toLowerCase()}`, entry("认证与授权"));
		map.update(`source:file:${join(tmp, "src", "memory", "agent.ts").toLowerCase()}`, entry("记忆 Agent"));
		map.update(`source:file:${join(tmp, "src", "memory", "queue.ts").toLowerCase()}`, entry("队列"));
		const tree = map.renderTree(tmp);
		expect(tree).toContain("# 项目地图");
		expect(tree).toContain("src/");
		expect(tree).toContain("memory/");
		expect(tree).toContain("auth.ts — 认证与授权");
		expect(tree).toContain("agent.ts — 记忆 Agent");
		expect(tree).toContain("queue.ts — 队列");
		// 目录在文件前（src/ 出现于 auth.ts 之前）
		expect(tree.indexOf("src/")).toBeLessThan(tree.indexOf("auth.ts"));
	});

	it("renderTree：空 map 提示（暂无条目）；非 source:file id 直接作叶子", () => {
		const empty = new ProjectMap();
		expect(empty.renderTree(tmp)).toContain("（暂无条目）");
		const map = new ProjectMap();
		map.update("execution:bash", {
			role: "shell",
			responsibilities: [],
			keyStructures: [],
			dependencies: [],
			dependents: [],
			decisions: [],
		});
		expect(map.renderTree(tmp)).toContain("execution:bash — shell");
	});

	it("renderBrief：每项一行（路径 — 角色；依赖）", () => {
		const map = new ProjectMap();
		map.update(`source:file:${join(tmp, "src", "a.ts").toLowerCase()}`, {
			role: "入口",
			responsibilities: [],
			keyStructures: [],
			dependencies: ["b.ts"],
			dependents: [],
			decisions: [],
		});
		const brief = map.renderBrief(tmp);
		expect(brief).toContain("src/a.ts — 入口；依赖: b.ts");
	});
});

describe("persist（计划 §6.4）", () => {
	it("safeCwd 编码与 pi session-manager.ts:476-489 一致", () => {
		// pi 规则：剥首分隔符后把 / \ : 全部替换为 "-"（驱动器冒号后紧跟反斜杠 → 双横线）
		if (process.platform === "win32") {
			expect(safeCwd("C:\\Users\\me\\proj")).toBe("--C--Users-me-proj--");
		} else {
			expect(safeCwd("/home/me/proj")).toBe("--home-me-proj--");
		}
	});

	it("projectMapFilePath 落在 agentDir/piwpi/safeCwd/ 下", async () => {
		const file = projectMapFilePath(tmp, "C:\\proj");
		expect(file).toContain(join("piwpi"));
		expect(file).toContain("project-map.json");
	});

	it("项目地图文件写读往返", async () => {
		const file = projectMapFilePath(tmp, "C:\\proj");
		await writeProjectMapFile(file, { p1: { role: "auth" } });
		const data = await readProjectMapFile(file);
		expect(data).toEqual({ p1: { role: "auth" } });
	});

	it("serializePlugin 原样序列化（引用式：插件本身不携带文本）", () => {
		const data = serializePlugin(plugin());
		const meta = data.plugin.metadata as unknown as { segments: Array<{ start: number; end: number }> };
		expect(meta.segments).toEqual([{ start: 1, end: 2 }]);
	});

	it("restoreFromEntries 只收 piwpi custom entries", () => {
		const p = serializePlugin(plugin());
		const entries = [
			{ type: "custom", customType: CUSTOM_ENTRY_TYPE, data: p, id: "1" },
			{ type: "custom", customType: "other-ext", data: { x: 1 }, id: "2" },
			{ type: "message", id: "3" },
		] as unknown as Parameters<typeof restoreFromEntries>[0];
		const out = restoreFromEntries(entries);
		expect(out).toHaveLength(1);
		expect(out[0]!.plugin.id).toBe("source:file:a");
	});

	it("asCustomEntryWriter：无 appendCustomEntry 时返回 undefined", () => {
		expect(asCustomEntryWriter({})).toBeUndefined();
		const writer = asCustomEntryWriter({ appendCustomEntry: (t: string, d?: unknown) => `${t}:${String(d)}` });
		expect(writer?.(CUSTOM_ENTRY_TYPE, { a: 1 })).toBe(`${CUSTOM_ENTRY_TYPE}:[object Object]`);
	});
});

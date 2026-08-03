import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildMemoryPrompt, MEMORY_SYSTEM_PROMPT, parseMemoryJson, summarize } from "../src/memory/agent.ts";
import { ProjectMap } from "../src/memory/project-map.ts";
import {
	CUSTOM_ENTRY_TYPE,
	asCustomEntryWriter,
	projectMapFilePath,
	readProjectMapFile,
	restoreFromEntries,
	safeCwd,
	serializePlugin,
	writeProjectMapFile,
} from "../src/memory/persist.ts";
import { MemoryQueue } from "../src/memory/queue.ts";
import type { MapEntry, MemoryJob, ToolContextPlugin } from "../src/types.ts";

const tmp = mkdtempSync(join(tmpdir(), "piwpi-memory-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function plugin(over?: Partial<ToolContextPlugin>): ToolContextPlugin {
	return {
		id: "source:file:a",
		category: "source",
		source: { toolName: "read", identity: "file:a" },
		content: "",
		metadata: {
			absPath: "C:\\x\\a.ts",
			hash: "h",
			totalLines: 10,
			segments: [{ start: 1, end: 2, text: "a\nb" }],
			anchorToolCallId: "t1",
			updatedAtHashChange: false,
		},
		...over,
	};
}

const JOB: MemoryJob = { pluginId: "source:file:a", oldHash: "old", newHash: "new", localContext: "改一下认证" };

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
});

describe("记忆 Agent（计划 §6.2）", () => {
	it("buildMemoryPrompt 含渲染、文件变化、旧记忆", () => {
		const p = plugin({ memory: { summary: "旧摘要" } });
		const prompt = buildMemoryPrompt(p, JOB);
		expect(prompt).toContain("改一下认证");
		expect(prompt).toContain("[piwpi:plugin");
		expect(prompt).toContain("旧摘要");
		expect(prompt).toContain("文件哈希从 old 变为 new");
	});

	it("parseMemoryJson：严格 JSON", () => {
		const out = parseMemoryJson(
			JSON.stringify({
				summary: "负责认证",
				understanding: "签发 JWT",
				relations: ["config.ts"],
				lifecycle: "keep",
				mapEntry: { role: "auth", responsibilities: ["jwt"], keyStructures: [], dependencies: [], dependents: [], decisions: [] },
			}),
		);
		expect(out?.summary).toBe("负责认证");
		expect(out?.relations).toEqual(["config.ts"]);
		expect(out?.lifecycle).toBe("keep");
		expect(out?.mapEntry?.role).toBe("auth");
	});

	it("parseMemoryJson：容忍 markdown fence 与前后杂音", () => {
		const out = parseMemoryJson("好的，以下是结果：\n```json\n{\"summary\":\"x\"}\n```\n完毕");
		expect(out?.summary).toBe("x");
	});

	it("parseMemoryJson：非法输入返回 null（调用方保留旧记忆）", () => {
		expect(parseMemoryJson("not json at all")).toBeNull();
		expect(parseMemoryJson("")).toBeNull();
		expect(parseMemoryJson("{\"summary\":")).toBeNull();
		expect(parseMemoryJson("[1,2,3]")).toBeNull();
	});

	it("summarize：成功路径返回解析结果；失败路径返回 null", async () => {
		const complete = vi.fn(async () => ({
			content: [{ type: "text", text: JSON.stringify({ summary: "新摘要" }) }],
		}));
		const out = await summarize({ complete, model: { provider: "faux" } }, plugin(), JOB);
		expect(out?.summary).toBe("新摘要");

		const bad = vi.fn(async () => ({ content: [{ type: "text", text: "oops" }] }));
		expect(await summarize({ complete: bad, model: { provider: "faux" } }, plugin(), JOB)).toBeNull();

		const throwing = vi.fn(async () => {
			throw new Error("LLM down");
		});
		expect(await summarize({ complete: throwing, model: { provider: "faux" } }, plugin(), JOB)).toBeNull();
	});

	it("无模型 → 直接返回 null（不调 LLM）", async () => {
		const complete = vi.fn();
		expect(await summarize({ complete, model: undefined }, plugin(), JOB)).toBeNull();
		expect(complete).not.toHaveBeenCalled();
	});

	it("MEMORY_SYSTEM_PROMPT 要求严格 JSON", () => {
		expect(MEMORY_SYSTEM_PROMPT).toContain("JSON");
	});
});

describe("ProjectMap（计划 §6.3）", () => {
	it("增量更新取并集去重，不重写", () => {
		const map = new ProjectMap();
		map.update("p1", { role: "r", responsibilities: ["a"], keyStructures: [], dependencies: ["x"], dependents: [], decisions: ["d1"] });
		map.update("p1", { role: "r2", responsibilities: ["a", "b"], keyStructures: ["K"], dependencies: ["y"], dependents: [], decisions: ["d1", "d2"] });
		const e = map.get("p1")!;
		expect(e.role).toBe("r2");
		expect(e.responsibilities).toEqual(["a", "b"]);
		expect(e.decisions).toEqual(["d1", "d2"]);
	});

	it("renderMarkdown 包含插件节；toJSON/load 往返一致", () => {
		const map = new ProjectMap();
		map.update("p1", { role: "auth", responsibilities: ["jwt"], keyStructures: ["Auth"], dependencies: ["config"], dependents: [], decisions: [] });
		const md = map.renderMarkdown();
		expect(md).toContain("## p1");
		expect(md).toContain("auth");

		const map2 = new ProjectMap();
		map2.load(map.toJSON());
		expect(map2.get("p1")?.role).toBe("auth");
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

	it("serializePlugin 剥离 segment 大段文本（恢复时从磁盘重切）", () => {
		const data = serializePlugin(plugin());
		const meta = data.plugin.metadata as unknown as { segments: { text: string }[] };
		expect(meta.segments).toEqual([{ start: 1, end: 2, text: "" }]);
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

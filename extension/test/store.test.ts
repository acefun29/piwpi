import { describe, expect, it } from "vitest";
import { PluginStore } from "../src/store.ts";
import type { ToolContextPlugin } from "../src/types.ts";

/** 构造一个最小 Source 插件（metadata 含 SourcePluginMeta 全字段） */
function plugin(id: string, anchor: string, extra?: Partial<ToolContextPlugin>): ToolContextPlugin {
	return {
		id,
		category: "source",
		source: { toolName: "read", identity: id },
		metadata: {
			absPath: `C:\\x\\${id}`,
			hash: "h",
			totalLines: 10,
			segments: [],
			anchorToolCallId: anchor,
			updatedAtHashChange: false,
		},
		...extra,
	};
}

describe("PluginStore（计划 §2.3）", () => {
	it("同 id 重复 upsert 只保留一份（后到覆盖）", () => {
		const store = new PluginStore();
		store.upsert(plugin("source:file:a", "t1"));
		store.upsert(plugin("source:file:a", "t1", { memory: { summary: "v2" } }));
		expect(store.all()).toHaveLength(1);
		expect(store.get("source:file:a")?.memory?.summary).toBe("v2");
	});

	it("findByAnchor 命中正确（含未命中）", () => {
		const store = new PluginStore();
		store.upsert(plugin("source:file:a", "t1"));
		store.upsert(plugin("source:file:b", "t2"));
		expect(store.findByAnchor("t1")?.id).toBe("source:file:a");
		expect(store.findByAnchor("t2")?.id).toBe("source:file:b");
		expect(store.findByAnchor("t9")).toBeUndefined();
	});

	it("get 未注册返回 undefined；clear 清空", () => {
		const store = new PluginStore();
		store.upsert(plugin("source:file:a", "t1"));
		expect(store.get("source:file:missing")).toBeUndefined();
		store.clear();
		expect(store.all()).toHaveLength(0);
	});
});

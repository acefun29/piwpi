import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	identifyPath,
	mergeSegments,
	rangeFromInput,
	resolveAbsPath,
	sliceText,
	sourceAdapter,
	type SourceIngestFacts,
} from "../src/adapters/source.ts";
import type { Segment, ToolContextPlugin } from "../src/types.ts";

const tmp = mkdtempSync(join(tmpdir(), "piwpi-adapter-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const CWD = tmp;
const FILE = join(CWD, "src", "auth.ts");
const diskLines = Array.from({ length: 80 }, (_, i) => `line${i + 1}`);
const diskText = diskLines.join("\n");

function facts(over: Partial<SourceIngestFacts> & { mode: SourceIngestFacts["mode"] }): SourceIngestFacts {
	return {
		absPath: FILE,
		hash: "abc123def456",
		diskLines,
		anchorToolCallId: "t1",
		got: { start: 20, end: 40 },
		...over,
	};
}

/** 断言 segments 文本与磁盘字节一致 */
function expectSegments(plugin: ToolContextPlugin): void {
	const meta = plugin.metadata as unknown as { segments: Segment[] };
	for (const s of meta.segments) {
		expect(s.text).toBe(sliceText(diskLines, { start: s.start, end: s.end }));
	}
}

describe("identify / 路径解析（计划 §4.1）", () => {
	it("相对路径对 cwd resolve，带 file: 前缀", () => {
		const expected = join(CWD, "src", "auth.ts");
		expect(identifyPath("src/auth.ts", CWD)).toBe(
			`file:${process.platform === "win32" ? expected.toLowerCase() : expected}`,
		);
	});
	it("绝对路径直接用", () => {
		expect(identifyPath(FILE, CWD)).toBe(`file:${process.platform === "win32" ? FILE.toLowerCase() : FILE}`);
	});
	it("~ 展开为 home 目录", () => {
		expect(resolveAbsPath("~/x.ts", CWD)).toBe(join(process.env.USERPROFILE ?? process.env.HOME ?? "", "x.ts"));
	});
	it("Windows 大小写不敏感（同一路径不同大小写 → 同一身份）", () => {
		if (process.platform !== "win32") return;
		expect(identifyPath("C:\\Temp\\A.ts", "C:\\Temp")).toBe(identifyPath("c:\\temp\\a.ts", "C:\\Temp"));
	});
	it("插件 id = source:identity", () => {
		const p = sourceAdapter.ingest({}, "", undefined, facts({ mode: "new" }));
		expect(p.id).toBe(`source:${identifyPath(FILE, CWD)}`);
	});
});

describe("rangeFromInput（read 参数 → 行范围）", () => {
	it("仅 offset：到文件尾", () => {
		expect(rangeFromInput({ path: "x", offset: 20 }, 80)).toEqual({ start: 20, end: 80 });
	});
	it("offset + limit：闭区间含 limit 最后一行", () => {
		expect(rangeFromInput({ path: "x", offset: 20, limit: 21 }, 80)).toEqual({ start: 20, end: 40 });
	});
	it("limit 超出文件尾 → clamp 到 totalLines", () => {
		expect(rangeFromInput({ path: "x", offset: 70, limit: 100 }, 80)).toEqual({ start: 70, end: 80 });
	});
	it("无 offset → 从第 1 行开始", () => {
		expect(rangeFromInput({ path: "x", limit: 5 }, 80)).toEqual({ start: 1, end: 5 });
	});
});

describe("ingest：new（计划 §4.3）", () => {
	it("创建插件：segments 文本与磁盘字节一致，anchor 记录本次 toolCallId", () => {
		const p = sourceAdapter.ingest({}, diskText, undefined, facts({ mode: "new", anchorToolCallId: "t9" }));
		const meta = p.metadata as unknown as { segments: Segment[]; anchorToolCallId: string; hash: string; updatedAtHashChange: boolean };
		expect(meta.segments).toEqual([{ start: 20, end: 40, text: sliceText(diskLines, { start: 20, end: 40 }) }]);
		expect(meta.anchorToolCallId).toBe("t9");
		expect(meta.hash).toBe("abc123def456");
		expect(meta.updatedAtHashChange).toBe(false);
		expect(p.memory).toBeUndefined();
		expect(p.content.length).toBeGreaterThan(0);
	});
});

describe("ingest：increment（计划 §4.3）", () => {
	it("追加段并合并（相邻 → 单段），文本重切", () => {
		const first = sourceAdapter.ingest({}, "", undefined, facts({ mode: "new", got: { start: 20, end: 40 } }));
		const p = sourceAdapter.ingest(
			{},
			"",
			first,
			facts({ mode: "increment", got: { start: 41, end: 60 }, hash: "abc123def456" }),
		);
		const meta = p.metadata as unknown as { segments: Segment[]; anchorToolCallId: string };
		expect(meta.segments).toEqual([{ start: 20, end: 60, text: sliceText(diskLines, { start: 20, end: 60 }) }]);
		expect(meta.anchorToolCallId).toBe("t1"); // anchor 不变
		expectSegments(p);
	});

	it("重叠段合并后从磁盘重切（覆盖旧文本缺口）", () => {
		const first = sourceAdapter.ingest({}, "", undefined, facts({ mode: "new", got: { start: 20, end: 40 } }));
		const p = sourceAdapter.ingest({}, "", first, facts({ mode: "increment", got: { start: 35, end: 60 } }));
		const meta = p.metadata as unknown as { segments: Segment[] };
		expect(meta.segments).toEqual([{ start: 20, end: 60, text: sliceText(diskLines, { start: 20, end: 60 }) }]);
	});
});

describe("ingest：updated（计划 §4.3/§5，M4）", () => {
	it("hash 更新、段按新磁盘重切、updatedAtHashChange=true", () => {
		const first = sourceAdapter.ingest({}, "", undefined, facts({ mode: "new", got: { start: 20, end: 40 } }));
		const newLines = [...diskLines.slice(0, 39), "CHANGED", ...diskLines.slice(40)];
		const p = sourceAdapter.ingest({}, "", first, {
			...facts({ mode: "updated", hash: "newhash", got: { start: 30, end: 50 } }),
			diskLines: newLines,
		});
		const meta = p.metadata as unknown as { hash: string; segments: Segment[]; updatedAtHashChange: boolean };
		expect(meta.hash).toBe("newhash");
		expect(meta.updatedAtHashChange).toBe(true);
		for (const s of meta.segments) {
			expect(s.text).toBe(newLines.slice(s.start - 1, s.end).join("\n"));
		}
		// 段含旧范围重切 + 本次 got
		const ranges = meta.segments.map((s) => `${s.start}-${s.end}`).join(",");
		expect(ranges).toBe("20-50");
	});

	it("文件变短：段被 clamp，truncatedNote 记录", () => {
		const first = sourceAdapter.ingest({}, "", undefined, facts({ mode: "new", got: { start: 20, end: 80 } }));
		const shortLines = diskLines.slice(0, 30);
		const p = sourceAdapter.ingest({}, "", first, {
			...facts({ mode: "updated", hash: "short", got: { start: 10, end: 20 } }),
			diskLines: shortLines,
		});
		const meta = p.metadata as unknown as { segments: Segment[]; truncatedNote?: string };
		expect(meta.truncatedNote).toBe("[truncated: file shrank to 30 lines]");
		for (const s of meta.segments) {
			expect(s.end).toBeLessThanOrEqual(30);
		}
	});

	it("文件变短后重新变长：truncatedNote 清除", () => {
		const first = sourceAdapter.ingest({}, "", undefined, facts({ mode: "new", got: { start: 20, end: 80 } }));
		const shrunk = sourceAdapter.ingest({}, "", first, {
			...facts({ mode: "updated", hash: "short", got: { start: 10, end: 20 } }),
			diskLines: diskLines.slice(0, 30),
		});
		const grown = sourceAdapter.ingest({}, "", shrunk, {
			...facts({ mode: "updated", hash: "long", got: { start: 10, end: 20 } }),
			diskLines,
		});
		const meta = grown.metadata as unknown as { truncatedNote?: string };
		expect(meta.truncatedNote).toBeUndefined();
	});
});

describe("ingest：noop（计划 §4.3）", () => {
	it("返回 current 原样（引用不变）", () => {
		const first = sourceAdapter.ingest({}, "", undefined, facts({ mode: "new" }));
		const out = sourceAdapter.ingest({}, "", first, facts({ mode: "noop" }));
		expect(out).toBe(first);
	});
});

describe("render（计划 §3.4）", () => {
	it("同一插件状态渲染逐字节相同", () => {
		const p = sourceAdapter.ingest({}, "", undefined, facts({ mode: "new", got: { start: 20, end: 40 } }));
		expect(sourceAdapter.render(p)).toBe(sourceAdapter.render(p));
	});
	it("含 memory 时输出 memory 段；无 memory 时不输出", () => {
		const p = sourceAdapter.ingest({}, "", undefined, facts({ mode: "new" }));
		expect(p.content).not.toContain("[piwpi:memory");
		p.memory = { summary: "负责认证", relations: ["config.ts"] };
		expect(sourceAdapter.render(p)).toContain("[piwpi:memory 负责认证；config.ts]");
	});
	it("输出段标记与头部", () => {
		const p = sourceAdapter.ingest({}, "", undefined, facts({ mode: "new", got: { start: 20, end: 40 } }));
		const rendered = sourceAdapter.render(p);
		expect(rendered).toContain("[piwpi:plugin");
		expect(rendered).toContain("--- L20-40 ---");
		expect(rendered).toContain(sliceText(diskLines, { start: 20, end: 40 }));
	});
});

describe("mergeSegments", () => {
	it("重叠段合并后文本从磁盘重切", () => {
		const segs: Segment[] = [
			{ start: 20, end: 40, text: "old" },
			{ start: 30, end: 50, text: "old" },
		];
		expect(mergeSegments(segs, diskLines)).toEqual([
			{ start: 20, end: 50, text: sliceText(diskLines, { start: 20, end: 50 }) },
		]);
	});
});

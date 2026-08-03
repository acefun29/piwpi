import { describe, expect, it } from "vitest";
import { clamp, normalize, subtract } from "../src/ranges.ts";

const r = (start: number, end: number) => ({ start, end });

describe("normalize（计划 §3.2）", () => {
	it("排序 + 合并重叠与相邻（[20,40]+[41,60] → [20,60]）", () => {
		expect(normalize([r(41, 60), r(20, 40)])).toEqual([r(20, 60)]);
	});
	it("包含重叠合并为一个大区间", () => {
		expect(normalize([r(20, 80), r(30, 50)])).toEqual([r(20, 80)]);
	});
	it("不相邻区间保持原样排序", () => {
		expect(normalize([r(60, 80), r(20, 40)])).toEqual([r(20, 40), r(60, 80)]);
	});
	it("空数组与单行段", () => {
		expect(normalize([])).toEqual([]);
		expect(normalize([r(5, 5), r(6, 6)])).toEqual([r(5, 6)]);
	});
	it("不修改入参", () => {
		const input = [r(41, 60), r(20, 40)];
		normalize(input);
		expect(input).toEqual([r(41, 60), r(20, 40)]);
	});
});

describe("subtract（计划 §3.2 测试矩阵）", () => {
	it("行1：已有 20-40，请求 30-60 → 41-60", () => {
		expect(subtract([r(20, 40)], r(30, 60))).toEqual([r(41, 60)]);
	});
	it("行2：已有 20-40,60-80，请求 30-70 → 41-59", () => {
		expect(subtract([r(20, 40), r(60, 80)], r(30, 70))).toEqual([r(41, 59)]);
	});
	it("行3：已有 20-80，请求 30-50 → 空", () => {
		expect(subtract([r(20, 80)], r(30, 50))).toEqual([]);
	});
	it("行4：已有 20-40，请求 41-60 → 41-60（相邻不视为已覆盖）", () => {
		expect(subtract([r(20, 40)], r(41, 60))).toEqual([r(41, 60)]);
	});
	it("行5：无已有，请求 1-N → 1-N", () => {
		expect(subtract([], r(1, 100))).toEqual([r(1, 100)]);
	});
	it("部分重叠：已有 30-50，请求 20-60 → 20-29 + 51-60", () => {
		expect(subtract([r(30, 50)], r(20, 60))).toEqual([r(20, 29), r(51, 60)]);
	});
});

describe("clamp（计划 §3.2）", () => {
	it("文件变短后截断", () => {
		expect(clamp(r(20, 40), 30)).toEqual(r(20, 30));
	});
	it("未变短时原样返回", () => {
		expect(clamp(r(20, 40), 100)).toEqual(r(20, 40));
	});
	it("整个区间都在新文件之外 → null", () => {
		expect(clamp(r(41, 50), 40)).toBeNull();
	});
	it("maxEnd < 1 → null", () => {
		expect(clamp(r(1, 5), 0)).toBeNull();
	});
});

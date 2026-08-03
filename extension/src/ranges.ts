/** 行范围集合运算（计划 §3.2，M2 实现）。纯函数，1-based 闭区间。 */
export type LineRange = { start: number; end: number };

/** 排序 + 合并重叠与相邻（[20,40]+[41,60] → [20,60]） */
export function normalize(ranges: LineRange[]): LineRange[] {
	throw new Error("TODO(M2): 计划 §3.2");
}

/** 求 want 中未覆盖部分 */
export function subtract(have: LineRange[], want: LineRange): LineRange[] {
	throw new Error("TODO(M2): 计划 §3.2");
}

/** 文件变短后截断，空则 null */
export function clamp(r: LineRange, maxEnd: number): LineRange | null {
	throw new Error("TODO(M2): 计划 §3.2");
}

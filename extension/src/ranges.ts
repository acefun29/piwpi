/** 行范围集合运算（计划 §3.2）。纯函数，1-based 闭区间。 */

export type LineRange = { start: number; end: number };

/** 排序 + 合并重叠与相邻（[20,40]+[41,60] → [20,60]）。返回新数组，不修改入参。 */
export function normalize(ranges: LineRange[]): LineRange[] {
	if (ranges.length === 0) return [];
	const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
	const out: LineRange[] = [];
	let cur: LineRange = { ...sorted[0]! };
	for (let i = 1; i < sorted.length; i++) {
		const r = sorted[i]!;
		if (r.start <= cur.end + 1) {
			cur.end = Math.max(cur.end, r.end);
		} else {
			out.push(cur);
			cur = { ...r };
		}
	}
	out.push(cur);
	return out;
}

/**
 * 求 want 中未被 have 覆盖的部分（结果按 start 升序、互不相邻）。
 * have 会先归一化（合并重叠/相邻），保证结果正确。
 */
export function subtract(have: LineRange[], want: LineRange): LineRange[] {
	const normalized = normalize(have);
	const missing: LineRange[] = [];
	let cursor = want.start;
	for (const r of normalized) {
		if (r.end < want.start) continue;
		if (r.start > want.end) break;
		if (r.start > cursor) {
			missing.push({ start: cursor, end: Math.min(r.start - 1, want.end) });
		}
		cursor = Math.max(cursor, r.end + 1);
		if (cursor > want.end) break;
	}
	if (cursor <= want.end) {
		missing.push({ start: cursor, end: want.end });
	}
	return missing;
}

/**
 * 文件变短后截断：超过 maxEnd 的部分裁掉；整个区间都在 maxEnd 之后（或 maxEnd < 1）→ null。
 */
export function clamp(r: LineRange, maxEnd: number): LineRange | null {
	if (maxEnd < 1 || r.start > maxEnd) return null;
	return { start: r.start, end: Math.min(r.end, maxEnd) };
}

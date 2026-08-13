/**
 * 行级 diff（M5 新模型）：量化"文件内容变化程度"，用于失效阈值判定。
 *
 * 零依赖实现：滚动数组 LCS（O(m) 空间），changed = n + m - 2×LCS。
 * 任一侧超过 MAX_LINES 时返回 Infinity（超大文件不做平方级计算，视为大变化）。
 */

const MAX_LINES = 3000;

/**
 * 旧内容 → 新内容的变化行数（added + removed；unchanged 不算）。
 * 超大文件返回 Infinity，调用方应视为"达到阈值"。
 */
export function countChangedLines(oldLines: readonly string[], newLines: readonly string[]): number {
	if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) return Infinity;
	const n = oldLines.length;
	const m = newLines.length;
	if (n === 0) return m;
	if (m === 0) return n;
	let prev = new Uint32Array(m + 1);
	let cur = new Uint32Array(m + 1);
	for (let i = 1; i <= n; i++) {
		const a = oldLines[i - 1];
		for (let j = 1; j <= m; j++) {
			cur[j] = a === newLines[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
		}
		[prev, cur] = [cur, prev];
	}
	return n + m - 2 * prev[m]!;
}

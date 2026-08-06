/**
 * 内容指纹（跨会话变更感知，方案见根目录《跨会话感知与磁盘驱动失效方案.md》）。
 *
 * 把"旧文本"压缩为每行/每块的哈希计数集合：任何进程都能拿它与磁盘比对，量化变化行数。
 * 错位无关：哈希只跟内容有关，跟位置无关（插入/删除只影响受影响的行，其余行哈希不变）。
 * 必须用计数（multiset）而非集合：复制粘贴旧内容时出现次数翻倍，计数差才不漏判。
 * 变化量 = |a| + |b| - 2×Σmin(countA, countB)，与 memory/diff.ts 的 n+m-2×LCS 语义同构
 * （"改"算作删+增 2 行）。
 *
 * 字节序：持久化统一 big-endian（writeUInt32BE/readUInt32BE），跨平台一致。
 * 依赖 Node 22 内置 crypto.hash（对小输入比 createHash 快 1.5-2 倍，行级哈希正好适用）。
 */
import { hash } from "node:crypto";

/** 每行 sha256 截前 4 字节 → Uint32Array（行级指纹，挂载插件用） */
export function lineFingerprint(lines: readonly string[]): Uint32Array {
	const out = new Uint32Array(lines.length);
	for (let i = 0; i < lines.length; i++) {
		out[i] = hash("sha256", lines[i]!, "buffer").readUInt32BE(0);
	}
	return out;
}

/** 每 chunkSize 行一块（块内容 join("\n")），sha256 截前 4 字节 → Uint32Array（map 条目用） */
export function chunkFingerprint(lines: readonly string[], chunkSize = 16): Uint32Array {
	const n = lines.length;
	const blockCount = Math.ceil(n / chunkSize);
	const out = new Uint32Array(blockCount);
	for (let b = 0; b < blockCount; b++) {
		const start = b * chunkSize;
		const end = Math.min(start + chunkSize, n);
		out[b] = hash("sha256", lines.slice(start, end).join("\n"), "buffer").readUInt32BE(0);
	}
	return out;
}

/** multiset 计数差：变化行数 = |a| + |b| - 2×交集计数（空侧返回另一侧长度） */
export function countDelta(a: Uint32Array, b: Uint32Array): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	const counts = new Map<number, number>();
	for (let i = 0; i < a.length; i++) {
		const v = a[i]!;
		counts.set(v, (counts.get(v) ?? 0) + 1);
	}
	let matched = 0;
	for (let i = 0; i < b.length; i++) {
		const v = b[i]!;
		const c = counts.get(v);
		if (c !== undefined && c > 0) {
			counts.set(v, c - 1);
			matched++;
		}
	}
	return a.length + b.length - 2 * matched;
}

/** Uint32Array → base64（big-endian，跨平台确定） */
export function encodeFingerprint(a: Uint32Array): string {
	const buf = Buffer.alloc(a.length * 4);
	for (let i = 0; i < a.length; i++) buf.writeUInt32BE(a[i]!, i * 4);
	return buf.toString("base64");
}

/** base64 → Uint32Array；空串/非法长度/解析失败 → undefined（旧数据兼容） */
export function decodeFingerprint(s: string): Uint32Array | undefined {
	if (typeof s !== "string" || s.length === 0) return undefined;
	let buf: Buffer;
	try {
		buf = Buffer.from(s, "base64");
	} catch {
		return undefined;
	}
	if (buf.length === 0 || buf.length % 4 !== 0) return undefined;
	const out = new Uint32Array(buf.length / 4);
	for (let i = 0; i < out.length; i++) out[i] = buf.readUInt32BE(i * 4);
	return out;
}

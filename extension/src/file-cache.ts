import { readFile, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { hashBuffer } from "./hash.ts";

/**
 * 校验式内容缓存（挂载引用式重构）：磁盘文件是唯一事实源，本模块是唯一读盘入口。
 *
 * 设计（第一性原理）：
 * - get() 先 stat（bigint）→ 缓存命中且 mtimeNs+size 一致 → 零读盘返回缓存；
 *   不一致 → 再 readFile → 算 hash → 更新缓存 → 返回。
 * - **pre-read stat 不变量**：缓存记录的是读盘前的 stat；并发双读时旧内容覆盖只造成下次 miss，永不毒化。
 * - 挂载中文件 pin（LRU 只淘汰非挂载项）；容量有界；大文件只存 {stat, hash} 不存行文本。
 * - TTL 安全阀：同 mtime+size 内容被改（如 git 恢复时间戳）的兜底，周期性强制重读。
 * - bigint 仅内存态，绝不持久化（JSON 无法序列化）。
 */

/** 单文件缓存条目。lines 仅小文件持有（超过 maxCachedLines 只存行数，文本按需 readLines）。 */
export interface FileCacheEntry {
	/** pre-read stat 的 mtime（纳秒，bigint） */
	mtimeNs: bigint;
	/** pre-read stat 的字节数（bigint stat 下 size 也是 bigint） */
	size: bigint;
	/** 磁盘内容 sha256(hex) */
	hash: string;
	totalLines: number;
	lines?: string[];
}

/** 单文件读取结果；null = 文件不可读（调用方按现状处理：跳过/原生透传）。 */
export interface FileCacheResult {
	entry: FileCacheEntry;
	/** 本次触发重读时被替换掉的旧条目（diff 用）；零读盘命中或首次读取时为 undefined */
	old?: FileCacheEntry;
}

/** 大文件不缓存行文本（文本只存到该行数以内；diff 防护线同 memory/diff.ts MAX_LINES=3000） */
const MAX_CACHED_LINES = 3000;
/** TTL 安全阀：同 stat 内容被改的极端情况，超过后强制重读一次 */
const TTL_MS = 300_000;
/** 全局容量（挂载文件 pin 不受此限） */
const DEFAULT_CAPACITY = 32;

export class FileContentCache {
	private byPath = new Map<string, { entry: FileCacheEntry; lastVerified: number }>();
	private pinned = new Set<string>();
	private capacity = DEFAULT_CAPACITY;
	private maxCachedLines = MAX_CACHED_LINES;

	constructor(opts?: { capacity?: number; maxCachedLines?: number }) {
		if (opts?.capacity !== undefined) this.capacity = opts.capacity;
		if (opts?.maxCachedLines !== undefined) this.maxCachedLines = opts.maxCachedLines;
	}

	/** 挂载中文件 pin：LRU 逐出时跳过（挂载文件是活跃上下文，驻留合理）。 */
	pin(absPath: string): void {
		this.pinned.add(absPath);
	}

	/** 挂载失效时解除 pin（条目保留，随 LRU 自然淘汰）。 */
	unpin(absPath: string): void {
		this.pinned.delete(absPath);
	}

	/** 校验式读取：stat 匹配 + 未超 TTL → 零读盘；否则 readFile 更新缓存。 */
	async get(absPath: string): Promise<FileCacheResult | null> {
		let st: BigIntStats;
		try {
			st = await stat(absPath, { bigint: true });
		} catch {
			this.byPath.delete(absPath);
			return null;
		}
		const now = Date.now();
		const cached = this.byPath.get(absPath);
		if (
			cached &&
			cached.entry.mtimeNs === st.mtimeNs &&
			cached.entry.size === st.size &&
			now - cached.lastVerified < TTL_MS
		) {
			return { entry: cached.entry };
		}
		let buf: Buffer;
		try {
			buf = await readFile(absPath);
		} catch {
			this.byPath.delete(absPath);
			return null;
		}
		const lines = buf.toString("utf8").split("\n");
		const entry: FileCacheEntry = {
			mtimeNs: st.mtimeNs, // pre-read stat：并发双读下旧覆盖只造成下次 miss
			size: st.size,
			hash: hashBuffer(buf),
			totalLines: lines.length,
			lines: lines.length <= this.maxCachedLines ? lines : undefined,
		};
		const old = cached?.entry;
		this.byPath.set(absPath, { entry, lastVerified: now });
		this.evict();
		return { entry, old };
	}

	/** 取行文本：缓存未持有（大文件）时强制读盘，返回后丢弃。 */
	async readLines(absPath: string): Promise<string[]> {
		const r = await this.get(absPath);
		if (r?.entry.lines) return r.entry.lines;
		const buf = await readFile(absPath);
		return buf.toString("utf8").split("\n");
	}

	/** LRU 逐出：优先淘汰最久未用的非 pin 条目（超出容量时）。 */
	private evict(): void {
		if (this.byPath.size <= this.capacity) return;
		let oldestKey: string | undefined;
		let oldestAt = Infinity;
		for (const [key, v] of this.byPath) {
			if (this.pinned.has(key)) continue;
			if (v.lastVerified < oldestAt) {
				oldestAt = v.lastVerified;
				oldestKey = key;
			}
		}
		if (oldestKey !== undefined) this.byPath.delete(oldestKey);
	}
}

import type { MemoryJob } from "../types.ts";

/**
 * 异步批处理队列（计划 §6.1）。
 *
 * 语义：
 * - 内存 FIFO + 串行 worker（promise 链），**不阻塞** onToolResult 返回
 * - 去抖：同一 pluginId 在 debounceMs（默认 1500ms）窗口内多次投递合并为一个 job（最后一次的负载生效）
 * - P1-1（shutdown 语义）：flush **只等待已运行链，不再派发 pending**（teardown 不启动新任务）；
 *   超时（默认 5s）→ 触发 AbortController.abort()，正在运行的任务经 signal 中止、结果作废；
 *   cancelPending() 丢弃未开始任务（清 timer，dispatch 时按 cancelled 检查）
 */
export class MemoryQueue {
	private worker: ((job: MemoryJob) => Promise<void>) | undefined;
	private pending = new Map<string, { job: MemoryJob; timer: ReturnType<typeof setTimeout> }>();
	private chain: Promise<void> = Promise.resolve();
	private readonly debounceMs: number;
	/** P1-1：当前正在运行任务的 AbortController（flush 超时 abort；无运行任务时为 null） */
	private activeAbort: AbortController | null = null;

	constructor(debounceMs = 1500) {
		this.debounceMs = debounceMs;
	}

	setWorker(worker: (job: MemoryJob) => Promise<void>): void {
		this.worker = worker;
	}

	/** P1-1：当前运行任务的 abort signal（任务间为 null；调用方在任务开始时捕获） */
	get signal(): AbortSignal | undefined {
		return this.activeAbort?.signal;
	}

	/** 投递记忆整理任务（去抖合并；worker 未设置时静默丢弃）。 */
	enqueue(job: MemoryJob): void {
		if (!this.worker) return;
		const existing = this.pending.get(job.pluginId);
		if (existing) clearTimeout(existing.timer);
		const timer = setTimeout(() => this.dispatch(job.pluginId), this.debounceMs);
		timer.unref?.();
		this.pending.set(job.pluginId, { job, timer });
	}

	/** 通用串行任务（M5 批量整理用）：与 job 共用同一串行链，flush 会等待；异常不会打断链。 */
	enqueueTask(task: () => Promise<void>): void {
		this.chain = this.chain.then(async () => {
			const ac = new AbortController();
			this.activeAbort = ac;
			try {
				await task();
			} catch (err) {
				console.error("[piwpi] memory task failed:", err);
			} finally {
				if (this.activeAbort === ac) this.activeAbort = null;
			}
		});
	}

	private dispatch(pluginId: string): void {
		const entry = this.pending.get(pluginId);
		if (!entry) return;
		this.pending.delete(pluginId);
		const job = entry.job;
		this.chain = this.chain
			.then(() => (this.worker ? this.worker(job) : undefined))
			.catch((err) => console.error(`[piwpi] memory job failed for ${pluginId}:`, err));
	}

	/** 等待去抖窗口的任务数（debug 快照用） */
	size(): number {
		return this.pending.size;
	}

	/** P1-1：丢弃未开始任务（清 timer；已 dispatch/运行中的任务不受影响）。 */
	cancelPending(): void {
		for (const entry of this.pending.values()) clearTimeout(entry.timer);
		this.pending.clear();
	}

	/**
	 * P1-1：只等待已运行链（不派发 pending——teardown 不启动新模型调用）；
	 * 超时（timeoutMs）→ abort 正在运行的任务并拒绝（调用方 catch 后继续）。
	 * 注意：Promise.withResolvers 需 node>=22，本地测试环境为 node 20 → 用 executor 形式。
	 */
	async flush(timeoutMs = 5000): Promise<void> {
		let rejectFn: ((reason: Error) => void) | undefined;
		const timeout = new Promise<never>((_, reject) => {
			rejectFn = reject;
		});
		const t = setTimeout(() => rejectFn?.(new Error(`MemoryQueue.flush timed out after ${timeoutMs}ms`)), timeoutMs);
		t.unref?.();
		try {
			await Promise.race([this.chain, timeout]);
		} catch (err) {
			this.activeAbort?.abort(); // 超时：中止正在运行的任务，结果由调用方作废
			throw err;
		} finally {
			clearTimeout(t);
		}
	}
}

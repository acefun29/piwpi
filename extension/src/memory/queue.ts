import type { MemoryJob } from "../types.ts";

/**
 * 异步批处理队列（计划 §6.1）。
 *
 * 语义：
 * - 内存 FIFO + 串行 worker（promise 链），**不阻塞** onToolResult 返回
 * - 去抖：同一 pluginId 在 debounceMs（默认 1500ms）窗口内多次投递合并为一个 job（最后一次的负载生效）
 * - flush 立即触发所有挂起任务并等待串行链完成，带超时兜底（默认 5s）
 */
export class MemoryQueue {
	private worker: ((job: MemoryJob) => Promise<void>) | undefined;
	private pending = new Map<string, { job: MemoryJob; timer: ReturnType<typeof setTimeout> }>();
	private chain: Promise<void> = Promise.resolve();
	private readonly debounceMs: number;

	constructor(debounceMs = 1500) {
		this.debounceMs = debounceMs;
	}

	setWorker(worker: (job: MemoryJob) => Promise<void>): void {
		this.worker = worker;
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

	private dispatch(pluginId: string): void {
		const entry = this.pending.get(pluginId);
		if (!entry) return;
		this.pending.delete(pluginId);
		const job = entry.job;
		this.chain = this.chain
			.then(() => (this.worker ? this.worker(job) : undefined))
			.catch((err) => console.error(`[piwpi] memory job failed for ${pluginId}:`, err));
	}

	/** 立即触发所有挂起任务并等待串行链完成；超时则拒绝（调用方 catch 后继续，5s 兜底语义）。 */
	async flush(timeoutMs = 5000): Promise<void> {
		for (const pluginId of [...this.pending.keys()]) {
			const entry = this.pending.get(pluginId);
			if (entry) {
				clearTimeout(entry.timer);
				this.dispatch(pluginId);
			}
		}
		const timeout = new Promise<never>((_, reject) => {
			const t = setTimeout(() => reject(new Error(`MemoryQueue.flush timed out after ${timeoutMs}ms`)), timeoutMs);
			t.unref?.();
		});
		await Promise.race([this.chain, timeout]);
	}
}

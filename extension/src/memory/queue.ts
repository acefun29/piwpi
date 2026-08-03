/**
 * 异步批处理队列（计划 §6.1，M5 实现）。
 *
 * 语义：
 * - 内存 FIFO + 串行 worker（promise 链），不阻塞 onToolResult 返回
 * - 去抖：同一 pluginId 在 1500ms 窗口内多次投递合并为一个 job
 * - session_shutdown 时 flush 剩余任务并等待落盘，带 5s 超时兜底
 */
export class MemoryQueue {
	enqueue(job: { pluginId: string; localContext: string }): void {
		throw new Error("TODO(M5): 计划 §6.1");
	}

	flush(timeoutMs = 5000): Promise<void> {
		throw new Error("TODO(M5): 计划 §6.1");
	}
}

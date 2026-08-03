import type {
	ContextEvent,
	ExtensionContext,
	SessionStartEvent,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

/**
 * 本地结构类型：上游包根未 re-export ToolResultEventResult / ContextEventResult
 * （core/extensions/types.ts:1065-1090 有定义，index.ts 导出清单遗漏）。
 * 与上游结构性一致，可赋值给 ExtensionHandler<ToolResultEvent, ToolResultEventResult>。
 * v1 只替换文本 content（图片 read 不接管），故不声明 image 块与 usage。
 */
export interface ToolResultEventResult {
	content?: { type: "text"; text: string }[];
	details?: unknown;
	isError?: boolean;
}

/**
 * Harness：tool_call / tool_result / context 三个核心 handler（计划 §4）。
 *
 * M0：骨架 —— 全部放行 no-op，工具行为与原生完全一致（扩展可安全加载）。
 * M3：实现拦截、增量读取、固定上下文区域（计划 §4）。
 *
 * 异常隔离事实（VERIFICATION.md #3）：
 * - tool_result / context handler 异常会被 runner 捕获（runner.ts:887-916 / 993-1006）
 * - tool_call handler 异常**没有** runner 隔离（runner.ts:941），会阻断工具执行
 *   → onToolCall 内部必须自带 try/catch（计划 §4.5）。
 *
 * context 事件语义（VERIFICATION.md #6，对计划 §4.4 的简化）：
 * runner 在分发前 structuredClone(messages)（runner.ts:986）并把**该 clone** 传给 handler，
 * 无论 handler 返回什么，runner 恒返回该 clone（runner.ts:1013）。
 * → onContext **原地修改 event.messages 即可生效**，无需返回 {messages}；
 *   无变化时不动任何字段，序列化字节逐字节不变（prompt 缓存前缀稳定）。
 */
export interface Harness {
	onToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<void>;
	onToolResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | undefined>;
	onContext(event: ContextEvent, ctx: ExtensionContext): Promise<void>;
	onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void>;
	shutdown(): Promise<void>;
}

export function createHarness(): Harness {
	// M0 骨架：全部放行。M3 开始实现（计划 §4.2-4.4）。
	return {
		async onToolCall(_event, _ctx) {
			// TODO(M3): 计划 §4.2 —— read 拦截、范围计算、pending 登记（必须自带 try/catch）
		},
		async onToolResult(_event, _ctx) {
			// TODO(M3): 计划 §4.3 —— 按 pending.kind 分支：new/increment/noop/updated
			return undefined;
		},
		async onContext(_event, _ctx) {
			// TODO(M3): 计划 §4.4 —— 原地刷新锚点消息内容（无变化零改动）
		},
		async onSessionStart(_event, _ctx) {
			// TODO(M5/M6): 计划 §6.4 —— 从 custom entries 恢复 store
		},
		async shutdown() {
			// TODO(M5): 计划 §6.1 —— flush 记忆队列并等待落盘（5s 超时兜底）
		},
	};
}

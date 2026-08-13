import type { MapEntry, SourcePluginMeta } from "./types.ts";

export type PiwpiEvent = {
	type:
		| "session_start"
		| "tool_call"
		| "mounted"
		| "noop"
		| "context"
		| "memory_queued"
		| "memory_updated"
		| "memory_skipped"
		| "memory_batch_done"
		| "invalidated"
		| "map_stale"
		| "restore"
		| "shutdown";
	ts?: number;
	pluginId?: string;
	[key: string]: unknown;
};

export interface PiwpiMessageSummary {
	role: string;
	toolCallId?: string;
	hasImage?: boolean;
	text: string;
}

export interface PiwpiContextSnapshot {
	ts: number;
	messageCount: number;
	toolResultCount: number;
	messages: PiwpiMessageSummary[];
}

export interface PiwpiPluginState {
	id: string;
	category: string;
	source: { toolName: string; identity: string };
	metadata: SourcePluginMeta;
}

export interface PiwpiState {
	cwd: string;
	ts: number;
	plugins: PiwpiPluginState[];
	projectMap: Record<string, MapEntry>;
	pendingCount: number;
	queuePending: number;
	lastUserText: string;
	context: PiwpiContextSnapshot | null;
	memoryRunCount: number;
	memoryTokenTotal: number;
}

export const MAX_CONTEXT_TEXT = 300;

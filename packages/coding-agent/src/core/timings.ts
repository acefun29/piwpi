/**
 * Central timing instrumentation for startup profiling.
 * Enable with PI_TIMING=1 environment variable.
 * P9：per-request trace 日志门 PIWPI_TRACE=1（与 PI_TIMING 同一日志门；trace 行格式 [trace] ...）。
 */

const ENABLED = process.env.PI_TIMING === "1";
/** P9：per-request trace 门（PIWPI_TRACE=1 或 PI_TIMING=1） */
export const TRACE_ENABLED = ENABLED || process.env.PIWPI_TRACE === "1";

interface TimingNamespace {
	timings: Array<{ label: string; ms: number }>;
	lastTime: number;
}

/** P9：扩展 namespace（transform/scan/memory/provider 供按模块归类耗时） */
type TimingLabel = "main" | "extensions" | "transform" | "scan" | "memory" | "provider";

const timingNamespaces = new Map<TimingLabel, TimingNamespace>();

export function resetTimings(namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	timingNamespaces.set(namespace, { timings: [], lastTime: Date.now() });
}

export function time(label: string, namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	const now = Date.now();

	if (!timingNamespaces.has(namespace)) {
		resetTimings(namespace);
	}

	const timingNamespace = timingNamespaces.get(namespace)!;
	timingNamespace.timings.push({ label, ms: now - timingNamespace.lastTime });
	timingNamespace.lastTime = now;
}

function printTimingGroup(title: string, timings: TimingNamespace["timings"]): void {
	const printableTimings = timings.filter((timing) => timing.ms >= 0);
	if (printableTimings.length === 0) return;
	console.error(`\n--- ${title} ---`);
	for (const t of printableTimings) {
		console.error(`  ${t.label}: ${t.ms}ms`);
	}
	console.error(`  TOTAL: ${printableTimings.reduce((a, b) => a + b.ms, 0)}ms`);
	console.error(`${"-".repeat(title.length + 8)}\n`);
}

export function printTimings(): void {
	if (!ENABLED) return;
	for (const [namespace, timingNamespace] of timingNamespaces) {
		printTimingGroup(`Startup Timings: ${namespace}`, timingNamespace.timings);
	}
}

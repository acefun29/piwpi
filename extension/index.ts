import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHarness } from "./src/harness.ts";

/**
 * piwpi 扩展入口（M0 骨架）。
 *
 * 加载方式：`pi -e extension`（在仓库根运行），或 `pi -e E:\project\opensource\piwpi\pi\extension`，
 * 或复制/软链到 `<项目>/.pi/extensions/piwpi/`。
 * 加载机制：`core/extensions/loader.ts:412-440`（jiti 加载 default export）与 618-713（三来源发现规则）。
 *
 * 事件订阅事实（已核对，见 VERIFICATION.md）：
 * - ExtensionAPI.on 全重载：core/extensions/types.ts:1193-1239
 * - context 事件接线：core/sdk.ts:350-354（transformContext → runner.emitContext）
 *
 * 里程碑：M0 = 骨架（全部放行）；M3 = 实现三个核心 handler。
 */
export default function (pi: ExtensionAPI): void {
	const harness = createHarness();
	pi.on("tool_call", (event, ctx) => harness.onToolCall(event, ctx));
	pi.on("tool_result", (event, ctx) => harness.onToolResult(event, ctx));
	pi.on("context", (event, ctx) => harness.onContext(event, ctx));
	pi.on("session_start", (event, ctx) => harness.onSessionStart(event, ctx));
	pi.on("session_shutdown", () => harness.shutdown());
}

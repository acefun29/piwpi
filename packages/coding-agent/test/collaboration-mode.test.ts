import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MODE_INSTRUCTIONS,
	instructionsForCollaborationMode,
	PLAN_MODE_INSTRUCTIONS,
} from "../src/core/collaboration-mode.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";

describe("collaboration mode", () => {
	it("keeps tool definitions stable and marks only read-only built-ins for plan mode", () => {
		const tools = createAllToolDefinitions(process.cwd());

		expect(Object.keys(tools)).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
		for (const name of ["read", "grep", "find", "ls"] as const) {
			expect(tools[name].collaborationModes).toEqual(["default", "plan"]);
		}
		for (const name of ["bash", "edit", "write"] as const) {
			expect(tools[name].collaborationModes).toBeUndefined();
		}
	});

	it("persists mode changes as session branch entries", () => {
		const manager = SessionManager.inMemory();

		manager.appendCollaborationModeChange("plan");
		manager.appendCollaborationModeChange("default");

		expect(manager.getBranch().slice(-2)).toMatchObject([
			{ type: "collaboration_mode_change", mode: "plan" },
			{ type: "collaboration_mode_change", mode: "default" },
		]);
	});

	it("uses fixed instructions for each collaboration mode", () => {
		expect(instructionsForCollaborationMode("default")).toBe(DEFAULT_MODE_INSTRUCTIONS);
		expect(instructionsForCollaborationMode("plan")).toBe(PLAN_MODE_INSTRUCTIONS);
	});
});

describe("P1-6：按协作模式过滤工具集", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-mode-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("default 模式不含 plan-only 工具；切 plan 出现；切回 default 消失（schema 与执行一致）", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.create(tempDir, join(agentDir, "sessions"), { id: "mode-filter" });
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "plan_only_tool",
						description: "只在 plan 模式可用",
						parameters: Type.Object({}),
						collaborationModes: ["plan"],
						execute: async () => ({ content: [] }),
					});
					pi.registerTool({
						name: "default_only_tool",
						description: "只在 default 模式可用（无 collaborationModes）",
						parameters: Type.Object({}),
						execute: async () => ({ content: [] }),
					});
				},
			],
		});
		await resourceLoader.reload();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			thinkingLevel: "high",
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		const toolNames = () => session.agent.state.tools.map((t) => t.name);

		// default 模式：plan-only 不进 state.tools（schema/执行拦截不再分叉）
		expect(toolNames()).not.toContain("plan_only_tool");
		expect(toolNames()).toContain("default_only_tool");

		// 切 plan：plan-only 出现（全量 active 保留），无 modes 的工具仅 default 可执行 → 消失
		session.setCollaborationMode("plan");
		expect(toolNames()).toContain("plan_only_tool");
		expect(toolNames()).not.toContain("default_only_tool");
		expect(session.getActiveToolNames()).toContain("default_only_tool"); // 全量集未丢

		// 切回 default：plan-only 消失，default-only 恢复
		session.setCollaborationMode("default");
		expect(toolNames()).not.toContain("plan_only_tool");
		expect(toolNames()).toContain("default_only_tool");

		session.dispose();
	});
});

import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODE_INSTRUCTIONS,
	instructionsForCollaborationMode,
	PLAN_MODE_INSTRUCTIONS,
} from "../src/core/collaboration-mode.ts";
import { SessionManager } from "../src/core/session-manager.ts";
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

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { CollaborationMode } from "../collaboration-mode.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SessionManager } from "../session-manager.ts";
import type { Harness } from "./harness.ts";
import { dataDirFor } from "./memory/persist.ts";

interface PiwpiToolsOptions {
	harness: Harness;
	sessionManager: SessionManager;
	getMode(): CollaborationMode;
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder: string): Promise<string | undefined>;
}

const readProjectMapSchema = Type.Object({});
const requestUserInputSchema = Type.Object({
	header: Type.String(),
	question: Type.String(),
	options: Type.Array(Type.Object({ label: Type.String(), description: Type.String() }), {
		minItems: 2,
		maxItems: 3,
	}),
});
const updatePlanDocumentSchema = Type.Object({
	status: Type.Union([Type.Literal("draft"), Type.Literal("proposed")]),
	markdown: Type.String(),
});

export function createPiwpiToolDefinitions(options: PiwpiToolsOptions): ToolDefinition[] {
	const readProjectMap: ToolDefinition<typeof readProjectMapSchema> = {
		name: "read_project_map",
		label: "Read project map",
		description: "读取 piwpi 项目地图（Markdown 目录树）：各文件的身份与职责。需要快速了解项目结构、查找文件时调用。",
		promptSnippet: "piwpi project map（文件身份与职责）",
		promptGuidelines: ["需要项目级理解（找文件、了解文件职责）时调用 read_project_map"],
		collaborationModes: ["default", "plan"],
		parameters: readProjectMapSchema,
		execute: async () => ({
			content: [{ type: "text", text: options.harness.projectMapTree() }],
			details: {},
		}),
	};
	const requestUserInput: ToolDefinition<typeof requestUserInputSchema> = {
		name: "request_user_input",
		label: "Request user input",
		description: "在计划模式中向用户提出一个会改变方案的决策问题。一次只能问一个问题。",
		promptSnippet: "计划模式单题决策访谈",
		collaborationModes: ["plan"],
		parameters: requestUserInputSchema,
		execute: async (_toolCallId, params) => {
			if (options.getMode() !== "plan") throw new Error("request_user_input is only available in plan mode");
			const rendered = params.options.map((option) => `${option.label} — ${option.description}`);
			const other = "其他…";
			const selected = await options.select(`${params.header}\n\n${params.question}`, [...rendered, other]);
			if (!selected) return { content: [{ type: "text", text: "User cancelled the question." }], details: {} };
			if (selected === other) {
				const answer = await options.input(params.header, "输入你的答案");
				return {
					content: [{ type: "text", text: answer ? `User answer: ${answer}` : "User cancelled the question." }],
					details: {},
				};
			}
			const selectedIndex = rendered.indexOf(selected);
			const selectedOption = params.options[selectedIndex]!;
			return {
				content: [
					{
						type: "text",
						text: `User selected: ${selectedOption.label}\n${selectedOption.description}`,
					},
				],
				details: {},
			};
		},
	};
	const updatePlanDocument: ToolDefinition<typeof updatePlanDocumentSchema> = {
		name: "update_plan_document",
		label: "Update plan document",
		description: "更新当前计划模式会话的私有 Markdown 计划文档。每次提交完整文档。",
		promptSnippet: "更新会话私有计划文档",
		collaborationModes: ["plan"],
		parameters: updatePlanDocumentSchema,
		execute: async (_toolCallId, params) => {
			if (options.getMode() !== "plan") throw new Error("update_plan_document is only available in plan mode");
			const plansDir = join(dataDirFor(options.sessionManager.getCwd()), "plans");
			const planPath = join(plansDir, `${options.sessionManager.getSessionId()}.md`);
			await mkdir(plansDir, { recursive: true });
			await writeFile(planPath, params.markdown, "utf8");
			options.sessionManager.appendCustomEntry("piwpi.plan_document", {
				version: 1,
				status: params.status,
				markdown: params.markdown,
				path: planPath,
			});
			return {
				content: [{ type: "text", text: `Plan document updated: ${planPath}` }],
				details: { path: planPath, status: params.status },
			};
		},
	};
	return [readProjectMap, requestUserInput, updatePlanDocument];
}

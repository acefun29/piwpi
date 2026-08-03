import type { ToolContextAdapter } from "../types.ts";
import { sourceAdapter } from "./source.ts";

/**
 * 工具名 → Adapter 映射（计划 §2.4）。
 *
 * 降级规则（M3 写入 Harness）：查到 "unimplemented" 或未注册 → handler 直接 return undefined，
 * 工具行为与原生完全一致（runner 只在字段 !== undefined 时覆盖）。
 */
export const registry: Record<string, ToolContextAdapter | "unimplemented"> = {
	// 结构兼容：sourceAdapter 的 identify/ingest 签名更宽（带 cwd / facts），
	// 与基接口 ToolContextAdapter 相比参数增多（方法 bivariance 不覆盖接口继承，见 source.ts 说明）。
	read: sourceAdapter as ToolContextAdapter, // Source（M2 落地）
	bash: "unimplemented", // Execution：接口已定义，行为降级（v1）
	websearch: "unimplemented", // Evidence：同上（v1）
};

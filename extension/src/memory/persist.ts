/**
 * 双通道持久化（计划 §6.4，M5 实现）。
 *
 * | 数据 | 通道 |
 * |---|---|
 * | 插件状态（不含大段文本，恢复时按范围从磁盘重切） | ctx.sessionManager.appendCustomEntry("piwpi:plugin", data) |
 * | 项目地图（跨会话长期资产） | 独立文件 join(getAgentDir(), "piwpi", safeCwd, "project-map.json") |
 *
 * 恢复：session_start（reason 含 "resume"）时回放 custom entries 重建 store。
 */
export function persistPlugin(pluginId: string, data: unknown): void {
	throw new Error("TODO(M5): 计划 §6.4");
}

export function restoreAll(): unknown[] {
	throw new Error("TODO(M5): 计划 §6.4");
}

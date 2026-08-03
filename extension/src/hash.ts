/**
 * 文件哈希（计划 §3.3，M2 实现）。
 * 对**原始字节**哈希（不是 utf8 字符串），避免 CRLF/编码归一化造成与 read 工具读取结果不一致。
 */
export function hashBuffer(buf: Buffer): string {
	throw new Error("TODO(M2): 计划 §3.3");
}

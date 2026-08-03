import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashBuffer } from "../src/hash.ts";

describe("hashBuffer（计划 §3.3）", () => {
	it("对原始字节哈希（sha256 hex），与 node:crypto 一致", () => {
		const buf = Buffer.from("hello\nworld\n");
		expect(hashBuffer(buf)).toBe(createHash("sha256").update(buf).digest("hex"));
	});

	it("CRLF 与 LF 产生不同哈希（不做行尾归一化，避免与 read 工具读取结果不一致）", () => {
		const lf = hashBuffer(Buffer.from("a\nb\n"));
		const crlf = hashBuffer(Buffer.from("a\r\nb\r\n"));
		expect(lf).not.toBe(crlf);
	});

	it("非 utf8 字节（含 0xFF）也能哈希", () => {
		const buf = Buffer.from([0xff, 0x00, 0x41, 0x0a]);
		expect(hashBuffer(buf)).toMatch(/^[0-9a-f]{64}$/);
	});
});

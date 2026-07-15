import { describe, expect, test } from "bun:test";
import { formatApiErrorMessage, toError } from "../src/lib/api/error-message";

describe("formatApiErrorMessage", () => {
	test("reads Error.message", () => {
		expect(formatApiErrorMessage(new Error("余额不足"))).toBe("余额不足");
	});

	test("reads gateway object with message and code", () => {
		expect(formatApiErrorMessage({ message: "Agent 不存在", code: "AgentNotFound" })).toBe(
			"Agent 不存在（AgentNotFound）",
		);
	});

	test("reads nested API error shape", () => {
		expect(formatApiErrorMessage({ error: { message: "prompt 不能为空" } })).toBe("prompt 不能为空");
	});

	test("reads nested data error shape", () => {
		expect(formatApiErrorMessage({ data: { errorMsg: "工作空间未开通" } })).toBe("工作空间未开通");
	});

	test("falls back when nothing is readable", () => {
		expect(formatApiErrorMessage({}, "请求失败")).toBe("请求失败");
	});
});

describe("toError", () => {
	test("normalizes non-Error throws", () => {
		const error = toError({ message: "鉴权失败", code: "Unauthorized" }, "控制台请求失败");
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("鉴权失败（Unauthorized）");
	});
});

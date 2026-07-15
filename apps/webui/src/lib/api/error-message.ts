const MESSAGE_KEYS = ["message", "msg", "errorMessage", "errorMsg", "errMsg", "detail", "description"] as const;
const CODE_KEYS = ["code", "errorCode", "errCode", "statusCode"] as const;

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readCode(record: Record<string, unknown>): string | undefined {
	for (const key of CODE_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
	return undefined;
}

function withCode(message: string, code: string | undefined): string {
	if (!code || message.includes(code)) return message;
	return `${message}（${code}）`;
}

/** Map known machine-readable codes to user-facing copy for any displayed error string. */
export function humanizeApiErrorMessage(message: string): string {
	return message;
}

/** Extract a user-facing message from API / thrown values. */
export function formatApiErrorMessage(error: unknown, fallback = "请求失败"): string {
	if (error == null) return fallback;

	const direct = readString(error);
	if (direct) return direct;

	if (error instanceof Error) {
		return readString(error.message) ?? fallback;
	}

	if (typeof error !== "object") return fallback;

	const record = error as Record<string, unknown>;

	for (const key of MESSAGE_KEYS) {
		const message = readString(record[key]);
		if (message) return withCode(message, readCode(record));
	}

	const nestedError = record.error;
	if (nestedError !== undefined) {
		const nested = formatApiErrorMessage(nestedError, "");
		if (nested) return nested;
	}

	const nestedData = record.data;
	if (nestedData !== undefined) {
		const nested = formatApiErrorMessage(nestedData, "");
		if (nested) return nested;
	}

	return fallback;
}

export function toError(error: unknown, fallback: string): Error {
	if (error instanceof Error) {
		const message = readString(error.message);
		return message ? error : new Error(fallback);
	}
	const message = formatApiErrorMessage(error, fallback);
	return new Error(message);
}

/** 签名 URL 过期判断的时钟缓冲（秒） */
const EXPIRY_SKEW_SEC = 60;

/**
 * 从 OSS / S3 风格预签名 URL 解析绝对过期时间（毫秒）。
 * 无法解析时返回 null（不做过期拦截与灰态）。
 */
export function getSignedUrlExpiryMs(url: string): number | null {
	try {
		const params = new URL(url).searchParams;

		const expires = params.get("Expires") ?? params.get("expires");
		if (expires && /^\d+$/.test(expires)) {
			return Number(expires) * 1000;
		}

		const ossExpires = params.get("x-oss-expires");
		const ossDate = params.get("x-oss-date") ?? params.get("Date");
		if (ossExpires && ossDate && /^\d+$/.test(ossExpires)) {
			const base = parseOssDate(ossDate);
			if (base != null) return base + Number(ossExpires) * 1000;
		}

		const amzExpires = params.get("X-Amz-Expires") ?? params.get("x-amz-expires");
		const amzDate = params.get("X-Amz-Date") ?? params.get("x-amz-date");
		if (amzExpires && amzDate && /^\d+$/.test(amzExpires)) {
			const base = parseOssDate(amzDate);
			if (base != null) return base + Number(amzExpires) * 1000;
		}

		return null;
	} catch {
		return null;
	}
}

/** 预签名下载链接是否已过期（需能解析出过期时间） */
export function isArtifactUrlExpired(url: string, nowMs = Date.now()): boolean {
	const expiryMs = getSignedUrlExpiryMs(url);
	if (expiryMs == null) return false;
	return nowMs >= expiryMs - EXPIRY_SKEW_SEC * 1000;
}

function parseOssDate(raw: string): number | null {
	const trimmed = raw.trim();
	const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(trimmed);
	if (compact) {
		return Date.UTC(
			Number(compact[1]),
			Number(compact[2]) - 1,
			Number(compact[3]),
			Number(compact[4]),
			Number(compact[5]),
			Number(compact[6]),
		);
	}
	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
}

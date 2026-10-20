import { resolveFetch } from "../transport.ts";
import type { RemoteResource } from "./interface.ts";
import { type SseRequestOptions, streamSse } from "./sse-transport.ts";

export { type SseRequestOptions, SseTransportError } from "./sse-transport.ts";

export class ApiError extends Error {
	constructor(
		public readonly statusCode: number,
		public readonly responseBody: string,
		prefix: string,
	) {
		super(`${prefix} ${statusCode}: ${responseBody}`);
	}

	static isNotFound(err: unknown): boolean {
		return err instanceof ApiError && err.statusCode === 404;
	}
}

export class ConflictError extends ApiError {}

export interface ApiRequestOptions {
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export abstract class BaseApiClient {
	protected abstract baseUrl: string;
	protected abstract headers(): Record<string, string>;
	protected abstract errorPrefix: string;
	protected abstract paginationStrategy: "page" | "after_id";

	protected isConflict(_status: number, _body: string): boolean {
		return false;
	}

	protected async throwIfError(res: Response): Promise<void> {
		if (res.ok) return;
		const body = await res.text();
		if (this.isConflict(res.status, body)) throw new ConflictError(res.status, body, this.errorPrefix);
		throw new ApiError(res.status, body, this.errorPrefix);
	}

	async post(path: string, body: unknown, options?: ApiRequestOptions): Promise<unknown> {
		const res = await resolveFetch()(`${this.baseUrl}${path}`, {
			method: "POST",
			headers: { ...this.headers(), ...options?.headers },
			body: JSON.stringify(body),
			...(options?.signal ? { signal: options.signal } : {}),
		});
		await this.throwIfError(res);
		return res.json();
	}

	async put(path: string, body: unknown, options?: ApiRequestOptions): Promise<unknown> {
		const res = await resolveFetch()(`${this.baseUrl}${path}`, {
			method: "PUT",
			headers: { ...this.headers(), ...options?.headers },
			body: JSON.stringify(body),
			...(options?.signal ? { signal: options.signal } : {}),
		});
		await this.throwIfError(res);
		return res.json();
	}

	async delete(path: string): Promise<void> {
		const res = await resolveFetch()(`${this.baseUrl}${path}`, {
			method: "DELETE",
			headers: this.headers(),
		});
		await this.throwIfError(res);
	}

	/** DELETE endpoints with JSON responses; legacy delete() remains void for 204 endpoints. */
	async deleteJson(path: string, options?: ApiRequestOptions): Promise<unknown> {
		const res = await resolveFetch()(`${this.baseUrl}${path}`, {
			method: "DELETE",
			headers: { ...this.headers(), ...options?.headers },
			...(options?.signal ? { signal: options.signal } : {}),
		});
		await this.throwIfError(res);
		return res.json();
	}

	async get(path: string, options?: ApiRequestOptions): Promise<unknown> {
		const res = await resolveFetch()(`${this.baseUrl}${path}`, {
			method: "GET",
			headers: { ...this.headers(), ...options?.headers },
			...(options?.signal ? { signal: options.signal } : {}),
		});
		await this.throwIfError(res);
		return res.json();
	}

	async getBuffer(path: string): Promise<Buffer> {
		const res = await resolveFetch()(`${this.baseUrl}${path}`, {
			method: "GET",
			headers: this.headers(),
		});
		await this.throwIfError(res);
		return Buffer.from(await res.arrayBuffer());
	}

	async *sse(path: string, options?: SseRequestOptions): AsyncGenerator<Record<string, unknown>> {
		yield* streamSse(`${this.baseUrl}${path}`, this.headers(), options, (response) => this.throwIfError(response));
	}

	async postFormData(path: string, formData: FormData): Promise<unknown> {
		// FormData must NOT carry a JSON Content-Type — fetch sets the multipart
		// boundary itself. Every provider's multipart headers are exactly its JSON
		// headers minus Content-Type, so derive them here.
		const { "Content-Type": _contentType, ...headers } = this.headers();
		const res = await resolveFetch()(`${this.baseUrl}${path}`, {
			method: "POST",
			headers,
			body: formData,
		});
		await this.throwIfError(res);
		return res.json();
	}

	async getAllPaged(path: string): Promise<Array<Record<string, unknown>>> {
		const all: Array<Record<string, unknown>> = [];
		let cursor: string | undefined;
		for (;;) {
			const sep = path.includes("?") ? "&" : "?";
			const param = this.paginationStrategy === "page" ? "page" : "after_id";
			const url = cursor ? `${path}${sep}limit=100&${param}=${encodeURIComponent(cursor)}` : `${path}${sep}limit=100`;
			const res = (await this.get(url)) as {
				data?: Array<Record<string, unknown>>;
				next_page?: string | null;
				has_more?: boolean;
				last_id?: string | null;
			};
			const data = res.data ?? [];
			all.push(...data);
			if (data.length === 0) break;
			if (this.paginationStrategy === "page") {
				if (!res.next_page) break;
				cursor = res.next_page;
			} else {
				if (!res.has_more || !res.last_id) break;
				cursor = res.last_id;
			}
		}
		return all;
	}
}

export function toRemoteResource(res: Record<string, unknown>): RemoteResource {
	return {
		id: res.id as string,
		type: res.type as string,
		version: res.version as number | undefined,
	};
}

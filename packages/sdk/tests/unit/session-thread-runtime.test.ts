import { afterEach, expect, test } from "bun:test";
import {
	createManagedApiContext,
	listSessionThreadEvents,
	listSessionThreads,
	type SessionThread,
} from "../../src/index.ts";
import { type FetchLike, setDefaultFetch } from "../../src/internal/transport.ts";
import { sanitizeSessionEvents } from "../../src/session-events.ts";

afterEach(() => setDefaultFetch(undefined));

const baseUrl = "https://bailian.test/api/v1/agentstudio";
const context = () => createManagedApiContext({ providers: { bailian: { api_key: "test", base_url: baseUrl } } });
const child: SessionThread = {
	id: "sthr_research",
	type: "session_thread",
	session_id: "sesn_one",
	parent_thread_id: "thrd_main",
	agent: { id: "agent_research", version: 3, name: "Researcher" },
	status: "running",
	created_at: "2026-10-28T00:00:00Z",
	updated_at: "2026-10-28T00:00:01Z",
	archived_at: null,
};

function urlOf(input: Parameters<FetchLike>[0]) {
	return new URL(input instanceof Request ? input.url : input.toString());
}

test("public thread list preserves child identity, nested Agent, opaque cursor, and unknown status", async () => {
	const calls: URL[] = [];
	const abort = new AbortController();
	setDefaultFetch(async (input, init) => {
		calls.push(urlOf(input));
		expect(init?.signal).toBe(abort.signal);
		return Response.json({
			data: [{ ...child, status: "future_status", agent_name: "事件名称" }],
			next_page: calls.length === 1 ? "next + / cursor" : null,
		});
	});
	const first = await listSessionThreads(context(), "sesn/one", {
		limit: 20,
		page: "old + cursor",
		signal: abort.signal,
	});
	expect(calls[0]!.pathname).toBe("/api/v1/agentstudio/sessions/sesn%2Fone/threads");
	expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({ limit: "20", page: "old + cursor" });
	expect(first).toEqual({
		data: [{ ...child, status: "future_status", agent_name: "事件名称" }],
		has_more: true,
		next_page: "next + / cursor",
	});
	const last = await listSessionThreads(context(), "sesn/one", { page: first.next_page, signal: abort.signal });
	expect(calls[1]!.searchParams.get("page")).toBe(first.next_page!);
	expect(last.has_more).toBe(false);
	expect(last.next_page).toBeUndefined();
});

test("thread snapshots preserve actual owner separately from referenced child and retain complete content", async () => {
	const raw = {
		id: "evt_forward",
		object: "message",
		type: "thread_message_sent",
		thread_id: "sthr_research",
		status: "completed",
		created_at: "2026-10-28T00:00:02Z",
		metadata: { to_session_thread_id: "sthr_writer", to_agent_name: "Writer" },
		content: [{ type: "data", data: { session_thread_id: "sthr_writer", message: "x".repeat(9000) } }],
	};
	let request: URL | undefined;
	setDefaultFetch(async (input) => {
		request = urlOf(input);
		return Response.json({ data: [raw], has_more: true, next_page: "next" });
	});
	const page = await listSessionThreadEvents(context(), "sesn/one", "sthr/research", {
		provider: "bailian",
		event_format: "snapshot",
		limit: 10,
		order: "desc",
		page: "ignored-alias",
		page_token: "current + cursor",
		created_at_gte: "2026-10-28T00:00:00Z",
	});
	expect(request!.pathname).toBe("/api/v1/agentstudio/sessions/sesn%2Fone/threads/sthr%2Fresearch/events");
	expect(Object.fromEntries(request!.searchParams)).toEqual({
		limit: "10",
		order: "desc",
		page: "current + cursor",
		"created_at[gte]": "2026-10-28T00:00:00Z",
	});
	const event = sanitizeSessionEvents(page.events, { redact: false, truncate: false })[0]!;
	expect(event.metadata?.thread_id).toBe("sthr_research");
	expect(event.metadata?.session_thread_id).toBe("sthr_writer");
	expect(event.metadata?.to_session_thread_id).toBe("sthr_writer");
	expect(event.content).toEqual(raw.content);
	expect(page.events[0]!.raw).toEqual(raw);
	expect(page.has_more).toBe(true);
	expect(page.next_page).toBe("next");
});

test("thread pages share legacy defaults, snapshot tool correlation, and local type filtering", async () => {
	const events = [
		{
			id: "evt_call",
			object: "message",
			type: "tool_call",
			thread_id: child.id,
			content: [{ type: "data", data: { call_id: "call_one", name: "search", arguments: { query: "test" } } }],
		},
		{
			id: "evt_output",
			object: "message",
			type: "tool_call_output",
			thread_id: child.id,
			content: [{ type: "data", data: { call_id: "call_one", output: "result" } }],
		},
	];
	setDefaultFetch(async (input) => {
		expect(urlOf(input).searchParams.has("types")).toBe(false);
		return Response.json({ data: events, next_page: "next-page" });
	});
	const legacy = await listSessionThreadEvents(context(), "sesn_one", child.id);
	expect(legacy.events[0]?.snapshot).toBeUndefined();
	const page = await listSessionThreadEvents(context(), "sesn_one", child.id, {
		event_format: "snapshot",
		types: ["tool_call_output"],
	});
	expect(page.events).toHaveLength(1);
	expect(page.events[0]?.tool_name).toBe("search");
	expect(page.events[0]?.snapshot?.metadata?.tool_name).toBe("search");
	expect(page.next_page).toBe("next-page");
});

for (const operation of ["list", "events"] as const) {
	test(`${operation} propagates cancellation to the HTTP request`, async () => {
		const abort = new AbortController();
		let reached!: () => void;
		const started = new Promise<void>((resolve) => {
			reached = resolve;
		});
		setDefaultFetch(
			async (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					expect(init?.signal).toBe(abort.signal);
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
					reached();
				}),
		);
		const pending =
			operation === "list"
				? listSessionThreads(context(), "sesn_one", { signal: abort.signal })
				: listSessionThreadEvents(context(), "sesn_one", child.id, { signal: abort.signal });
		await started;
		abort.abort(new Error("request cancelled"));
		await expect(pending).rejects.toThrow("request cancelled");
	});
}

test("unsupported providers reject thread operations before making a request", async () => {
	const ctx = createManagedApiContext({ providers: { qoder: { api_key: "test" } } });
	let requests = 0;
	setDefaultFetch(async () => {
		requests += 1;
		return Response.json({ data: [] });
	});
	await expect(listSessionThreads(ctx, "sesn_one")).rejects.toThrow("does not support session thread listing");
	await expect(listSessionThreadEvents(ctx, "sesn_one", child.id, { event_format: "snapshot" })).rejects.toThrow(
		"does not support session thread events",
	);
	expect(requests).toBe(0);
});

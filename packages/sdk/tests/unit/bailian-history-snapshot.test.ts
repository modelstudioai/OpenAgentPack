import { afterEach, expect, test } from "bun:test";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import { type FetchLike, setDefaultFetch } from "../../src/internal/transport.ts";

afterEach(() => setDefaultFetch(undefined));

const call = {
	object: "message",
	id: "call-event",
	type: "tool_call",
	status: "completed",
	content: [
		{ type: "data", data: { call_id: "call-1", name: "mark_artifacts", arguments: { paths: ["/out/report.pdf"] } } },
	],
};
const output = {
	object: "message",
	id: "output-event",
	type: "tool_call_output",
	status: "completed",
	content: [
		{
			type: "data",
			data: { call_id: "call-1", output: { marked: [{ file_id: "file-1", path: "/out/report.pdf" }], failed: [] } },
		},
	],
};

function requestUrl(input: Parameters<FetchLike>[0]): URL {
	return new URL(input instanceof Request ? input.url : input.toString());
}

for (const order of ["asc", "desc"] as const) {
	test(`snapshot history correlates tools in ${order} order without forwarding SDK options`, async () => {
		const events = order === "asc" ? [call, output] : [output, call];
		let request: URL | undefined;
		setDefaultFetch(async (input) => {
			request = requestUrl(input);
			return Response.json({ data: events, next_page: "opaque + cursor" });
		});
		const adapter = new BailianAdapter("test-key", undefined, "https://bailian.test/api/v1/agentstudio");
		const result = await adapter.listSessionEvents("session-1", {
			event_format: "snapshot",
			order,
			limit: 20,
			page_token: "previous + cursor",
		});
		expect(result.events.map((event) => event.id)).toEqual(events.map((event) => event.id));
		const toolOutput = result.events.find((event) => event.id === "output-event")!;
		expect(toolOutput.tool_name).toBe("mark_artifacts");
		expect(toolOutput.snapshot?.metadata?.tool_name).toBe("mark_artifacts");
		expect(toolOutput.snapshot?.metadata?.artifacts).toEqual([
			{ file_id: "file-1", path: "/out/report.pdf", filename: "report.pdf" },
		]);
		expect(toolOutput.snapshot?.content).toEqual(output.content);
		expect(toolOutput.raw).toEqual(output);
		expect(result.has_more).toBe(true);
		expect(result.next_page).toBe("opaque + cursor");
		expect(Object.fromEntries(request!.searchParams)).toEqual({ limit: "20", order, page: "previous + cursor" });
	});
}

test("legacy history retains its output and snapshot correlation does not persist across pages or sessions", async () => {
	const adapter = new BailianAdapter("test-key", undefined, "https://bailian.test/api/v1/agentstudio");
	let requests = 0;
	setDefaultFetch(async () =>
		Response.json({ data: ++requests === 1 ? [output, call] : requests === 2 ? [call] : [output], next_page: null }),
	);
	const legacy = await adapter.listSessionEvents("session-1");
	expect(legacy.events[0]?.tool_name).toBe("");
	expect(legacy.events[0]?.snapshot).toBeUndefined();
	await adapter.listSessionEvents("session-1", { event_format: "snapshot" });
	for (const sessionId of ["session-1", "session-2"]) {
		const page = await adapter.listSessionEvents(sessionId, { event_format: "snapshot", page_token: "next" });
		expect(page.events[0]?.tool_name).toBe("");
		expect(page.events[0]?.snapshot?.metadata?.artifacts).toBeUndefined();
		expect(page.events[0]?.snapshot?.content).toEqual(output.content);
	}
});

test("ambiguous call identities do not infer a tool name or artifacts", async () => {
	setDefaultFetch(async () =>
		Response.json({
			data: [
				call,
				{ ...call, id: "conflicting-call", content: [{ type: "data", data: { call_id: "call-1", name: "search" } }] },
				output,
			],
			next_page: null,
		}),
	);
	const adapter = new BailianAdapter("test-key", undefined, "https://bailian.test/api/v1/agentstudio");
	const result = await adapter.listSessionEvents("session-1", { event_format: "snapshot" });
	expect(result.events[2]?.tool_name).toBe("");
	expect(result.events[2]?.snapshot?.metadata?.artifacts).toBeUndefined();
});

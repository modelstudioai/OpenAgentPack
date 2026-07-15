import { expect, test } from "bun:test";
import { extractCreatedEventId, listSessionEventsPaged } from "../../src/internal/providers/session-event-response.ts";

test("extractCreatedEventId reads top-level id", () => {
	expect(extractCreatedEventId({ id: "evt_top" })).toBe("evt_top");
});

test("extractCreatedEventId reads first data item id", () => {
	expect(extractCreatedEventId({ data: [{ id: "evt_data" }] })).toBe("evt_data");
});

test("extractCreatedEventId reads first events item id", () => {
	expect(extractCreatedEventId({ events: [{ id: "evt_events" }] })).toBe("evt_events");
});

test("listSessionEventsPaged accepts undefined options", async () => {
	const res = await listSessionEventsPaged(
		{
			get: async () => ({ data: [], has_more: false }),
		},
		"sess_1",
		undefined,
		(raw) => ({ type: "message", raw_type: String(raw.type), raw }),
	);

	expect(res.events).toEqual([]);
	expect(res.has_more).toBe(false);
});

test("listSessionEventsPaged forwards page_token and legacy page cursor", async () => {
	let url = "";
	await listSessionEventsPaged(
		{
			get: async (path) => {
				url = path;
				return { data: [], has_more: false };
			},
		},
		"sess_1",
		{ limit: 10, page: "evt_1" },
		(raw) => ({ type: "message", raw_type: String(raw.type), raw }),
	);

	expect(url).toBe("/sessions/sess_1/events?limit=10&page=evt_1");
});

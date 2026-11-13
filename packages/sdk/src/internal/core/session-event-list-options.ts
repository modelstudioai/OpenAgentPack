import type { EventListOptions, ProviderSessionEventList } from "../types/session-event.ts";

/** Keep SDK-only routing options out of provider requests; normalize the legacy page alias. */
export function sessionEventListOptions(options: EventListOptions): EventListOptions | undefined {
	const result: EventListOptions = {};
	for (const key of [
		"event_format",
		"signal",
		"limit",
		"order",
		"types",
		"created_at_gt",
		"created_at_gte",
		"created_at_lt",
		"created_at_lte",
	] as const) {
		if (options[key] !== undefined) Object.assign(result, { [key]: options[key] });
	}
	const pageToken = options.page_token ?? options.page;
	if (pageToken !== undefined) result.page_token = pageToken;
	return Object.keys(result).length ? result : undefined;
}

export function filterSessionEventPage(
	result: ProviderSessionEventList,
	types: string[] | undefined,
): ProviderSessionEventList {
	if (!types?.length) return result;
	const allowedTypes = new Set(types);
	return { ...result, events: result.events.filter((event) => allowedTypes.has(event.raw_type)) };
}

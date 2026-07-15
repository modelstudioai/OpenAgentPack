import {
	type CollectedSessionEvents,
	createSessionForAgent,
	deleteSession,
	getSession,
	isTerminalSessionStatus,
	listSessionEvents,
	listSessionSummaries,
	type ProviderSessionEvent,
	sendSessionMessagePolling,
	sendSessionMessageStreaming,
	startSessionRun,
	startSessionRunPolling,
	UserError,
} from "@openagentpack/sdk";
import { sanitizeSessionEvent, sanitizeSessionEvents } from "@openagentpack/sdk/session-events";
import chalk from "chalk";
import { buildCliRuntime } from "../config-loader.ts";
import { log } from "../logger.ts";
import { columnWidth, printTableFooter, printTableHeader, printTableRow, printTableTitle } from "../render-table.ts";
import { writeJson, writeJsonLine } from "../runtime.ts";
import { fetchAllPages } from "../utils/pagination.ts";

export { isTerminalSessionStatus };

export function formatTimestamp(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDuration(startIso: string, endIso?: string): string {
	const start = new Date(startIso).getTime();
	const end = endIso ? new Date(endIso).getTime() : Date.now();
	if (Number.isNaN(start)) return "-";
	const sec = Math.max(0, Math.floor((end - start) / 1000));
	if (sec < 60) return `${sec}s`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return `${h}h${m}m`;
}

interface SessionCreateOpts {
	file: string;
	agent?: string;
	environment?: string;
	vault?: string;
	memoryStores?: string;
	title?: string;
	provider?: string;
}

export async function sessionCreateCommand(
	agentNameOrOptions: string | SessionCreateOpts | undefined,
	maybeOptions?: SessionCreateOpts,
) {
	const options = maybeOptions ?? (agentNameOrOptions as SessionCreateOpts);
	const positionalAgent = typeof agentNameOrOptions === "string" ? agentNameOrOptions : undefined;
	if (positionalAgent && options.agent && positionalAgent !== options.agent) {
		throw new UserError("Specify agent either positionally or with --agent, not both.");
	}

	const ctx = await buildCliRuntime(options.file);
	const run = await createSessionForAgent(ctx, {
		agent: positionalAgent ?? options.agent,
		provider: options.provider,
		environment: options.environment,
		vault: options.vault,
		memoryStores: parseMemoryStores(options.memoryStores),
		title: options.title,
	});
	const { agentName, session } = run;
	log.success(`Session created: ${chalk.bold(session.id)}`);
	console.log(`  Agent:       ${agentName}`);
	console.log(`  Environment: ${session.environment_id}`);
	console.log(`  Status:      ${session.status}`);
	if (session.vault_ids.length) console.log(`  Vaults:      ${session.vault_ids.join(", ")}`);
	if (session.memory_store_ids.length) console.log(`  Memory:      ${session.memory_store_ids.join(", ")}`);
}

interface SessionListOpts {
	file: string;
	agent?: string;
	provider?: string;
	all?: boolean;
}

export async function sessionListCommand(options: SessionListOpts) {
	const ctx = await buildCliRuntime(options.file);
	const { items: summaries, hasMore } = await fetchAllPages(async (page) => {
		const result = page
			? await listSessionSummaries(ctx, {
					agent: options.agent,
					provider: options.provider,
					filter: { page },
				})
			: await listSessionSummaries(ctx, {
					agent: options.agent,
					provider: options.provider,
				});
		return { items: result.summaries, hasMore: result.hasMore, nextPage: result.nextPage };
	}, options.all);
	const sessions = summaries.map((summary) => summary.session);

	if (sessions.length === 0) {
		log.info("No sessions found.");
		return;
	}

	const agentNameMap = new Map(
		summaries.filter((summary) => summary.agentName).map((summary) => [summary.session.id, summary.agentName!]),
	);
	const idWidth = columnWidth(sessions.map((s) => s.id.length));

	printTableTitle("Sessions", sessions.length);
	printTableHeader(
		[
			"ID".padEnd(idWidth),
			"Title".padEnd(20),
			"Agent".padEnd(14),
			"Status".padEnd(12),
			"Created".padEnd(20),
			"Duration",
		],
		idWidth + 80,
	);

	for (const s of sessions) {
		const id = s.id.padEnd(idWidth);
		const title = (s.title ?? "").slice(0, 18).padEnd(20);
		const agent = (agentNameMap.get(s.id) ?? s.agent_id.slice(0, 12)).padEnd(14);
		const statusText = s.status.padEnd(12);
		const status =
			s.status === "idle"
				? chalk.green(statusText)
				: s.status === "processing"
					? chalk.yellow(statusText)
					: s.status === "failed"
						? chalk.red(statusText)
						: chalk.gray(statusText);
		const created = formatTimestamp(s.created_at).padEnd(20);
		const duration = formatDuration(s.created_at, s.status === "idle" ? s.updated_at : undefined);
		printTableRow([chalk.bold(id), title, chalk.cyan(agent), status, chalk.dim(created), duration]);
	}
	printTableFooter();

	if (hasMore) {
		log.info("More sessions available. Use --all to fetch all.");
	}
}

interface SessionGetOpts {
	file: string;
	provider?: string;
}

export async function sessionGetCommand(sessionId: string, options: SessionGetOpts) {
	const ctx = await buildCliRuntime(options.file);
	const session = await getSession(ctx, sessionId, options.provider);

	console.log(`  ID:          ${chalk.bold(session.id)}`);
	console.log(`  Agent:       ${session.agent_id}`);
	console.log(`  Environment: ${session.environment_id}`);
	console.log(`  Status:      ${session.status}`);
	if (session.title) console.log(`  Title:       ${session.title}`);
	if (session.vault_ids.length) console.log(`  Vaults:      ${session.vault_ids.join(", ")}`);
	if (session.memory_store_ids.length) console.log(`  Memory:      ${session.memory_store_ids.join(", ")}`);
	console.log(`  Created:     ${session.created_at}`);
	console.log(`  Updated:     ${session.updated_at}`);
}

interface SessionDeleteOpts {
	file: string;
	provider?: string;
}

export async function sessionDeleteCommand(sessionId: string, options: SessionDeleteOpts) {
	const ctx = await buildCliRuntime(options.file);
	await deleteSession(ctx, sessionId, options.provider);
	log.success(`Session ${sessionId} deleted.`);
}

// --- Session Execution Commands ---

export function shouldRenderLiveEvent(event: ProviderSessionEvent): boolean {
	return event.type !== "thinking" && !(event.type === "message" && event.role === "user");
}

function renderTerminalStatus(status: string, json: boolean): void {
	if (json) return;
	const color = status === "idle" || status === "completed" ? chalk.green : chalk.red;
	log.plain(color(`\n[session ${status}]`));
}

function toEventListJson(events: ProviderSessionEvent[], hasMore: boolean, nextPage?: string): unknown {
	const out: Record<string, unknown> = { events: sanitizeSessionEvents(events), has_more: hasMore };
	if (nextPage !== undefined) out.next_page = nextPage;
	return out;
}

function renderEvent(event: ProviderSessionEvent): void {
	if (!shouldRenderLiveEvent(event)) return;

	if (event.type === "message" && event.content) {
		process.stdout.write(event.content);
	} else if (event.type === "tool_use") {
		log.plain(chalk.cyan(`\n[tool] ${event.tool_name}`));
	} else if (event.type === "tool_result" && event.content) {
		const preview = event.content.length > 200 ? `${event.content.slice(0, 200)}...` : event.content;
		log.plain(chalk.dim(preview));
	} else if (event.type === "status") {
		if (event.status === "running") {
			log.plain(chalk.yellow("\n[session running]"));
		}
	} else if (event.type === "error") {
		log.plain(chalk.red(`\n[error] ${event.content ?? "unknown error"}`));
	}
}

async function streamAndRender(events: AsyncIterable<ProviderSessionEvent>, json: boolean): Promise<void> {
	for await (const event of events) {
		if (json) {
			writeJsonLine(sanitizeSessionEvent(event));
		} else {
			renderEvent(event);
		}
		if (event.type === "status" && isTerminalSessionStatus(event.status)) {
			renderTerminalStatus(event.status!, json);
			break;
		}
	}
}

function renderCollectedEvents(result: CollectedSessionEvents, json: boolean): void {
	if (json) {
		writeJson(toEventListJson(result.result.events, result.result.has_more, result.result.next_page));
	} else {
		for (const event of result.result.events) {
			renderEvent(event);
		}
		renderTerminalStatus(result.terminalStatus, json);
	}
}

interface SessionRunOpts {
	file: string;
	agent?: string;
	environment?: string;
	vault?: string;
	memoryStores?: string;
	title?: string;
	provider?: string;
	json?: boolean;
	noStream?: boolean;
}

export async function sessionRunCommand(
	promptOrAgent: string,
	promptOrOptions?: string | SessionRunOpts,
	maybeOptions?: SessionRunOpts,
) {
	const hasPositionalAgent = typeof promptOrOptions === "string";
	const positionalAgent = hasPositionalAgent ? promptOrAgent : undefined;
	const prompt = hasPositionalAgent ? promptOrOptions : promptOrAgent;
	const options = hasPositionalAgent ? maybeOptions! : (promptOrOptions ?? maybeOptions)!;
	if (positionalAgent && options.agent && positionalAgent !== options.agent) {
		throw new UserError("Specify agent either positionally or with --agent, not both.");
	}

	const runOptions = {
		agent: positionalAgent ?? options.agent,
		provider: options.provider,
		environment: options.environment,
		vault: options.vault,
		memoryStores: parseMemoryStores(options.memoryStores),
		title: options.title,
	};

	const ctx = await buildCliRuntime(options.file);
	const run = options.noStream
		? await startSessionRunPolling(ctx, prompt, runOptions)
		: await startSessionRun(ctx, prompt, runOptions);
	const session = run.session;
	if (!options.json) {
		log.success(`Session created: ${chalk.bold(session.id)}`);
	}

	if (options.noStream) {
		renderCollectedEvents(run as Awaited<ReturnType<typeof startSessionRunPolling>>, !!options.json);
	} else {
		await streamAndRender((run as Awaited<ReturnType<typeof startSessionRun>>).events, !!options.json);
	}
}

interface SessionSendOpts {
	file: string;
	provider?: string;
	json?: boolean;
	noStream?: boolean;
}

export async function sessionSendCommand(sessionId: string, message: string, options: SessionSendOpts) {
	const ctx = await buildCliRuntime(options.file);
	if (options.noStream) {
		const result = await sendSessionMessagePolling(ctx, sessionId, message, { provider: options.provider });
		renderCollectedEvents(result, !!options.json);
	} else {
		const events = await sendSessionMessageStreaming(ctx, sessionId, message, { provider: options.provider });
		await streamAndRender(events, !!options.json);
	}
}

interface SessionEventsOpts {
	file: string;
	provider?: string;
	limit?: number;
	all?: boolean;
	json?: boolean;
}

export async function sessionEventsCommand(sessionId: string, options: SessionEventsOpts) {
	const ctx = await buildCliRuntime(options.file);
	const {
		items: events,
		hasMore,
		nextPage,
	} = await fetchAllPages(async (page) => {
		const result = page
			? await listSessionEvents(ctx, sessionId, {
					provider: options.provider,
					limit: options.limit,
					page_token: page,
				})
			: await listSessionEvents(ctx, sessionId, { provider: options.provider, limit: options.limit });
		return { items: result.events, hasMore: result.has_more, nextPage: result.next_page };
	}, options.all);

	if (options.json) {
		writeJson(toEventListJson(events, hasMore, nextPage));
		return;
	}

	if (events.length === 0) {
		log.info("No events found.");
		return;
	}

	printTableTitle("Events", events.length);
	printTableHeader(["#".padEnd(4), "Type".padEnd(14), "Content"], 60);

	for (let i = 0; i < events.length; i++) {
		const e = events[i]!;
		const idx = String(i + 1).padEnd(4);
		const typeLabel = e.type.padEnd(14);
		let preview = "";
		if (e.type === "message") preview = (e.content ?? "").slice(0, 60);
		else if (e.type === "tool_use") preview = e.tool_name ?? "";
		else if (e.type === "tool_result") preview = (e.content ?? "").slice(0, 60);
		else if (e.type === "status") preview = `${e.status ?? ""}${e.stop_reason ? ` (${e.stop_reason})` : ""}`;
		else if (e.type === "error") preview = (e.content ?? "").slice(0, 60);
		else if (e.type === "thinking") preview = chalk.dim("(thinking)");
		else preview = e.raw_type;

		const typeColor =
			e.type === "error"
				? chalk.red(typeLabel)
				: e.type === "status"
					? chalk.yellow(typeLabel)
					: e.type === "tool_use"
						? chalk.cyan(typeLabel)
						: typeLabel;

		printTableRow([chalk.dim(idx), typeColor, preview]);
	}
	printTableFooter();

	if (hasMore) {
		log.info("More events available. Use --all to fetch all.");
	}
}

function parseMemoryStores(value?: string): string[] | undefined {
	return value
		? value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: undefined;
}

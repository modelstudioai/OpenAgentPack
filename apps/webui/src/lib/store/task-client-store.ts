import { fetchProjectSessions } from "../domain/resource-center/fetch";
import { deleteSession, type SessionDetail } from "../domain/session-api";
import { type ClientTask, mapSession, mapSessionDetail, mergeClientTask } from "../view/task-view";

export type { ClientTask } from "../view/task-view";

interface TaskStoreSnapshot {
	tasks: ClientTask[];
	isLoading: boolean;
	isRefreshing: boolean;
	error: string | null;
}

type TaskStoreListener = () => void;

const ACTIVE_REFRESH_MS = 2500;
const MIN_REFRESH_GAP_MS = 2000;
const VISIBLE_REFRESH_GAP_MS = 1500;

let snapshot: TaskStoreSnapshot = {
	tasks: [],
	isLoading: false,
	isRefreshing: false,
	error: null,
};
const listeners = new Set<TaskStoreListener>();
let refreshPromise: Promise<void> | null = null;
let timer: number | null = null;
let visibilityBound = false;
// Composer + BottomBar mount multiple TaskBox instances; guard so only one cold fetch runs.
let initialFetchScheduled = false;
let lastRefreshAt = 0;
let lastVisibleRefreshAt = 0;
/** Provider 切换时递增，丢弃进行中的旧列表结果，避免盖住新 provider 数据 */
let fetchGeneration = 0;

export function subscribeTaskStore(listener: TaskStoreListener): () => void {
	listeners.add(listener);
	ensureTaskPolling();
	if (!initialFetchScheduled && !refreshPromise) {
		initialFetchScheduled = true;
		void refreshTaskStore();
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			stopTaskPolling();
			initialFetchScheduled = false;
		}
	};
}

export function getTaskStoreSnapshot(): TaskStoreSnapshot {
	return snapshot;
}

export function addTaskToStore(detail: SessionDetail): ClientTask {
	const mapped = mapSessionDetail(detail);
	setSnapshot({
		...snapshot,
		tasks: [mapped, ...snapshot.tasks.filter((item) => item.id !== mapped.id)],
		error: null,
	});
	return mapped;
}

export function updateTaskInStore(task: ClientTask): void {
	setSnapshot({
		...snapshot,
		tasks: snapshot.tasks.map((item) => (item.id === task.id ? task : item)),
	});
}

/**
 * Delete a session and drop it from the list. Removes the task optimistically so the UI reacts
 * instantly; on failure it re-fetches to resync against the server's true state and rethrows so
 * the caller can surface the error. Routes the delete to the session's own owning agent id.
 */
export async function removeTaskFromStore(id: string): Promise<void> {
	const agentId = snapshot.tasks.find((task) => task.id === id)?.agentId;
	setSnapshot({ ...snapshot, tasks: snapshot.tasks.filter((item) => item.id !== id) });
	try {
		await deleteSession(id, agentId);
	} catch (error) {
		setSnapshot({
			...snapshot,
			error: error instanceof Error ? error.message : String(error),
		});
		void refreshTaskStore({ force: true });
		throw error;
	}
}

export async function refreshTaskStore(options: { force?: boolean } = {}): Promise<void> {
	if (refreshPromise) return refreshPromise;
	if (!options.force && Date.now() - lastRefreshAt < MIN_REFRESH_GAP_MS) return;
	if (options.force && timer !== null) {
		window.clearTimeout(timer);
		timer = null;
	}
	const isInitial = snapshot.tasks.length === 0;
	const generation = fetchGeneration;
	lastRefreshAt = Date.now();
	setSnapshot({
		...snapshot,
		isLoading: isInitial,
		isRefreshing: !isInitial,
		error: null,
	});

	// Homepage task list = "my current tasks": an archived role's tasks should drop off, so scope the
	// session fan-out to active agents only (also shrinks the per-agent listSessions fan-out).
	refreshPromise = fetchProjectSessions(undefined, { includeArchived: false })
		.then((sessions) => {
			if (generation !== fetchGeneration) return;
			const mapped = sessions.map((session) => mapSession(session));
			setSnapshot({
				...snapshot,
				tasks: mergeById(mapped, snapshot.tasks),
				isLoading: false,
				isRefreshing: false,
				error: null,
			});
		})
		.catch((error) => {
			if (generation !== fetchGeneration) return;
			setSnapshot({
				...snapshot,
				isLoading: false,
				isRefreshing: false,
				error: error instanceof Error ? error.message : String(error),
			});
		})
		.finally(() => {
			if (generation === fetchGeneration) {
				refreshPromise = null;
				scheduleNextRefresh();
			}
		});

	return refreshPromise;
}

/** Provider 切换后清空旧会话列表并强制按新凭据重拉 */
export function resetTaskStoreForProviderChange(): void {
	fetchGeneration += 1;
	refreshPromise = null;
	lastRefreshAt = 0;
	lastVisibleRefreshAt = 0;
	if (timer !== null) {
		window.clearTimeout(timer);
		timer = null;
	}
	setSnapshot({
		tasks: [],
		isLoading: listeners.size > 0,
		isRefreshing: false,
		error: null,
	});
	if (listeners.size > 0) {
		void refreshTaskStore({ force: true });
	} else {
		// 下次有订阅者挂载时再冷拉
		initialFetchScheduled = false;
	}
}

function ensureTaskPolling(): void {
	if (!visibilityBound) {
		visibilityBound = true;
		document.addEventListener("visibilitychange", handleVisibilityChange);
	}
	scheduleNextRefresh();
}

function stopTaskPolling(): void {
	if (timer !== null) {
		window.clearTimeout(timer);
		timer = null;
	}
	if (visibilityBound) {
		visibilityBound = false;
		document.removeEventListener("visibilitychange", handleVisibilityChange);
	}
}

// Refresh when the user returns to the TAB (document becomes visible), not on window `focus`.
// A `focus` listener would fire a full fetchProjectSessions fan-out on every click into the
// app. visibilitychange only fires on real tab show/hide, so it can't be triggered by in-page hover.
function handleVisibilityChange(): void {
	if (document.visibilityState !== "visible") return;
	const now = Date.now();
	if (now - lastVisibleRefreshAt < VISIBLE_REFRESH_GAP_MS) return;
	lastVisibleRefreshAt = now;
	void refreshTaskStore({ force: true });
}

function scheduleNextRefresh(): void {
	if (listeners.size === 0 || timer !== null) return;
	const hasRunning = snapshot.tasks.some((task) => task.status === "running");
	if (!hasRunning) return;
	timer = window.setTimeout(() => {
		timer = null;
		void refreshTaskStore();
	}, ACTIVE_REFRESH_MS);
}

function setSnapshot(next: TaskStoreSnapshot): void {
	snapshot = next;
	for (const listener of listeners) listener();
}

// Adopt the freshly fetched project sessions (already newest-first), preserving any streamed
// `events` on tasks the user has open. Keep current-only tasks (e.g. an optimistic create the
// server hasn't surfaced yet) so they don't flicker out, then re-sort newest-first.
function mergeById(fetched: ClientTask[], current: ClientTask[]): ClientTask[] {
	const fetchedIds = new Set(fetched.map((task) => task.id));
	const merged = fetched.map((task) =>
		mergeClientTask(
			task,
			current.find((item) => item.id === task.id),
		),
	);
	const currentOnly = current.filter((item) => !fetchedIds.has(item.id));
	return [...merged, ...currentOnly].sort((a, b) => b.updatedAt - a.updatedAt);
}

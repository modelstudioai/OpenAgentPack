import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { fetchEnvironments } from "@/lib/domain/environment";
import { listFiles } from "@/lib/domain/file-api";
import {
	deriveEnvironments,
	deriveFiles,
	deriveReferencedMcpServers,
	deriveReferencedSkills,
	deriveResourceTopology,
	deriveSkills,
	deriveVaults,
	fetchProjectSessions,
	fetchResourceCenter,
	type ResourceAgentRow,
	type ResourceCenterView,
	type ResourceSkillRow,
} from "@/lib/domain/resource-center";
import { listOfficialSkills, listSkills } from "@/lib/domain/skill-api";
import { fetchVaults } from "@/lib/domain/vault";
import { useProviderConfigRevision } from "@/lib/store/provider-config-store";

// Re-derive per-agent task counts from a (refreshed) session list.
function withTaskCounts(agents: ResourceAgentRow[], sessions: ResourceCenterView["sessions"]): ResourceAgentRow[] {
	const byAgentId = new Map<string, number>();
	for (const s of sessions) {
		const id = s.agent?.agent_id;
		if (id) byAgentId.set(id, (byAgentId.get(id) ?? 0) + 1);
	}
	return agents.map((a) => ({ ...a, taskCount: byAgentId.get(a.id) ?? 0 }));
}

export function withReferencedResources(
	view: ResourceCenterView,
	catalogs?: { customSkills?: ResourceSkillRow["raw"][]; officialSkills?: ResourceSkillRow["raw"][] },
): ResourceCenterView {
	return {
		...view,
		referencedSkills: deriveReferencedSkills(
			catalogs?.customSkills ?? view.skills.map((skill) => skill.raw),
			catalogs?.officialSkills ?? view.officialSkills.map((skill) => skill.raw),
		),
		referencedMcpServers: deriveReferencedMcpServers(view.agents),
	};
}

// The fetched view plus its loading/error status are one async-fetch unit. A reducer keeps the
// initial load and every per-panel mutation as single dispatches, so no effect cascades setState.
interface RcState {
	view: ResourceCenterView | null;
	loading: boolean;
	error: string | null;
}

type RcAction =
	| { type: "loadStart" }
	| { type: "loadOk"; view: ResourceCenterView }
	| { type: "loadErr"; error: string }
	| { type: "setError"; error: string | null }
	| { type: "updateView"; fn: (prev: ResourceCenterView) => ResourceCenterView };

function rcReducer(state: RcState, action: RcAction): RcState {
	switch (action.type) {
		case "loadStart":
			return { ...state, loading: true, error: null };
		case "loadOk":
			return { ...state, loading: false, view: action.view };
		case "loadErr":
			return { ...state, loading: false, error: action.error };
		case "setError":
			return { ...state, error: action.error };
		case "updateView":
			return state.view ? { ...state, view: action.fn(state.view) } : state;
	}
}

export function useResourceCenter() {
	const [state, dispatch] = useReducer(rcReducer, { view: null, loading: true, error: null });
	const { view, loading, error } = state;
	const [refreshKey, setRefreshKey] = useState(0);
	const providerRevision = useProviderConfigRevision();

	// Per-panel refresh flags
	const [refreshingSessions, setRefreshingSessions] = useState(false);
	const [refreshingFiles, setRefreshingFiles] = useState(false);
	const [refreshingSkills, setRefreshingSkills] = useState(false);
	const [refreshingEnv, setRefreshingEnv] = useState(false);
	const [refreshingVault, setRefreshingVault] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey / providerRevision 手动触发重拉
	useEffect(() => {
		let cancelled = false;
		dispatch({ type: "loadStart" });
		fetchResourceCenter()
			.then((v) => {
				if (!cancelled) dispatch({ type: "loadOk", view: v });
			})
			.catch((e: unknown) => {
				if (!cancelled) dispatch({ type: "loadErr", error: e instanceof Error ? e.message : "加载失败" });
			});
		return () => {
			cancelled = true;
		};
	}, [refreshKey, providerRevision]);

	const topology = useMemo(() => (view ? deriveResourceTopology(view) : null), [view]);

	const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

	const setError = useCallback((e: string | null) => dispatch({ type: "setError", error: e }), []);

	const updateView = useCallback(
		(fn: (prev: ResourceCenterView) => ResourceCenterView) => dispatch({ type: "updateView", fn }),
		[],
	);

	// --- Per-panel refreshes ---
	const refreshSessions = useCallback(async () => {
		setRefreshingSessions(true);
		dispatch({ type: "setError", error: null });
		try {
			const sessions = await fetchProjectSessions();
			dispatch({
				type: "updateView",
				fn: (prev) => ({
					...prev,
					sessions,
					agents: withTaskCounts(prev.agents, sessions),
					metrics: { ...prev.metrics, totalTasks: sessions.length },
				}),
			});
		} catch (e) {
			dispatch({ type: "setError", error: e instanceof Error ? e.message : "刷新会话失败" });
		} finally {
			setRefreshingSessions(false);
		}
	}, []);

	const refreshFiles = useCallback(async () => {
		setRefreshingFiles(true);
		dispatch({ type: "setError", error: null });
		try {
			const files = deriveFiles(await listFiles());
			dispatch({ type: "updateView", fn: (prev) => ({ ...prev, files }) });
		} catch (e) {
			dispatch({ type: "setError", error: e instanceof Error ? e.message : "刷新文件失败" });
		} finally {
			setRefreshingFiles(false);
		}
	}, []);

	const refreshSkills = useCallback(async () => {
		setRefreshingSkills(true);
		dispatch({ type: "setError", error: null });
		try {
			const [custom, official] = await Promise.all([listSkills(), listOfficialSkills()]);
			const skillRows = deriveSkills(custom);
			dispatch({
				type: "updateView",
				fn: (prev) =>
					withReferencedResources(
						{
							...prev,
							skills: skillRows,
							officialSkills: deriveSkills(official),
							metrics: { ...prev.metrics, skillCount: skillRows.length },
						},
						{ customSkills: custom, officialSkills: official },
					),
			});
		} catch (e) {
			dispatch({ type: "setError", error: e instanceof Error ? e.message : "刷新 Skill 失败" });
		} finally {
			setRefreshingSkills(false);
		}
	}, []);

	const refreshEnvironments = useCallback(async () => {
		setRefreshingEnv(true);
		dispatch({ type: "setError", error: null });
		try {
			const { rows, baseId } = deriveEnvironments(await fetchEnvironments());
			dispatch({ type: "updateView", fn: (prev) => ({ ...prev, environments: rows, baseEnvironmentId: baseId }) });
		} catch (e) {
			dispatch({ type: "setError", error: e instanceof Error ? e.message : "刷新运行环境失败" });
		} finally {
			setRefreshingEnv(false);
		}
	}, []);

	const refreshVaults = useCallback(async () => {
		setRefreshingVault(true);
		dispatch({ type: "setError", error: null });
		try {
			const { rows, baseVaultId } = deriveVaults(await fetchVaults());
			dispatch({ type: "updateView", fn: (prev) => ({ ...prev, vaults: rows, baseVaultId }) });
		} catch (e) {
			dispatch({ type: "setError", error: e instanceof Error ? e.message : "刷新密钥库失败" });
		} finally {
			setRefreshingVault(false);
		}
	}, []);

	return {
		view,
		loading,
		error,
		setError,
		topology,
		refresh,
		updateView,
		refreshingSessions,
		refreshingFiles,
		refreshingSkills,
		refreshingEnv,
		refreshingVault,
		refreshSessions,
		refreshFiles,
		refreshSkills,
		refreshEnvironments,
		refreshVaults,
	};
}

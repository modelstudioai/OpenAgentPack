import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import BottomBar, { type BottomBarHandle } from "@/components/BottomBar";
import Composer, { type ComposerHandle } from "@/components/Composer";
import ConfirmDialog from "@/components/ConfirmDialog";
import GlobalToastHost from "@/components/GlobalToastHost";
import HeroGreeting from "@/components/HeroGreeting";
import PromptDialog from "@/components/PromptDialog";
import { PromptEditorProvider } from "@/components/prompt-editor/PromptEditorProvider";
import RoleCards from "@/components/RoleCards";
import ResourceCenter from "@/components/resource-center";
import ScheduleCenter from "@/components/ScheduleCenter";
import SettingsDialog from "@/components/SettingsDialog";
import Showcase from "@/components/Showcase";
import TopBar from "@/components/TopBar";
import WarmBanner from "@/components/WarmBanner";
import { getModels, type UiModel } from "@/lib/domain/model-api";
import { type WarmProgress, warmWorkspace } from "@/lib/domain/warm";
import { useAgentsConfigReady } from "@/lib/hooks/useAgentsConfigReady";
import { getRoleCards } from "@/lib/playbooks";
import type { RoleCard } from "@/lib/playbooks/types";
import { isPlaygroundMode } from "@/lib/runtime-mode";
import type { SchedulePreset } from "@/lib/schedule";
import { useProviderConfigRevision } from "@/lib/store/provider-config-store";
import { useTopBarView } from "@/lib/use-topbar-view";

// Fallback while the provider's model list is still loading. An empty string makes createSession
// omit the model, so the backend applies the provider's own default (never a hardcoded id that a
// non-bailian provider would reject).
const DEFAULT_MODEL = "";

interface MakeSameInput {
	prompt: string;
	agentId?: string;
}

// Active-playbook selection: which role is explicitly picked, which the carousel highlights, and a
// transient "做同款" agent override. They change together through the same handlers, so a reducer
// keeps them as one logical unit instead of three independent renders.
interface PlaybookState {
	selectedRoleId: string | null;
	highlightedIndex: number;
	agentOverride: string | null;
}

type PlaybookAction =
	| { type: "selectRole"; id: string | null; clearOverride: boolean }
	| { type: "setIndex"; index: number }
	| { type: "override"; agentId: string | null };

function playbookReducer(state: PlaybookState, action: PlaybookAction): PlaybookState {
	switch (action.type) {
		case "selectRole":
			return { ...state, selectedRoleId: action.id, agentOverride: action.clearOverride ? null : state.agentOverride };
		case "setIndex":
			return { ...state, highlightedIndex: action.index };
		case "override":
			return { ...state, agentOverride: action.agentId };
	}
}

export default function Home() {
	const [view, setView] = useTopBarView();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const showSettings = isPlaygroundMode();
	const providerRevision = useProviderConfigRevision();
	const { ready: providerConfigReady } = useAgentsConfigReady(showSettings, providerRevision);
	const canSubmit = !showSettings || providerConfigReady;
	const [inputValue, setInputValue] = useState("");
	const [playbook, dispatchPlaybook] = useReducer(playbookReducer, {
		selectedRoleId: null,
		highlightedIndex: 0,
		agentOverride: null,
	});
	const [roleCards, setRoleCards] = useState<RoleCard[]>([]);
	const [models, setModels] = useState<UiModel[]>([]);
	const [selectedModelsByAgent, setSelectedModelsByAgent] = useState<Record<string, string>>({});
	const [warmProgress, setWarmProgress] = useState<WarmProgress | null>(null);
	const [scheduleDraft, setScheduleDraft] = useState<{
		key: number;
		preset?: SchedulePreset;
		prompt: string;
		playbookId: string;
	}>({ key: 0, prompt: "", playbookId: "" });
	// Only read inside handlers (top composer vs. bottom bar routing), never rendered — a ref avoids
	// re-rendering the whole page each time the bar scrolls in or out of view.
	const bottomBarVisibleRef = useRef(false);
	const bottomBarRef = useRef<BottomBarHandle>(null);
	const composerRef = useRef<HTMLDivElement>(null);
	const composerHandleRef = useRef<ComposerHandle>(null);

	const { selectedRoleId, highlightedIndex, agentOverride } = playbook;

	// Active playbook → agent slug. A "做同款" override wins; otherwise the explicitly
	// selected role, otherwise the carousel-highlighted role. Never a hardcoded id.
	const activeRole = selectedRoleId ? roleCards.find((r) => r.slug === selectedRoleId) : roleCards[highlightedIndex];
	const activeAgentSlug = agentOverride ?? activeRole?.slug ?? roleCards[0]?.slug ?? "";
	// Per-agent explicit pick wins; otherwise the provider's first model; otherwise "" (backend
	// applies the provider default). Never a hardcoded id — that's what broke non-bailian providers.
	const selectedModel =
		(activeAgentSlug ? selectedModelsByAgent[activeAgentSlug] : undefined) ?? models[0]?.id ?? DEFAULT_MODEL;

	// biome-ignore lint/correctness/useExhaustiveDependencies: providerRevision 触发整页数据重拉
	useEffect(() => {
		let cancelled = false;
		void getModels().then((next) => {
			if (cancelled) return;
			setModels(next);
			// 清空旧 provider 下的模型选择，避免把不兼容 model id 提交出去
			setSelectedModelsByAgent({});
		});
		return () => {
			cancelled = true;
		};
	}, [providerRevision]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: providerRevision 触发新 provider 预热
	useEffect(() => {
		setWarmProgress(null);
		void warmWorkspace(setWarmProgress);
	}, [providerRevision]);

	useEffect(() => {
		let cancelled = false;
		void getRoleCards().then((cards) => {
			if (cancelled) return;
			setRoleCards(cards);
			if (providerRevision > 0) {
				dispatchPlaybook({ type: "selectRole", id: null, clearOverride: true });
				dispatchPlaybook({ type: "setIndex", index: 0 });
			}
		});
		return () => {
			cancelled = true;
		};
	}, [providerRevision]);

	// "做同款" context-aware handler
	const handleMakeSame = useCallback((input: MakeSameInput) => {
		dispatchPlaybook({ type: "override", agentId: input.agentId ?? null });

		if (bottomBarVisibleRef.current) {
			// Fill bottom bar
			setInputValue(input.prompt);
			bottomBarRef.current?.expand();
		} else {
			// Fill top composer
			setInputValue(input.prompt);
			window.scrollTo({ top: 0, behavior: "smooth" });
			setTimeout(() => composerHandleRef.current?.focus(), 400);
		}
	}, []);

	const handleBottomBarVisibility = useCallback((visible: boolean) => {
		bottomBarVisibleRef.current = visible;
	}, []);

	// 选中角色时自动填充输入框
	const handleSelectRole = useCallback(
		(id: string | null) => {
			const role = id ? roleCards.find((r) => r.slug === id) : undefined;
			const hasPrompt = !!role?.prompt;
			dispatchPlaybook({ type: "selectRole", id, clearOverride: hasPrompt });
			if (!id || !hasPrompt) return;
			setInputValue(role.prompt);
			if (bottomBarVisibleRef.current) {
				bottomBarRef.current?.expand();
			} else {
				setTimeout(() => composerHandleRef.current?.focusStart(), 80);
			}
		},
		[roleCards],
	);

	const handleActiveIndexChange = useCallback((idx: number) => {
		dispatchPlaybook({ type: "setIndex", index: idx });
	}, []);

	// Model switching is local per playbook. The selected model rides createSession, where both
	// transports sync the agent immediately before starting the run.
	const handleModelChange = useCallback(
		(model: string) => {
			if (!activeAgentSlug) return;
			setSelectedModelsByAgent((prev) => ({ ...prev, [activeAgentSlug]: model }));
		},
		[activeAgentSlug],
	);

	const handleOpenSchedule = useCallback(
		(preset?: SchedulePreset) => {
			setScheduleDraft((current) => ({
				key: current.key + 1,
				preset,
				prompt: inputValue,
				playbookId: activeAgentSlug,
			}));
			setView("schedule");
			window.scrollTo({ top: 0, behavior: "smooth" });
		},
		[activeAgentSlug, inputValue, setView],
	);

	return (
		<PromptEditorProvider inputValue={inputValue} onInputChange={setInputValue}>
			<GlobalToastHost />
			{view === "resources" || view === "schedule" ? (
				<>
					<div className="page-shell">
						<WarmBanner progress={warmProgress} />
						<TopBar
							view={view}
							onNavigate={setView}
							showSettings={showSettings}
							settingsOpen={settingsOpen}
							onOpenSettings={() => setSettingsOpen(true)}
						/>
						{view === "resources" ? <ResourceCenter /> : <ScheduleCenter draft={scheduleDraft} />}
					</div>
					<ConfirmDialog />
					<PromptDialog />
					<SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
				</>
			) : (
				<>
					<div className="page-shell">
						<WarmBanner progress={warmProgress} />
						<TopBar
							view={view}
							onNavigate={setView}
							showSettings={showSettings}
							settingsOpen={settingsOpen}
							onOpenSettings={() => setSettingsOpen(true)}
						/>

						<main>
							<section className="hero" aria-labelledby="hero-title">
								{roleCards.length > 0 && (
									<HeroGreeting
										roleCards={roleCards}
										selectedRoleId={selectedRoleId}
										onActiveIndexChange={handleActiveIndexChange}
									/>
								)}
								{roleCards.length > 0 && (
									<RoleCards
										roleCards={roleCards}
										selectedId={selectedRoleId}
										onSelect={handleSelectRole}
										highlightedIndex={highlightedIndex}
									/>
								)}

								<div ref={composerRef}>
									<Composer
										ref={composerHandleRef}
										inputValue={inputValue}
										onInputChange={setInputValue}
										agentId={activeAgentSlug}
										roleCards={roleCards}
										activeRoleIndex={highlightedIndex}
										model={selectedModel}
										models={models}
										onModelChange={handleModelChange}
										onMakeSame={handleMakeSame}
										onOpenSchedule={handleOpenSchedule}
										canSubmit={canSubmit}
									/>
								</div>
							</section>
						</main>

						<Showcase onMakeSame={handleMakeSame} />
					</div>

					<BottomBar
						ref={bottomBarRef}
						inputValue={inputValue}
						onInputChange={setInputValue}
						agentId={activeAgentSlug}
						model={selectedModel}
						models={models}
						onModelChange={handleModelChange}
						composerRef={composerRef as React.RefObject<HTMLElement | null>}
						onVisibilityChange={handleBottomBarVisibility}
						onMakeSame={handleMakeSame}
						onOpenSchedule={handleOpenSchedule}
						canSubmit={canSubmit}
					/>

					<ConfirmDialog />
					<PromptDialog />
					<SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
				</>
			)}
		</PromptEditorProvider>
	);
}

import { useSyncExternalStore } from "react";
import { setActiveTask } from "./active-task-store";
import { resetTaskStoreForProviderChange } from "./task-client-store";

/**
 * Provider 凭据切换后的全局 revision。
 * Settings 保存成功后 bump，首页模型/玩法/预热、任务列表、资源中心等据此整页重拉。
 */
let revision = 0;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

export function getProviderConfigRevision(): number {
	return revision;
}

export function subscribeProviderConfig(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Provider 配置已落盘并生效后调用 */
export function notifyProviderConfigChanged(): void {
	revision += 1;
	setActiveTask(null);
	resetTaskStoreForProviderChange();
	emit();
}

export function useProviderConfigRevision(): number {
	return useSyncExternalStore(subscribeProviderConfig, getProviderConfigRevision, getProviderConfigRevision);
}

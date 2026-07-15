import { useEffect, useState } from "react";
import { loadAgentsConfigReady } from "@/lib/domain/config-api";

/** Returns whether the playground server has complete provider credentials in its runtime env. */
export function useAgentsConfigReady(enabled: boolean, refreshKey: string | number | boolean = 0) {
	const [ready, setReady] = useState(true);
	const [loading, setLoading] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey only triggers this effect when it changes
	useEffect(() => {
		if (!enabled) {
			setReady(true);
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setReady(false);
		void loadAgentsConfigReady().then((isReady) => {
			if (cancelled) return;
			setReady(isReady);
			setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [enabled, refreshKey]);

	return { ready, loading };
}

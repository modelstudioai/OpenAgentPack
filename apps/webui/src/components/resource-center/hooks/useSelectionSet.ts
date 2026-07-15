import { useCallback, useState } from "react";

/**
 * Generic multi-selection hook used by sessions, files, and skills panels.
 * Manages a Set<string> of selected ids with toggle/toggleAll/clear helpers.
 */
export function useSelectionSet() {
	const [selected, setSelected] = useState<Set<string>>(() => new Set());

	const toggle = useCallback((id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const toggleAll = useCallback((ids: string[], select: boolean) => {
		setSelected((prev) => {
			const next = new Set(prev);
			for (const id of ids) {
				if (select) next.add(id);
				else next.delete(id);
			}
			return next;
		});
	}, []);

	const clear = useCallback(() => {
		setSelected(new Set());
	}, []);

	const remove = useCallback((id: string) => {
		setSelected((prev) => {
			if (!prev.has(id)) return prev;
			const next = new Set(prev);
			next.delete(id);
			return next;
		});
	}, []);

	const removeMany = useCallback((ids: Iterable<string>) => {
		setSelected((prev) => {
			const next = new Set(prev);
			for (const id of ids) next.delete(id);
			return next;
		});
	}, []);

	return { selected, toggle, toggleAll, clear, remove, removeMany };
}

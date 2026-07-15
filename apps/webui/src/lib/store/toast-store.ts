export interface Toast {
	id: string;
	sessionId: string;
	variant: "done" | "submitted" | "failed";
	title: string;
	desc: string;
}

let toasts: Toast[] = [];
const toastListeners = new Set<() => void>();

function emitToasts(): void {
	for (const listener of toastListeners) listener();
}

export function subscribeToasts(listener: () => void): () => void {
	toastListeners.add(listener);
	return () => toastListeners.delete(listener);
}

export function getToasts(): Toast[] {
	return toasts;
}

export function pushToast(toast: Toast): void {
	toasts = [...toasts, toast];
	emitToasts();
	setTimeout(() => dismissToast(toast.id), toast.variant === "submitted" ? 3000 : 6000);
}

export function dismissToast(id: string): void {
	toasts = toasts.filter((t) => t.id !== id);
	emitToasts();
}

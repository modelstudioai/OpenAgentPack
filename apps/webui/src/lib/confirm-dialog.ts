export type ConfirmRequest = {
	title: string;
	message?: string;
	confirmText?: string;
	cancelText?: string;
	/** Render the confirm button in a destructive (red) style. */
	danger?: boolean;
	/** When false, the dialog cannot be dismissed: the cancel button is hidden and Escape is ignored,
	 * leaving only the confirm action. Defaults to true (cancellable). */
	cancellable?: boolean;
};

// Imperative bridge mirroring provisioning.ts: <ConfirmDialog/> registers an opener;
// callers await confirmDialog(...) for the user's choice. Singleton so one mounted
// dialog serves every caller.
let opener: ((req: ConfirmRequest) => Promise<boolean>) | null = null;

export function registerConfirmDialog(fn: (req: ConfirmRequest) => Promise<boolean>): () => void {
	opener = fn;
	return () => {
		if (opener === fn) opener = null;
	};
}

/** Ask the user to confirm. Resolves true to proceed. Defaults to false (safe for destructive
 * actions) when no dialog is mounted. */
export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
	return opener ? opener(req) : Promise.resolve(false);
}

export type PromptRequest = {
	title: string;
	message?: string;
	placeholder?: string;
	confirmText?: string;
	cancelText?: string;
	/** Mask the input (e.g. for secrets/API keys). */
	secret?: boolean;
	/** When set, render a dropdown of these choices instead of a free-text field; the resolved
	 * value is the selected option's `value`. */
	options?: { label: string; value: string }[];
	/** Only meaningful with `options`: append a "手动输入" choice that reveals the free-text field,
	 * letting the user type a value not in the list. */
	allowManual?: boolean;
	/** When false, the dialog cannot be dismissed without providing a value: the cancel button is
	 * hidden and Escape is ignored. Defaults to true (cancellable). */
	cancellable?: boolean;
};

// Imperative bridge mirroring confirmDialog: <PromptDialog/> registers an opener; callers
// await promptDialog(...) for the entered string (null on cancel). Singleton.
let promptOpener: ((req: PromptRequest) => Promise<string | null>) | null = null;

export function registerPromptDialog(fn: (req: PromptRequest) => Promise<string | null>): () => void {
	promptOpener = fn;
	return () => {
		if (promptOpener === fn) promptOpener = null;
	};
}

/** Ask the user for a single line of text. Resolves the trimmed value, or null on cancel /
 * when no dialog is mounted. */
export function promptDialog(req: PromptRequest): Promise<string | null> {
	return promptOpener ? promptOpener(req) : Promise.resolve(null);
}

import { useState } from "react";
import { provisionGate, willProvision } from "@/lib/agents/provisioning";
import { stripPrefix } from "@/lib/domain/file-api";
import { createSessionFromPrompt } from "@/lib/domain/session-api";
import { filesFromEntries, type SelectedFileEntry } from "@/lib/hooks/selected-files";
import { buildFileBindings } from "@/lib/hooks/useFileUploads";
import { beginPendingTask, commitCreatedTask, failPendingTask } from "@/lib/store/task-submit-actions";

interface SubmitTaskArgs {
	prompt: string;
	agentId: string;
	model: string;
	selectedFiles: SelectedFileEntry[];
}

interface UseSubmitTaskResult {
	isSubmitting: boolean;
	submitTask: (args: SubmitTaskArgs, onSuccess: () => void) => Promise<void>;
}

/**
 * Shared task-creation flow for Composer and BottomBar: provision gate → optimistic
 * pending task → createSessionFromPrompt → created task. Both surfaces share identical
 * submit logic; this hook concentrates it in one place so bug fixes and event-shape changes
 * land once. Drives the task stores directly (via task-submit-actions) rather than broadcasting
 * DOM events.
 */
export function useSubmitTask(): UseSubmitTaskResult {
	const [isSubmitting, setIsSubmitting] = useState(false);

	const submitTask = async (args: SubmitTaskArgs, onSuccess: () => void) => {
		const prompt = args.prompt.trim();
		if (!prompt || isSubmitting) return;

		const uploaded = filesFromEntries(args.selectedFiles);
		const files = buildFileBindings(uploaded);
		const attachedFiles = uploaded.map((file) => stripPrefix(file.filename));
		setIsSubmitting(true);
		const pendingId = `pending-${Date.now()}`;
		try {
			if (!(await provisionGate(args.agentId))) return;
			const provisioning = willProvision(args.agentId);
			beginPendingTask({ id: pendingId, prompt, agentId: args.agentId, provisioning, attachedFiles });
			const task = await createSessionFromPrompt(prompt, args.agentId, { files, model: args.model });
			commitCreatedTask(task, pendingId);
			onSuccess();
		} catch (error) {
			failPendingTask(error instanceof Error ? error.message : String(error), pendingId);
		} finally {
			setIsSubmitting(false);
		}
	};

	return { isSubmitting, submitTask };
}

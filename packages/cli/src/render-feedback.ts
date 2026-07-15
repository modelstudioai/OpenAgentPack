import type { RuntimeFeedbackEvent, RuntimeFeedbackSink } from "@openagentpack/sdk";
import { log } from "./logger.ts";

export interface RuntimeFeedbackBuffer {
	onFeedback: RuntimeFeedbackSink;
	flush(): void;
}

export function createRuntimeFeedbackBuffer(): RuntimeFeedbackBuffer {
	const events: RuntimeFeedbackEvent[] = [];

	return {
		onFeedback(event) {
			events.push(event);
		},
		flush() {
			for (const event of events.splice(0)) {
				renderRuntimeFeedback(event);
			}
		},
	};
}

export function renderRuntimeFeedback(event: RuntimeFeedbackEvent): void {
	if (event.type === "resource_adopted") {
		log.adopt(event.message);
		return;
	}
	if (event.type === "resource_already_gone" || event.type === "refresh_resource_missing") {
		log.gone(event.message);
		return;
	}
	if (event.level === "success") {
		log.success(event.message);
		return;
	}
	if (event.level === "warning") {
		log.warn(event.message);
		return;
	}
	if (event.level === "error") {
		log.error(event.message);
		return;
	}
	log.info(event.message);
}

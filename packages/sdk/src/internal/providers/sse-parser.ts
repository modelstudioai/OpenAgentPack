/** Transport fields stay separate from the provider's JSON message identity. */
export interface SseFrame {
	data: string;
	event?: string;
	id?: string;
}

/** Incremental SSE framing. Decoding bytes is the transport's responsibility. */
export class SseParser {
	private line = "";
	private skipLf = false;
	private data: string[] = [];
	private event: string | undefined;
	private id: string | undefined;

	push(text: string): SseFrame[] {
		const frames: SseFrame[] = [];
		for (const char of text) {
			if (this.skipLf) {
				this.skipLf = false;
				if (char === "\n") continue;
			}
			if (char === "\r" || char === "\n") {
				const frame = this.consumeLine();
				if (frame) frames.push(frame);
				this.skipLf = char === "\r";
			} else {
				this.line += char;
			}
		}
		return frames;
	}

	private consumeLine(): SseFrame | undefined {
		const line = this.line;
		this.line = "";
		if (line === "") {
			const frame = this.data.length ? { data: this.data.join("\n"), event: this.event, id: this.id } : undefined;
			this.data = [];
			this.event = undefined;
			this.id = undefined;
			return frame;
		}
		if (line.startsWith(":")) return undefined;
		const colon = line.indexOf(":");
		const name = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		switch (name) {
			case "data":
				this.data.push(value);
				break;
			case "event":
				this.event = value;
				break;
			case "id":
				if (!value.includes("\0")) this.id = value;
				break;
		}
		return undefined;
	}
}

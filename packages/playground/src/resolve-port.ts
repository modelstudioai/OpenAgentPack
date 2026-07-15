import { createServer } from "node:net";

const MAX_PORT_ATTEMPTS = 50;

/** Probe whether a TCP port can be bound the same way the playground server binds (all interfaces). */
function canListen(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.once("listening", () => {
			server.close(() => resolve(true));
		});
		// Match @hono/node-server's default bind (0.0.0.0 / ::). Probing only 127.0.0.1
		// can falsely succeed on macOS when another process already holds 0.0.0.0:port.
		server.listen(port);
	});
}

/** Pick the first available port starting at `preferred`. */
export async function resolveListenPort(preferred: number, maxAttempts: number = MAX_PORT_ATTEMPTS): Promise<number> {
	if (!Number.isInteger(preferred) || preferred <= 0 || preferred > 65535) {
		throw new Error(`Invalid port: ${preferred}`);
	}
	for (let offset = 0; offset < maxAttempts; offset++) {
		const port = preferred + offset;
		if (port > 65535) break;
		if (await canListen(port)) return port;
	}
	throw new Error(`No available port found in range ${preferred}-${Math.min(preferred + maxAttempts - 1, 65535)}`);
}

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS_CONFIG_PROVIDERS } from "@openagentpack/sdk";
import { log } from "../logger.ts";

const CLI_PKG = "@openagentpack/cli";
const PLAYGROUND_PKG = "@openagentpack/playground";
const DEFAULT_PORT = 4848;
const PLAYGROUND_URL_RE = /running at http:\/\/localhost:(\d+)/;
const SUPPORTED_PLAYGROUND_PROVIDERS = new Set<string>(AGENTS_CONFIG_PROVIDERS);

interface PlaygroundOptions {
	port?: string;
	provider?: string;
	open?: boolean;
}

function cliVersion(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(here, "../package.json"), // bundled dist/chunk-*.js -> package root
		resolve(here, "../../package.json"), // source src/commands/*.ts -> package root
	];

	for (const pkgPath of candidates) {
		if (!existsSync(pkgPath)) continue;
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
		if (pkg.name === CLI_PKG && pkg.version) return pkg.version;
	}
	throw new Error(`Unable to determine ${CLI_PKG} version for launching ${PLAYGROUND_PKG}.`);
}

function findLocalPlaygroundBin(startDir: string): string | undefined {
	let dir = startDir;
	for (let depth = 0; depth < 10; depth++) {
		const candidate = resolve(dir, "packages/playground/dist/bin/playground.js");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

// Launch order: an explicit prebuilt bin (AGENTS_PLAYGROUND_BIN, for offline/CI/self-built), then
// a co-installed package, then a monorepo-local build (when developing OpenAgentPack from source), then
// on-demand fetch via npx so `@openagentpack/cli` stays lightweight and the UI is pulled only when asked for.
function resolveLauncher(version: string): { cmd: string; args: string[] } {
	const explicit = process.env.AGENTS_PLAYGROUND_BIN?.trim();
	if (explicit && existsSync(explicit)) return { cmd: process.execPath, args: [explicit] };

	try {
		const require = createRequire(import.meta.url);
		const pkgJsonPath = require.resolve(`${PLAYGROUND_PKG}/package.json`);
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { bin?: string | Record<string, string> };
		const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["agents-playground"];
		if (binRel) {
			const binPath = resolve(dirname(pkgJsonPath), binRel);
			if (existsSync(binPath)) return { cmd: process.execPath, args: [binPath] };
		}
	} catch {
		// not installed locally — fall through
	}

	const monorepoBin = findLocalPlaygroundBin(process.cwd());
	if (monorepoBin) return { cmd: process.execPath, args: [monorepoBin] };

	return { cmd: "npx", args: ["-y", `${PLAYGROUND_PKG}@${version}`] };
}

function watchPlaygroundPort(stdout: NodeJS.ReadableStream, onPort: (port: number) => void): void {
	let buffer = "";
	stdout.on("data", (chunk: Buffer | string) => {
		process.stdout.write(chunk);
		buffer += chunk.toString();
		const match = buffer.match(PLAYGROUND_URL_RE);
		if (!match) return;
		onPort(Number(match[1]));
	});
}

async function waitForPlaygroundReady(
	child: ReturnType<typeof spawn>,
	fallbackPort: number,
	timeoutMs: number,
): Promise<number | null> {
	let port = fallbackPort;
	let settled = false;

	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;

		if (child.stdout) {
			watchPlaygroundPort(child.stdout, (nextPort) => {
				port = nextPort;
			});
		}

		const poll = async () => {
			if (settled) return;
			if (Date.now() > deadline) {
				settled = true;
				resolve(null);
				return;
			}
			try {
				const res = await fetch(`http://localhost:${port}/health`);
				if (res.ok) {
					settled = true;
					resolve(port);
					return;
				}
			} catch {
				// not ready yet
			}
			setTimeout(poll, 300);
		};

		void poll();
	});
}

function openBrowser(url: string): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	const args = process.platform === "win32" ? ["", url] : [url];
	try {
		spawn(cmd, args, { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
	} catch {
		log.warn(`Could not open a browser automatically — visit ${url}`);
	}
}

export async function playgroundCommand(options: PlaygroundOptions): Promise<void> {
	const port = options.port ? Number(options.port) : DEFAULT_PORT;
	if (!Number.isInteger(port) || port <= 0) {
		throw new Error(`Invalid --port '${options.port}'`);
	}
	if (options.provider && !SUPPORTED_PLAYGROUND_PROVIDERS.has(options.provider)) {
		const supported = [...SUPPORTED_PLAYGROUND_PROVIDERS].join(", ");
		throw new Error(`Playground supports providers: ${supported}; received '${options.provider}'.`);
	}

	const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
	if (options.provider) {
		// AGENTS_CLI_PROVIDER 在 playground bootstrap（config.json force）之后写回，保证 CLI 显式指定优先生效。
		env.AGENTS_PROVIDER = options.provider;
		env.AGENTS_CLI_PROVIDER = options.provider;
	}

	const { cmd, args } = resolveLauncher(cliVersion());
	if (cmd === "npx") log.info(`Fetching ${PLAYGROUND_PKG} (first run may take a moment)...`);

	const child = spawn(cmd, args, { env, stdio: ["inherit", "pipe", "inherit"] });

	const forward = (signal: NodeJS.Signals) => child.kill(signal);
	process.on("SIGINT", () => forward("SIGINT"));
	process.on("SIGTERM", () => forward("SIGTERM"));
	child.on("exit", (code) => process.exit(code ?? 0));
	child.on("error", (err) => {
		log.error(`Failed to start playground: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});

	const readyPort = await waitForPlaygroundReady(child, port, 30_000);
	if (readyPort === null) {
		log.warn(`Playground did not become ready in time — check the logs above, then open http://localhost:${port}`);
		return;
	}
	const url = `http://localhost:${readyPort}`;
	log.success(`Playground ready at ${url}`);
	if (options.open !== false) openBrowser(url);
}

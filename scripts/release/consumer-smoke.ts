/**
 * Verify published packages as a clean external npm consumer.
 *
 * Bun only orchestrates filesystem/process work. Package installation and all
 * runtime checks use the Node.js/npm selected by the workflow matrix.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REGISTRY_PACKAGES = ["sdk", "playground", "cli"] as const;
const REGISTRY = "https://registry.npmjs.org";
const root = resolve(import.meta.dirname, "../..");

export function packageName(pkg: (typeof REGISTRY_PACKAGES)[number]): string {
	return `@openagentpack/${pkg}`;
}

export function registryVersion(raw: string, name: string): string {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "string" && parsed.length > 0) return parsed;
	} catch {
		// Fall through to the stable error below.
	}
	throw new Error(`npm registry returned an invalid version for ${name}`);
}

export function commonRegistryVersion(entries: ReadonlyArray<{ name: string; version: string }>): string {
	if (entries.length === 0) throw new Error("no published packages were queried");
	const versions = [...new Set(entries.map((entry) => entry.version))];
	if (versions.length !== 1) {
		throw new Error(
			`published package versions must match; found: ${entries.map((entry) => `${entry.name}@${entry.version}`).join(", ")}`,
		);
	}
	return versions[0]!;
}

function run(command: string[], cwd: string, stdout: "inherit" | "pipe" = "inherit"): string {
	const result = Bun.spawnSync(command, { cwd, stdout, stderr: "inherit" });
	if (result.exitCode !== 0) throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}`);
	return stdout === "pipe" ? (result.stdout?.toString().trim() ?? "") : "";
}

function npmVersion(name: string, requested: string): string {
	const result = Bun.spawnSync(["npm", "view", `${name}@${requested}`, "version", "--json", "--registry", REGISTRY], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString().trim() || `${name}@${requested} is not visible in the npm registry`);
	}
	return registryVersion(result.stdout.toString().trim(), name);
}

export function resolvePublishedVersion(requested: string): string {
	const entries = REGISTRY_PACKAGES.map((pkg) => {
		const name = packageName(pkg);
		return { name, version: npmVersion(name, requested) };
	});
	const resolved = commonRegistryVersion(entries);
	if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requested) && resolved !== requested) {
		throw new Error(`npm registry resolved ${requested} as ${resolved}`);
	}
	return resolved;
}

export async function waitForRegistry(
	requested: string,
	options: { attempts?: number; delayMs?: number } = {},
): Promise<string> {
	const attempts = options.attempts ?? 30;
	const delayMs = options.delayMs ?? 10_000;
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const version = resolvePublishedVersion(requested);
			console.log(`✓ All published packages are visible at ${version}`);
			return version;
		} catch (error) {
			lastError = error;
			if (attempt === attempts) break;
			console.log(`Registry not ready (${attempt}/${attempts}); retrying in ${delayMs / 1000}s...`);
			await Bun.sleep(delayMs);
		}
	}
	throw lastError;
}

function writeConsumerManifest(directory: string, name: string): void {
	mkdirSync(directory);
	writeFileSync(
		join(directory, "package.json"),
		`${JSON.stringify({ name, private: true, type: "module" }, null, 2)}\n`,
	);
}

function installPackage(directory: string, name: string, version: string): void {
	run(
		["npm", "install", "--engine-strict", "--no-audit", "--no-fund", "--registry", REGISTRY, `${name}@${version}`],
		directory,
	);
}

function assertInstalledPackage(directory: string, name: string, version: string): void {
	const packageDirectory = join(directory, "node_modules", ...name.split("/"));
	const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as { version?: string };
	if (manifest.version !== version) {
		throw new Error(`${name} version mismatch: expected ${version}, received ${manifest.version ?? "missing"}`);
	}
	const installedLicense = readFileSync(join(packageDirectory, "LICENSE"), "utf8");
	if (installedLicense !== readFileSync(join(root, "LICENSE"), "utf8")) {
		throw new Error(`${name} is missing the repository license`);
	}
	if (name === "@openagentpack/sdk") readFileSync(join(packageDirectory, "NOTICE"), "utf8");
	run(["npm", "audit", "signatures"], directory);
}

function smokeSdk(directory: string): void {
	run(
		[
			"node",
			"--input-type=module",
			"--eval",
			[
				'import * as sdk from "@openagentpack/sdk";',
				'await import("@openagentpack/sdk/session-events");',
				'await import("@openagentpack/sdk/scan-lifecycle");',
				'await import("@openagentpack/sdk/file-lifecycle");',
				'if (typeof sdk.resolveProjectConfigFromObject !== "function") throw new Error("SDK export missing");',
			].join(" "),
		],
		directory,
	);
}

function smokeCli(directory: string, version: string): void {
	const entry = join(directory, "node_modules", "@openagentpack", "cli", "dist", "bin", "agents.js");
	const cliVersion = run(["node", entry, "--version"], directory, "pipe");
	if (cliVersion !== version) throw new Error(`CLI version mismatch: expected ${version}, received ${cliVersion}`);
	run(["node", entry, "--help"], directory);

	writeFileSync(
		join(directory, "agents.yaml"),
		[
			'version: "1"',
			"providers:",
			"  qoder:",
			"    api_key: smoke-test",
			"defaults:",
			"  provider: qoder",
			"environments:",
			"  smoke:",
			"    config:",
			"      type: cloud",
			"agents:",
			"  smoke:",
			"    model: ultimate",
			"    instructions: Cross-platform release smoke test.",
			"    environment: smoke",
			"",
		].join("\n"),
	);
	run(["node", entry, "--no-color", "validate", "--file", "agents.yaml"], directory);
}

async function availablePort(): Promise<number> {
	return await new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") return reject(new Error("Failed to allocate a smoke-test port"));
			server.close((error) => (error ? reject(error) : resolvePort(address.port)));
		});
	});
}

async function smokePlayground(directory: string): Promise<void> {
	const port = await availablePort();
	const entry = join(directory, "node_modules", "@openagentpack", "playground", "dist", "bin", "playground.js");
	const child = Bun.spawn(["node", entry], {
		cwd: directory,
		env: { ...process.env, PORT: String(port) },
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (child.exitCode !== null) {
				throw new Error(
					`Published Playground exited before becoming ready: ${await new Response(child.stderr).text()}`,
				);
			}
			try {
				const response = await fetch(`http://127.0.0.1:${port}/`);
				const html = await response.text();
				if (response.ok && html.includes('name="agents-runtime" content="playground"')) return;
			} catch {
				// The child has not bound its port yet.
			}
			await Bun.sleep(100);
		}
		throw new Error("Published Playground did not become ready within 10 seconds");
	} finally {
		child.kill();
		await child.exited;
	}
}

export async function smokePublishedPackages(requested: string): Promise<void> {
	const version = resolvePublishedVersion(requested);
	const temporaryRoot = mkdtempSync(join(tmpdir(), "openagentpack-registry-consumer-"));
	try {
		const sdkDirectory = join(temporaryRoot, "sdk-consumer");
		writeConsumerManifest(sdkDirectory, "openagentpack-sdk-consumer");
		installPackage(sdkDirectory, "@openagentpack/sdk", version);
		assertInstalledPackage(sdkDirectory, "@openagentpack/sdk", version);
		smokeSdk(sdkDirectory);

		const cliDirectory = join(temporaryRoot, "cli-consumer");
		writeConsumerManifest(cliDirectory, "openagentpack-cli-consumer");
		installPackage(cliDirectory, "@openagentpack/cli", version);
		assertInstalledPackage(cliDirectory, "@openagentpack/cli", version);
		smokeCli(cliDirectory, version);

		const playgroundDirectory = join(temporaryRoot, "playground-consumer");
		writeConsumerManifest(playgroundDirectory, "openagentpack-playground-consumer");
		installPackage(playgroundDirectory, "@openagentpack/playground", version);
		assertInstalledPackage(playgroundDirectory, "@openagentpack/playground", version);
		await smokePlayground(playgroundDirectory);

		const nodeVersion = run(["node", "--version"], temporaryRoot, "pipe");
		console.log(`✓ Published ${version} packages install and run under ${process.platform} / ${nodeVersion}`);
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

function option(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
	const command = process.argv[2];
	const version = option("version");
	if (!version || (command !== "wait" && command !== "smoke")) {
		throw new Error("usage: consumer-smoke.ts <wait|smoke> --version <exact-version|dist-tag>");
	}
	if (command === "wait") await waitForRegistry(version);
	else await smokePublishedPackages(version);
}

if (import.meta.main) await main();

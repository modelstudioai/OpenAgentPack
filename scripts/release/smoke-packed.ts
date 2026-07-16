/**
 * Pack the exact publish manifests, install them as an external npm consumer,
 * then exercise every public SDK entry point plus the CLI and Playground bins.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	PACKAGES,
	restoreLicense,
	restorePackageJson,
	rewriteManifestForPublish,
	stageLicense,
	workspaceVersions,
} from "./publish.ts";

const root = resolve(import.meta.dirname, "../..");

type PackedPackage = { filename: string };

export function packedFilename(raw: string, pkg: string): string {
	const parsed = JSON.parse(raw) as PackedPackage[] | Record<string, PackedPackage>;
	const packed = Array.isArray(parsed) ? parsed : Object.values(parsed);
	if (packed.length !== 1 || !packed[0]?.filename) throw new Error(`Unexpected npm pack output for ${pkg}`);
	return packed[0].filename;
}

function run(command: string[], cwd: string, stdout: "inherit" | "pipe" = "inherit"): string {
	const result = Bun.spawnSync(command, { cwd, stdout, stderr: "inherit" });
	if (result.exitCode !== 0) throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}`);
	return stdout === "pipe" ? (result.stdout?.toString().trim() ?? "") : "";
}

function packPackages(destination: string): string[] {
	const versions = workspaceVersions();
	return PACKAGES.map((pkg) => {
		const pkgDir = join(root, "packages", pkg);
		let originalLicense: string | undefined;
		let originalManifest: string | undefined;
		let licenseStaged = false;
		try {
			originalLicense = stageLicense(pkgDir);
			licenseStaged = true;
			originalManifest = rewriteManifestForPublish(pkgDir, versions);
			const raw = run(["npm", "pack", "--json", "--pack-destination", destination], pkgDir, "pipe");
			return join(destination, packedFilename(raw, pkg));
		} finally {
			if (originalManifest !== undefined) restorePackageJson(pkgDir, originalManifest);
			if (licenseStaged) restoreLicense(pkgDir, originalLicense);
		}
	});
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

async function smokePlayground(consumer: string): Promise<void> {
	const port = await availablePort();
	const entry = join(consumer, "node_modules/@openagentpack/playground/dist/bin/playground.js");
	const child = Bun.spawn(["node", entry], {
		cwd: consumer,
		env: { ...process.env, PORT: String(port) },
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		for (let attempt = 0; attempt < 50; attempt++) {
			if (child.exitCode !== null) {
				throw new Error(`Packed Playground exited before becoming ready: ${await new Response(child.stderr).text()}`);
			}
			try {
				const response = await fetch(`http://127.0.0.1:${port}/`);
				const html = await response.text();
				if (response.ok && html.includes('name="agents-runtime" content="playground"')) {
					const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
					if (assets.length === 0) throw new Error("Packed Playground HTML references no built assets");
					for (const asset of assets) {
						const assetResponse = await fetch(`http://127.0.0.1:${port}${asset}`);
						if (!assetResponse.ok) throw new Error(`Packed Playground asset is unavailable: ${asset}`);
					}
					return;
				}
			} catch {
				// The child has not bound its port yet.
			}
			await Bun.sleep(100);
		}
		throw new Error("Packed Playground did not become ready within 5 seconds");
	} finally {
		child.kill();
		await child.exited;
	}
}

async function main(): Promise<void> {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "openagentpack-consumer-"));
	try {
		const tarballsDir = join(temporaryRoot, "tarballs");
		const consumer = join(temporaryRoot, "consumer");
		mkdirSync(tarballsDir);
		mkdirSync(consumer);
		writeFileSync(join(consumer, "package.json"), '{"name":"agents-package-smoke","private":true,"type":"module"}\n');

		const tarballs = packPackages(tarballsDir);
		run(
			[
				"npm",
				"install",
				"--engine-strict",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--no-package-lock",
				...tarballs,
			],
			consumer,
		);
		for (const pkg of PACKAGES) {
			const license = readFileSync(join(consumer, `node_modules/@openagentpack/${pkg}/LICENSE`), "utf8");
			if (license !== readFileSync(join(root, "LICENSE"), "utf8")) {
				throw new Error(`${pkg} package is missing the repository license`);
			}
		}

		run(
			[
				"node",
				"--input-type=module",
				"--eval",
				'await import("@openagentpack/sdk"); await import("@openagentpack/sdk/session-events"); await import("@openagentpack/sdk/scan-lifecycle"); await import("@openagentpack/sdk/file-lifecycle");',
			],
			consumer,
		);

		const expectedVersion = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")) as {
			version: string;
		};
		const cliVersion = run(
			["node", join(consumer, "node_modules/@openagentpack/cli/dist/bin/agents.js"), "--version"],
			consumer,
			"pipe",
		);
		if (cliVersion !== expectedVersion.version) {
			throw new Error(`Packed CLI version mismatch: expected ${expectedVersion.version}, received ${cliVersion}`);
		}

		await smokePlayground(consumer);
		const nodeVersion = run(["node", "--version"], consumer, "pipe");
		console.log(`✓ Packed packages install and run under ${nodeVersion}`);
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

if (import.meta.main) await main();

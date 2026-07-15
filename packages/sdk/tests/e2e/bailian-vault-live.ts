/**
 * Bailian Vaults + Credentials live coverage — drives the REAL AgentStudio API
 * THROUGH the project's BailianAdapter methods (not raw fetch), then prints a
 * PASS/FAIL summary.
 *
 *   bun run packages/sdk/tests/e2e/bailian-vault-live.ts
 *
 * Env (auto-loaded from repo-root .env by Bun):
 *   DASHSCOPE_API_KEY, BAILIAN_WORKSPACE_ID, [BAILIAN_BASE_URL]
 *
 * Note on the one raw call below: the project's credential mapping only emits
 * `static_bearer`, which the cloud currently rejects (CREDENTIAL_AUTH_TYPE_ERROR).
 * To still exercise the credential read/update/archive/delete adapter methods
 * against a real credential, we SEED one via an `environment_variable` raw POST
 * (clearly labelled). Everything else goes through BailianAdapter.
 */
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import type { CredentialDecl, VaultDecl } from "../../src/internal/types/config.ts";

const API_KEY = process.env.DASHSCOPE_API_KEY;
const WORKSPACE_ID = process.env.BAILIAN_WORKSPACE_ID;
// Optional override; when unset the adapter derives production from workspace_id.
const BASE_URL = process.env.BAILIAN_BASE_URL?.trim() || undefined;

if (!API_KEY || !WORKSPACE_ID) {
	console.error("Missing DASHSCOPE_API_KEY or BAILIAN_WORKSPACE_ID");
	process.exit(1);
}

const adapter = new BailianAdapter(API_KEY, WORKSPACE_ID, BASE_URL, "vault-live-test");

const results: Array<{ name: string; via: string; ok: boolean; note: string }> = [];

async function run(name: string, via: string, fn: () => Promise<string>) {
	try {
		const note = await fn();
		results.push({ name, via, ok: true, note });
		console.log(`  PASS  ${name}  [${via}]${note ? ` — ${note}` : ""}`);
	} catch (e) {
		const msg = String(e)
			.replace(/^Error:\s*/, "")
			.split("\n")[0];
		results.push({ name, via, ok: false, note: msg });
		console.log(`  FAIL  ${name}  [${via}] — ${msg}`);
	}
}

// Raw helper used ONLY to seed an environment_variable credential (see header).
async function seedEnvVarCredential(vaultId: string, secretName: string, displayName: string): Promise<string> {
	const res = await fetch(`${BASE_URL}/vaults/${vaultId}/credentials`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
		body: JSON.stringify({
			auth: {
				type: "environment_variable",
				secret_name: secretName,
				secret_value: "tok",
				networking: { type: "unrestricted" },
			},
			display_name: displayName,
		}),
	});
	if (!res.ok) throw new Error(`seed failed ${res.status}: ${await res.text()}`);
	return (await res.json()).id as string;
}

async function main() {
	const tag = Date.now();
	let vaultId = "";
	let credGet = "";
	let credDelete = "";

	console.log("=== Vaults (via BailianAdapter) ===");
	await run("vault.create", "adapter.createVault", async () => {
		const v = await adapter.createVault(`agents-vault-live-${tag}`, {
			display_name: `agents-vault-live-${tag}`,
			metadata: { src: "live" },
			credentials: [],
		} as VaultDecl);
		vaultId = v.id ?? "";
		if (!vaultId) throw new Error("no vault id");
		return `id=${vaultId}`;
	});
	await run("vault.list", "adapter.listVaults", async () => {
		const list = await adapter.listVaults();
		return `count=${list.length}`;
	});
	await run("vault.get", "adapter.getVault", async () => {
		const v = await adapter.getVault(vaultId);
		return `display_name=${v.display_name}`;
	});
	await run("vault.update", "adapter.updateVault", async () => {
		const v = await adapter.updateVault(vaultId, { display_name: `agents-vault-live-${tag}-upd` });
		return `id=${v.id}`;
	});

	console.log("\n=== Credentials (via BailianAdapter) ===");
	await run("credential.create (static_bearer)", "adapter.createCredential", async () => {
		const c = await adapter.createCredential(vaultId, {
			name: "cred-bearer",
			type: "static_bearer",
			mcp_server_url: "https://example.com/mcp",
			access_token: "tok-x",
		} as CredentialDecl);
		return `id=${c.id}`;
	});

	// SEED two env_var credentials so the read/update/archive/delete adapter
	// methods can run against real credentials (project create only emits
	// static_bearer, rejected above).
	try {
		credGet = await seedEnvVarCredential(vaultId, `MCP_GET_${tag}`, "cred-get");
		credDelete = await seedEnvVarCredential(vaultId, `MCP_DEL_${tag}`, "cred-del");
		console.log(`  (seed) created env_var credentials ${credGet}, ${credDelete}`);
	} catch (e) {
		console.log(`  (seed) FAILED: ${String(e).split("\n")[0]}`);
	}

	await run("credential.list", "adapter.listCredentials", async () => {
		const list = await adapter.listCredentials(vaultId);
		return `count=${list.length}`;
	});
	await run("credential.get", "adapter.getCredential", async () => {
		const c = await adapter.getCredential(vaultId, credGet);
		return `id=${c.id}`;
	});
	await run("credential.update", "adapter.updateCredential", async () => {
		const c = await adapter.updateCredential(vaultId, credGet, { display_name: "cred-get-upd" });
		return `id=${c.id}`;
	});
	await run("credential.archive", "adapter.archiveCredential", async () => {
		const c = await adapter.archiveCredential(vaultId, credGet);
		return `id=${c.id}`;
	});
	await run("credential.delete", "adapter.deleteCredential", async () => {
		await adapter.deleteCredential(vaultId, credDelete);
		return "deleted";
	});

	console.log("\n=== Vault teardown (via BailianAdapter) ===");
	await run("vault.archive", "adapter.archiveVault", async () => {
		const v = await adapter.archiveVault(vaultId);
		return `id=${v.id}`;
	});
	await run("vault.delete", "adapter.deleteVault", async () => {
		await adapter.deleteVault(vaultId);
		return "deleted";
	});

	console.log("\n==================== SUMMARY (all via BailianAdapter) ====================");
	for (const r of results) {
		console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.via.padEnd(26)} ${r.name}`);
		if (!r.ok) console.log(`        > ${r.note}`);
	}
	const pass = results.filter((r) => r.ok).length;
	console.log(`\n${pass}/${results.length} adapter methods passed`);
}

main().catch((err) => {
	console.error("FATAL", String(err));
	process.exit(1);
});

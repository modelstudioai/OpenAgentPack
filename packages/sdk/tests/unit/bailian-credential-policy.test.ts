import { describe, expect, test } from "bun:test";
import { validateProjectConfig } from "../../src/internal/core/validate-config.ts";
import { projectConfigSchema } from "../../src/internal/parser/schema.ts";
import { credToDecl, mapCredential } from "../../src/internal/providers/bailian/mapper.ts";
import type { CredentialDecl } from "../../src/internal/types/config.ts";

const credential: CredentialDecl = {
	name: "api-token",
	type: "environment_variable",
	secret_name: "API_TOKEN",
	secret_value: "test-secret",
	networking: { allowed_hosts: ["api.example.com", "*.example.org"] },
	injection_location: { header: true, body: false },
};

function parseCredential(input: CredentialDecl) {
	return projectConfigSchema.parse({
		version: "1",
		providers: { bailian: {} },
		vaults: { secrets: { display_name: "Secrets", credentials: [input] } },
	}).vaults!.secrets!.credentials[0]!;
}

describe("Bailian credential injection policy", () => {
	test("preserves both new fields through config parsing and the request mapper", () => {
		const parsed = parseCredential(credential);
		expect(parsed).toEqual(credential);
		expect(mapCredential(parsed)).toEqual({
			display_name: "api-token",
			auth: {
				type: "environment_variable",
				secret_name: "API_TOKEN",
				secret_value: "test-secret",
				networking: { allowed_hosts: ["api.example.com", "*.example.org"] },
				injection_location: { header: true, body: false },
			},
		});
	});

	test("preserves response policies through sync, parsing, and a new request", () => {
		const synced = credToDecl(
			{
				display_name: "api-token",
				auth: {
					type: "environment_variable",
					secret_name: "API_TOKEN",
					networking: { type: "limited", allowed_hosts: ["api.example.com", "*.example.org"] },
					injection_location: { header: false, body: true },
				},
			},
			"secrets",
		);
		expect(synced.secret_value).not.toBe(credential.secret_value);
		const request = mapCredential(parseCredential(synced)) as { auth: Record<string, unknown> };
		expect(request.auth.networking).toEqual(credential.networking);
		expect(request.auth.injection_location).toEqual({ header: false, body: true });
	});

	test.each([
		undefined,
		{ type: "unrestricted" as const },
	])("maps legacy unrestricted networking to the wildcard: %j", (networking) => {
		const request = mapCredential({ ...credential, networking, injection_location: undefined });
		expect(request).toMatchObject({
			auth: { networking: { allowed_hosts: ["*"] }, injection_location: { header: true, body: false } },
		});
	});

	test("does not widen an explicit empty host list", () => {
		const request = mapCredential({ ...credential, networking: { allowed_hosts: [] } });
		expect(request).toMatchObject({ auth: { networking: { allowed_hosts: [] } } });
	});

	test("rejects legacy limited networking without hosts instead of widening it", () => {
		expect(() => mapCredential({ ...credential, networking: { type: "limited" } })).toThrow(/networking.allowed_hosts/);
	});

	test("validates policy value types", () => {
		expect(() =>
			parseCredential({ ...credential, networking: { allowed_hosts: [123] } } as unknown as CredentialDecl),
		).toThrow();
		expect(() =>
			parseCredential({ ...credential, injection_location: { header: "true" } } as unknown as CredentialDecl),
		).toThrow();
	});

	test.each(["claude", "qoder", "ark"])("does not silently discard injection_location for %s", (provider) => {
		const diagnostics = validateProjectConfig({
			version: "1",
			providers: { [provider]: {} },
			vaults: { secrets: { display_name: "Secrets", credentials: [credential] } },
		});
		expect(
			diagnostics.some((diagnostic) => diagnostic.code === `${provider}.vault.injection_location.unsupported`),
		).toBe(true);
	});

	test("allows a Bailian-pinned vault in a multi-provider project", () => {
		const diagnostics = validateProjectConfig({
			version: "1",
			providers: { bailian: {}, qoder: {} },
			vaults: { secrets: { provider: "bailian", display_name: "Secrets", credentials: [credential] } },
		});
		expect(diagnostics).toEqual([]);
	});

	test.each(["claude", "qoder", "ark"])("keeps legacy networking validation for %s", (provider) => {
		for (const networking of [undefined, { type: "unrestricted" as const }, { type: "limited" as const }]) {
			const legacy = { ...credential, networking, injection_location: undefined };
			const config = {
				version: "1",
				providers: { [provider]: {} },
				vaults: { secrets: { display_name: "Secrets", credentials: [legacy] } },
			};
			expect(projectConfigSchema.parse(config).vaults?.secrets?.credentials[0]).toEqual(legacy);
			expect(validateProjectConfig(config)).toEqual([]);
		}
		const missingType = {
			version: "1",
			providers: { [provider]: {} },
			vaults: {
				secrets: {
					display_name: "Secrets",
					credentials: [{ ...credential, networking: {}, injection_location: undefined }],
				},
			},
		};
		expect(projectConfigSchema.safeParse(missingType).success).toBe(false);
		expect(validateProjectConfig(missingType).map((diagnostic) => diagnostic.code)).toContain(
			`${provider}.vault.networking.type.required`,
		);
	});

	test.each(["claude", "qoder", "ark"])("blocks Bailian policy fields for %s before execution", (provider) => {
		const config = {
			version: "1",
			providers: { [provider]: {} },
			vaults: { secrets: { display_name: "Secrets", credentials: [credential] } },
		};
		const parsed = projectConfigSchema.safeParse(config);
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.issues.map((issue) => issue.path.join("."))).toContain(
				"vaults.secrets.credentials.0.networking.allowed_hosts",
			);
			expect(JSON.stringify(parsed.error.issues)).not.toContain(credential.secret_value!);
		}
		expect(validateProjectConfig(config).map((diagnostic) => diagnostic.code)).toContain(
			`${provider}.vault.networking.allowed_hosts.unsupported`,
		);
	});

	test("resolves policy ownership from the vault, defaults, and provider selection", () => {
		const config = {
			version: "1",
			providers: { bailian: {}, qoder: {} },
			vaults: { secrets: { display_name: "Secrets", credentials: [credential] } },
		};
		expect(projectConfigSchema.safeParse(config).success).toBe(false);
		const bailianDefault = { ...config, defaults: { provider: "bailian" } };
		expect(projectConfigSchema.safeParse(bailianDefault).success).toBe(true);
		expect(
			validateProjectConfig(bailianDefault, { providers: ["qoder"] }).map((diagnostic) => diagnostic.code),
		).toContain("qoder.vault.networking.allowed_hosts.unsupported");
		expect(
			projectConfigSchema.safeParse({
				...config,
				defaults: { provider: "qoder" },
				vaults: { secrets: { ...config.vaults.secrets, provider: "bailian" } },
			}).success,
		).toBe(true);
	});
});

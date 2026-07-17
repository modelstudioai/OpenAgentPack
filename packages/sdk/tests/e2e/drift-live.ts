import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";

const repo = new URL("../../../..", import.meta.url).pathname;
const stamp = new Date()
	.toISOString()
	.replace(/[-:.TZ]/g, "")
	.slice(0, 14);

async function runAgents(args: string[]) {
	const proc = spawn({
		cmd: ["bun", "run", "packages/cli/bin/agents.ts", ...args],
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
		env: Bun.env,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function api(base: string, path: string, headers: Record<string, string>, init: RequestInit = {}) {
	const res = await fetch(`${base}${path}`, {
		...init,
		headers: { ...headers, ...(init.headers ?? {}) },
	});
	const text = await res.text();
	let body: unknown = text;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {}
	if (!res.ok) {
		throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
	}
	return body as Record<string, unknown>;
}

async function validateQoder(): Promise<boolean | "skipped"> {
	if (!Bun.env.QODER_PAT) return "skipped";

	const suffix = Math.random().toString(36).slice(2, 8);
	const name = `agents-live-drift-qoder-${stamp}-${suffix}`;
	const dir = `/tmp/${name}`;
	const configPath = join(dir, "agents.yaml");
	const statePath = join(dir, "agents.state.json");
	const base = "https://api.qoder.com/api/v1/cloud";
	const headers = { Authorization: `Bearer ${Bun.env.QODER_PAT}`, "Content-Type": "application/json" };
	let agentId: string | undefined;
	let envId: string | undefined;

	async function cleanup() {
		if (agentId) {
			await api(base, `/agents/${agentId}`, headers, { method: "DELETE" })
				.then(() => console.log("qoder cleanup agent=deleted"))
				.catch((e) => console.log(`qoder cleanup agent=failed ${e.message}`));
		}
		if (envId) {
			await api(base, `/environments/${envId}`, headers, { method: "DELETE" })
				.then(() => console.log("qoder cleanup environment=deleted"))
				.catch((e) => console.log(`qoder cleanup environment=failed ${e.message}`));
		}
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}

	try {
		await mkdir(dir, { recursive: true });
		await Bun.write(
			configPath,
			`version: "1"

providers:
  qoder:
    api_key: \${QODER_PAT}
    gateway: "${base}"

defaults:
  provider: qoder

environments:
  ${name}-env:
    description: "Agents live drift original environment"
    config:
      type: cloud
      networking:
        type: unrestricted
    metadata:
      cma_test: drift-validation

agents:
  ${name}-agent:
    description: "Agents live drift original agent"
    model: ultimate
    instructions: |
      You are a temporary Agents live drift validation agent. Reply with original.
    environment: ${name}-env
    tools:
      builtin: [read]
    metadata:
      cma_test: drift-validation
`,
		);
		console.log(`qoder live name=${name}`);

		const first = await runAgents(["apply", "-f", configPath, "-y"]);
		if (first.exitCode !== 0) throw new Error(first.stderr || first.stdout);
		const state = JSON.parse(await readFile(statePath, "utf8"));
		agentId = state.resources.find((r: any) => r.address.type === "agent")?.remote_id;
		envId = state.resources.find((r: any) => r.address.type === "environment")?.remote_id;
		if (!agentId || !envId) throw new Error("missing qoder ids");

		const before = await api(base, `/agents/${agentId}`, headers);
		await api(base, `/agents/${agentId}`, headers, {
			method: "PUT",
			body: JSON.stringify({ description: `Agents LIVE DRIFT qoder ${stamp}`, version: before.version }),
		});

		const plan = await runAgents(["plan", "-f", configPath, "--json"]);
		if (plan.exitCode !== 0) throw new Error(plan.stderr || plan.stdout);
		const planJson = JSON.parse(plan.stdout);
		const agentAction = planJson.actions.find((a: any) => a.address.type === "agent");

		const second = await runAgents(["apply", "-f", configPath, "-y"]);
		if (second.exitCode !== 0) throw new Error(second.stderr || second.stdout);
		const after = await api(base, `/agents/${agentId}`, headers);
		const ok =
			agentAction?.action === "update" &&
			agentAction?.readinessImpact === "non_blocking" &&
			Array.isArray(agentAction?.changedPaths) &&
			agentAction.changedPaths.length === 1 &&
			agentAction.changedPaths[0] === "description" &&
			after.description === "Agents live drift original agent";
		console.log(`qoder live drift validation=${ok ? "passed" : "failed"}`);
		return ok;
	} finally {
		await cleanup();
	}
}

async function validateBailian(): Promise<boolean | "skipped"> {
	if (!Bun.env.DASHSCOPE_API_KEY || !Bun.env.BAILIAN_WORKSPACE_ID) return "skipped";

	const suffix = Math.random().toString(36).slice(2, 8);
	const name = `agents-live-drift-bailian-${stamp}-${suffix}`;
	const dir = `/tmp/${name}`;
	const configPath = join(dir, "agents.yaml");
	const statePath = join(dir, "agents.state.json");
	const base =
		Bun.env.BAILIAN_BASE_URL ??
		`https://${Bun.env.BAILIAN_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api/v1/agentstudio`;
	const headers = { Authorization: `Bearer ${Bun.env.DASHSCOPE_API_KEY}`, "Content-Type": "application/json" };
	let agentId: string | undefined;
	let envId: string | undefined;

	async function cleanup() {
		if (agentId) {
			await api(base, `/agents/${agentId}/archive`, headers, { method: "POST", body: "{}" })
				.then(() => console.log("bailian cleanup agent=archived"))
				.catch((e) => console.log(`bailian cleanup agent=failed ${e.message}`));
		}
		if (envId) {
			await api(base, `/environments/${envId}`, headers, { method: "DELETE" })
				.then(() => console.log("bailian cleanup environment=deleted"))
				.catch((e) => console.log(`bailian cleanup environment=failed ${e.message}`));
		}
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}

	try {
		await mkdir(dir, { recursive: true });
		await Bun.write(
			configPath,
			`version: "1"

providers:
  bailian:
    api_key: \${DASHSCOPE_API_KEY}
    workspace_id: \${BAILIAN_WORKSPACE_ID}
    base_url: "${base}"

defaults:
  provider: bailian

environments:
  ${name}-env:
    description: "Agents live drift original environment"
    config:
      type: cloud
      networking:
        type: unrestricted
    metadata:
      cma_test: drift-validation

agents:
  ${name}-agent:
    description: "Agents live drift original agent"
    model: qwen3.7-max
    instructions: |
      You are a temporary Agents live drift validation agent. Reply with original.
    environment: ${name}-env
    tools:
      builtin: [bash, read]
    metadata:
      cma_test: drift-validation
`,
		);
		console.log(`bailian live name=${name}`);

		const first = await runAgents(["apply", "-f", configPath, "-y"]);
		if (first.exitCode !== 0) throw new Error(first.stderr || first.stdout);
		const state = JSON.parse(await readFile(statePath, "utf8"));
		agentId = state.resources.find((r: any) => r.address.type === "agent")?.remote_id;
		envId = state.resources.find((r: any) => r.address.type === "environment")?.remote_id;
		if (!agentId || !envId) throw new Error("missing bailian ids");

		const before = await api(base, `/agents/${agentId}`, headers);
		const body: Record<string, unknown> = {
			name: before.name,
			model: before.model,
			system: before.system,
			tools: before.tools,
			mcp_servers: before.mcp_servers,
			skills: before.skills,
			metadata: before.metadata,
			description: `Agents LIVE DRIFT bailian ${stamp}`,
			version: before.version,
		};
		for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
		await api(base, `/agents/${agentId}`, headers, { method: "POST", body: JSON.stringify(body) });

		const plan = await runAgents(["plan", "-f", configPath, "--json"]);
		if (plan.exitCode !== 0) throw new Error(plan.stderr || plan.stdout);
		const planJson = JSON.parse(plan.stdout);
		const agentAction = planJson.actions.find((a: any) => a.address.type === "agent");

		const second = await runAgents(["apply", "-f", configPath, "-y"]);
		if (second.exitCode !== 0) throw new Error(second.stderr || second.stdout);
		const after = await api(base, `/agents/${agentId}`, headers);
		const ok =
			agentAction?.action === "update" &&
			agentAction?.readinessImpact === "non_blocking" &&
			Array.isArray(agentAction?.changedPaths) &&
			agentAction.changedPaths.length === 1 &&
			agentAction.changedPaths[0] === "description" &&
			after.description === "Agents live drift original agent";
		console.log(`bailian live drift validation=${ok ? "passed" : "failed"}`);
		return ok;
	} finally {
		await cleanup();
	}
}

const target = process.argv[2] ?? "all";
const results: Record<string, boolean | "skipped"> = {};
if (target === "all" || target === "qoder") results.qoder = await validateQoder();
if (target === "all" || target === "bailian") results.bailian = await validateBailian();
console.log(`live drift validation results=${JSON.stringify(results)}`);
if (Object.values(results).some((v) => v === false)) process.exit(1);

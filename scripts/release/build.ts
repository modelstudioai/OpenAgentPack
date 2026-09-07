/**
 * 按依赖拓扑顺序构建所有可发布的包
 * 用法: bun run scripts/release/build.ts
 */

const PACKAGES = ["sdk", "playground", "cli"] as const; // 拓扑顺序

console.log("Building all publishable packages...\n");

for (const pkg of PACKAGES) {
	console.log(`\n--- Building @openagentpack/${pkg} ---`);
	const proc = Bun.spawnSync(["bun", "run", "build"], {
		cwd: `packages/${pkg}`,
		stdio: ["inherit", "inherit", "inherit"],
	});
	if (proc.exitCode !== 0) {
		console.error(`\nBuild failed for @openagentpack/${pkg}`);
		process.exit(proc.exitCode!);
	}
}

console.log("\n✓ All packages built successfully.");

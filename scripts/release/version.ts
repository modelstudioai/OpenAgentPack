/**
 * 运行 changeset version 并修复 bun.lock
 * 用法: bun run scripts/release/version.ts
 */

const version = Bun.spawnSync(["bunx", "changeset", "version"], {
	stdio: ["inherit", "inherit", "inherit"],
});
if (version.exitCode !== 0) process.exit(version.exitCode!);

// Refresh workspace references without opportunistically upgrading dependencies.
console.log("\n--- Updating lockfile ---");
const update = Bun.spawnSync(["bun", "install", "--lockfile-only", "--registry=https://registry.npmjs.org"], {
	stdio: ["inherit", "inherit", "inherit"],
});
if (update.exitCode !== 0) process.exit(update.exitCode!);

console.log("\n✓ Versions bumped and lockfile updated.");

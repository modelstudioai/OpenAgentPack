import { expect, test } from "bun:test";

const desktopCss = await Bun.file(new URL("../src/app/desktop.css", import.meta.url)).text();

test("settings secret toggle stays anchored inside the password input", () => {
	expect(desktopCss).toContain(".settings-secret-input {");
	expect(desktopCss).toMatch(/\.settings-secret-input\s*\{[^}]*position:\s*relative;/s);
	expect(desktopCss).toMatch(
		/\.settings-secret-toggle\s*\{[^}]*position:\s*absolute;[^}]*right:\s*8px;[^}]*top:\s*50%;/s,
	);
	expect(desktopCss).toMatch(/\.settings-secret-input \.provision-dialog-input\s*\{[^}]*padding-right:\s*40px;/s);
});

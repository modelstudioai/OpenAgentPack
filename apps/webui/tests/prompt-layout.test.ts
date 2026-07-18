import { expect, test } from "bun:test";

const desktopCss = await Bun.file(new URL("../src/app/desktop.css", import.meta.url)).text();

function ruleFor(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = desktopCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
	expect(match, `missing CSS rule for ${selector}`).not.toBeNull();
	return match?.[1] ?? "";
}

test("long composer ghost text stays on one line", () => {
	const hintRow = ruleFor(".prompt-hint-row");
	const ghost = ruleFor(".prompt-ghost");

	expect(hintRow).toMatch(/\bwidth:\s*calc\(100%\s*-\s*40px\)/);
	expect(ghost).toMatch(/\bwhite-space:\s*nowrap/);
	expect(ghost).toMatch(/\boverflow:\s*hidden/);
	expect(ghost).toMatch(/\btext-overflow:\s*ellipsis/);
});

test("long bottom-bar ghost text stays on one line", () => {
	const hintRow = ruleFor(".bottom-bar-expanded .bar-hint-row");
	const ghost = ruleFor(".bottom-bar-expanded .bar-hint-row .prompt-ghost");

	expect(hintRow).toMatch(/\bwidth:\s*100%/);
	expect(ghost).toMatch(/\bwhite-space:\s*nowrap/);
	expect(ghost).toMatch(/\boverflow:\s*hidden/);
	expect(ghost).toMatch(/\btext-overflow:\s*ellipsis/);
});

test("prefilled prompt stays on one line even when the editor is focused", () => {
	const collapsed = ruleFor(".prompt-editor-slot .ProseMirror:not(.ProseMirror-focused)");
	const focused = ruleFor(".prompt-editor-slot .ProseMirror-focused");

	expect(collapsed).toMatch(/\bmin-height:\s*24px/);
	expect(collapsed).toMatch(/\bmax-height:\s*24px/);
	expect(collapsed).toMatch(/\boverflow:\s*hidden/);
	expect(focused).toMatch(/\bmin-height:\s*24px/);
	expect(focused).toMatch(/\bmax-height:\s*24px/);
	expect(focused).toMatch(/\boverflow:\s*hidden/);
});

import { expect, test } from "bun:test";

const appSource = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
const composerSource = await Bun.file(new URL("../src/components/Composer.tsx", import.meta.url)).text();

test("role prompt selection focuses the beginning of the prefilled prompt", () => {
	expect(appSource).toContain("composerHandleRef.current?.focusStart()");
	expect(composerSource).toContain('editor?.commands.focus("start", { scrollIntoView: false })');
});

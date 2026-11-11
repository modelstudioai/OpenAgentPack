import { expect, test } from "bun:test";
import { InMemoryStateManager, type StateFile } from "../../src/index.ts";

const initial: StateFile = {
	resources: [
		{ address: { type: "agent", name: "assistant", provider: "bailian" }, remote_id: "agent_1", content_hash: "hash" },
	],
};

test("public memory state detaches imported/exported snapshots and checkpoints at save time", async () => {
	const checkpoints: StateFile[] = [];
	const state = InMemoryStateManager.fromJSON(initial, async (snapshot) => {
		checkpoints.push(snapshot);
	});
	state.getResource(initial.resources[0]!.address)!.version = 2;
	const first = state.save();
	state.getResource(initial.resources[0]!.address)!.version = 3;
	await Promise.all([first, state.save()]);
	expect(checkpoints.map((snapshot) => snapshot.resources[0]!.version)).toEqual([2, 3]);
	expect(initial.resources[0]!.version).toBeUndefined();
	const exported = state.toJSON();
	exported.resources.length = 0;
	expect(state.listResources()).toHaveLength(1);
	expect(
		InMemoryStateManager.fromJSON(checkpoints[1]!).findResource({ type: "agent", name: "assistant" })?.version,
	).toBe(3);
});

test("checkpoint failures propagate and later saves remain usable; default save stays in memory", async () => {
	let fail = true;
	const state = InMemoryStateManager.empty(() => {
		if (fail) throw new Error("storage unavailable");
	});
	await expect(state.save()).rejects.toThrow("storage unavailable");
	fail = false;
	await state.save();
	await InMemoryStateManager.empty().save();
});

import type { PlannedAction } from "@openagentpack/sdk";

export interface PlanImpact {
	currentEdit: PlannedAction[];
	alreadyPending: PlannedAction[];
	resolvedByEdit: PlannedAction[];
}

export function comparePlanActions(beforeActions: PlannedAction[], afterActions: PlannedAction[]): PlanImpact {
	const actionableBefore = beforeActions.filter(isActionable);
	const actionableAfter = afterActions.filter(isActionable);
	const beforeByAddress = new Map(actionableBefore.map((action) => [actionAddressKey(action), action]));
	const afterByAddress = new Map(actionableAfter.map((action) => [actionAddressKey(action), action]));
	const currentEdit: PlannedAction[] = [];
	const alreadyPending: PlannedAction[] = [];

	for (const action of actionableAfter) {
		const previous = beforeByAddress.get(actionAddressKey(action));
		if (!previous || actionSignature(previous) !== actionSignature(action)) currentEdit.push(action);
		else alreadyPending.push(action);
	}

	return {
		currentEdit,
		alreadyPending,
		resolvedByEdit: actionableBefore.filter((action) => !afterByAddress.has(actionAddressKey(action))),
	};
}

function isActionable(action: PlannedAction): boolean {
	return action.action !== "no-op";
}

function actionAddressKey(action: PlannedAction): string {
	return `${action.address.provider}:${action.address.type}:${action.address.name}`;
}

function actionSignature(action: PlannedAction): string {
	return stableStringify({
		action: action.action,
		address: action.address,
		previousAddress: action.previousAddress,
		driftKind: action.driftKind,
		readinessImpact: action.readinessImpact,
		changedPaths: action.changedPaths,
		before: action.before,
		after: action.after,
		dependencies: action.dependencies,
	});
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

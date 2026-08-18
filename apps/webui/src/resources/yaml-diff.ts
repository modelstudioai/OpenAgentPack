export type YamlDiffLineKind = "context" | "addition" | "deletion";

export interface YamlDiffLine {
	kind: YamlDiffLineKind;
	text: string;
	beforeLine?: number;
	afterLine?: number;
}

export interface YamlLineDiff {
	lines: YamlDiffLine[];
	beforeLineCount: number;
	afterLineCount: number;
}

interface UnnumberedDiffLine {
	kind: YamlDiffLineKind;
	text: string;
}

export function buildYamlLineDiff(beforeYaml: string, afterYaml: string): YamlLineDiff {
	const beforeLines = yamlLines(beforeYaml);
	const afterLines = yamlLines(afterYaml);
	const unnumberedLines = myersLineDiff(beforeLines, afterLines);
	let beforeLine = 1;
	let afterLine = 1;
	const lines = unnumberedLines.map((line): YamlDiffLine => {
		if (line.kind === "deletion") return { ...line, beforeLine: beforeLine++ };
		if (line.kind === "addition") return { ...line, afterLine: afterLine++ };
		return { ...line, beforeLine: beforeLine++, afterLine: afterLine++ };
	});
	return {
		lines,
		beforeLineCount: beforeLines.length,
		afterLineCount: afterLines.length,
	};
}

function yamlLines(source: string): string[] {
	const lines = source.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function myersLineDiff(beforeLines: string[], afterLines: string[]): UnnumberedDiffLine[] {
	const maximumDistance = beforeLines.length + afterLines.length;
	const frontier = new Map<number, number>([[1, 0]]);
	const traces: Array<Map<number, number>> = [];

	for (let editDistance = 0; editDistance <= maximumDistance; editDistance++) {
		traces.push(new Map(frontier));
		for (let diagonal = -editDistance; diagonal <= editDistance; diagonal += 2) {
			const deletionStart = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
			const additionStart = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
			const startsWithAddition =
				diagonal === -editDistance || (diagonal !== editDistance && deletionStart < additionStart);
			let beforeIndex = startsWithAddition ? (frontier.get(diagonal + 1) ?? 0) : deletionStart + 1;
			let afterIndex = beforeIndex - diagonal;

			while (
				beforeIndex < beforeLines.length &&
				afterIndex < afterLines.length &&
				beforeLines[beforeIndex] === afterLines[afterIndex]
			) {
				beforeIndex++;
				afterIndex++;
			}
			frontier.set(diagonal, beforeIndex);

			if (beforeIndex >= beforeLines.length && afterIndex >= afterLines.length) {
				return backtrackDiff(beforeLines, afterLines, traces, editDistance);
			}
		}
	}

	return [];
}

function backtrackDiff(
	beforeLines: string[],
	afterLines: string[],
	traces: Array<Map<number, number>>,
	finalDistance: number,
): UnnumberedDiffLine[] {
	let beforeIndex = beforeLines.length;
	let afterIndex = afterLines.length;
	const reversedLines: UnnumberedDiffLine[] = [];

	for (let editDistance = finalDistance; editDistance >= 0; editDistance--) {
		const frontier = traces[editDistance]!;
		const diagonal = beforeIndex - afterIndex;
		const deletionStart = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
		const additionStart = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
		const cameFromAddition = diagonal === -editDistance || (diagonal !== editDistance && deletionStart < additionStart);
		const previousDiagonal = cameFromAddition ? diagonal + 1 : diagonal - 1;
		const previousBeforeIndex = frontier.get(previousDiagonal) ?? 0;
		const previousAfterIndex = previousBeforeIndex - previousDiagonal;

		while (beforeIndex > previousBeforeIndex && afterIndex > previousAfterIndex) {
			reversedLines.push({ kind: "context", text: beforeLines[beforeIndex - 1]! });
			beforeIndex--;
			afterIndex--;
		}
		if (editDistance === 0) break;

		if (beforeIndex === previousBeforeIndex) {
			reversedLines.push({ kind: "addition", text: afterLines[afterIndex - 1]! });
			afterIndex--;
		} else {
			reversedLines.push({ kind: "deletion", text: beforeLines[beforeIndex - 1]! });
			beforeIndex--;
		}
	}

	return reversedLines.reverse();
}

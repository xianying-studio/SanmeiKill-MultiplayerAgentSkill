/** JSON Patch for player-visible snapshots; unchanged descriptions are never repeated. */
export type Patch = { op: "add" | "replace" | "remove"; path: string; value?: unknown };
export function diffSnapshots(before: unknown, after: unknown, path = ""): Patch[] {
	if (JSON.stringify(before) === JSON.stringify(after)) return [];
	if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
		const old = before as Record<string, unknown>,
			next = after as Record<string, unknown>;
		const patches: Patch[] = [];
		for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
			const child = path + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1");
			if (!(key in next)) patches.push({ op: "remove", path: child });
			else if (!(key in old)) patches.push({ op: "add", path: child, value: next[key] });
			else patches.push(...diffSnapshots(old[key], next[key], child));
		}
		return patches;
	}
	if (Array.isArray(before) && Array.isArray(after) && before.length === after.length)
		return after.flatMap((item, index) => diffSnapshots(before[index], item, path + "/" + index));
	return [{ op: before === undefined ? "add" : "replace", path, value: after }];
}

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AwtState } from "./types.js";

export async function readState(repoRoot: string): Promise<AwtState> {
	const p = path.join(repoRoot, ".awt", "state.json");
	try {
		const raw = await fs.readFile(p, "utf8");
		return JSON.parse(raw) as AwtState;
	} catch {
		return {};
	}
}

export async function writeState(
	repoRoot: string,
	data: AwtState,
): Promise<void> {
	const dir = path.join(repoRoot, ".awt");
	await fs.mkdir(dir, { recursive: true });
	const p = path.join(dir, "state.json");
	const tmp = `${p}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
	await fs.rename(tmp, p);
}

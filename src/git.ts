import * as path from "node:path";
import { exec } from "./util.js";

export async function repoRoot(): Promise<string> {
	const { stdout, code } = await exec("git", ["rev-parse", "--show-toplevel"]);
	if (code !== 0) throw new Error("Not inside a git repo");
	return stdout.trim();
}

export function repoRootForWorktree(repoBase: string, wtName: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || ".";
	return path.join(home, ".worktrees", repoBase, wtName);
}

export async function currentBranch(wtPath: string): Promise<string> {
    // Try robust detection first
    const r0 = await exec("git", ["-C", wtPath, "branch", "--show-current"]);
    const b0 = r0.stdout.trim();
    if (r0.code === 0 && b0) return b0;
    const r1 = await exec("git", [
        "-C",
        wtPath,
        "symbolic-ref",
        "--short",
        "HEAD",
    ]);
    if (r1.code === 0 && r1.stdout.trim()) return r1.stdout.trim();
    return "detached";
}

export async function headSha(wtPath: string): Promise<string> {
	const r = await exec("git", ["-C", wtPath, "rev-parse", "HEAD"]);
	return r.stdout.trim();
}

export async function originOwnerRepo(
	wtPath: string,
): Promise<{ owner: string; repo: string }> {
	const { stdout } = await exec("git", [
		"-C",
		wtPath,
		"remote",
		"get-url",
		"origin",
	]);
	const url = stdout.trim();
	// SSH: git@github.com:owner/repo.git
	const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
	if (!m || !m[1] || !m[2])
		throw new Error(`Could not parse origin URL: ${url}`);
	return { owner: m[1], repo: m[2] };
}

export async function remoteHeadSha(
	wtPath: string,
	branch: string,
): Promise<string | null> {
	const { stdout, code } = await exec("git", [
		"-C",
		wtPath,
		"ls-remote",
		"--heads",
		"origin",
		`refs/heads/${branch}`,
	]);
	if (code !== 0 || !stdout.trim()) return null;
	return stdout.split(/\s+/)[0] || null;
}

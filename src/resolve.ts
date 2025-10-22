import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
	currentBranch,
	originOwnerRepo,
	remoteHeadSha,
	repoRoot,
	repoRootForWorktree,
} from "./git.js";
import type { Gh } from "./github.js";
import type { WatchConfig } from "./types.js";
import { exec } from "./util.js";

export interface Target {
	repoRoot: string;
	worktreePath: string; // may equal repoRoot
	owner: string;
	repo: string;
	localBranch: string | null;
	remoteBranch: string | null;
	headSha: string; // remote head sha resolved for remoteBranch
	prNumber: number | null;
	sinceIso: string; // commit date for headSha (fallback: 24h)
}

export interface ResolveOptions {
	cwd?: string;
	explicitWt?: string | null;
	explicitBranch?: string | null;
	gh: Gh;
	cfg?: WatchConfig | null;
}

/**
 * Best-effort resolver:
 * - repo root
 * - worktree path (explicit ~/.worktrees mapping if provided; else repo root)
 * - owner/repo (origin)
 * - branch (explicit > local > null on detached)
 * - remote branch (upstream of local if any; else local name; else from branchesForCommit)
 * - head sha (remote)
 * - PR number (by sha else by branch)
 * - sinceIso (commit date of head sha; fallback 24h ago)
 */
export async function resolveTarget(opts: ResolveOptions): Promise<Target> {
	const _cwd = opts.cwd || process.cwd();
	const root = await repoRoot();
	const repoBase = path.basename(root);

	// Worktree resolution
	let wtPath = root;
	if (opts.explicitWt) {
		const p = repoRootForWorktree(repoBase, opts.explicitWt);
		try {
			await fs.access(p);
			wtPath = p;
		} catch {
			// If explicit WT not found, keep repo root but do not fail; caller will handle errors.
			wtPath = root;
		}
	}

	// Owner/repo from origin
	const ownerRepo = await originOwnerRepo(wtPath).catch(async () =>
		originOwnerRepo(root),
	);
	const { owner, repo } = ownerRepo;

	// Prefer local branch; handle detached
	const locBranchRaw = await currentBranch(wtPath).catch(async () =>
		currentBranch(root),
	);
	const localBranch =
		locBranchRaw && locBranchRaw !== "detached" ? locBranchRaw : null;

	// Try upstream tracking for remote branch
	let remoteBranch: string | null = null;
	try {
		const r = await exec("git", [
			"-C",
			wtPath,
			"rev-parse",
			"--abbrev-ref",
			"--symbolic-full-name",
			"@{u}",
		]);
		if (r.code === 0) {
			// Output like: origin/main
			const up = r.stdout.trim();
			remoteBranch = up.includes("/")
				? up.split("/").slice(1).join("/")
				: up || null;
		}
	} catch {
		// ignore
	}

	if (!remoteBranch && localBranch) {
		remoteBranch = localBranch;
	}

	// Resolve remote head sha; if missing, try via GitHub (branch ref), else via branchesForCommit
	let headSha: string | null = null;
	if (remoteBranch) {
		headSha =
			(await remoteHeadSha(wtPath, remoteBranch).catch(async () =>
				remoteHeadSha(root, remoteBranch!),
			)) || null;
		if (!headSha) {
			headSha = await opts.gh.getBranchSha({ owner, repo }, remoteBranch);
		}
	}
	if (!headSha) {
		// Detached or local-only branch; try to find a branch on GitHub that contains HEAD of working tree
		const headLocalSha = (
			await exec("git", ["-C", wtPath, "rev-parse", "HEAD"])
		).stdout.trim();
		const branches = await opts.gh.branchesForCommit(
			{ owner, repo },
			headLocalSha,
		);
		if (branches?.length) {
			remoteBranch = branches[0] || remoteBranch;
			headSha = await opts.gh.getBranchSha({ owner, repo }, remoteBranch!);
		}
	}
	if (!headSha || !remoteBranch) {
		throw new Error(
			"Cannot infer remote branch/sha. Push your branch or pass --branch <remote-branch>.",
		);
	}

	// PR number: prefer sha, else by branch
	let prNumber: number | null = await opts.gh
		.findPrBySha({ owner, repo }, headSha)
		.catch(() => null);
	if (!prNumber && remoteBranch) {
		prNumber = await opts.gh
			.findOpenPrForBranch({ owner, repo }, owner, remoteBranch)
			.catch(() => null);
	}

	// Since = commit authored/committed date of headSha (fallback to 24h ago)
	let sinceIso: string | null = await opts.gh
		.getCommitDate({ owner, repo }, headSha)
		.catch(() => null);
	if (!sinceIso) {
		sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
	}

	return {
		repoRoot: root,
		worktreePath: wtPath,
		owner,
		repo,
		localBranch,
		remoteBranch,
		headSha,
		prNumber,
		sinceIso,
	};
}

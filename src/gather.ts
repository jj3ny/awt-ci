import * as path from "node:path";
import { promises as fs } from "node:fs";
import { gatherFailures } from "./ci.js";
import {
	currentBranch,
	headSha,
	originOwnerRepo,
	remoteHeadSha,
	repoRoot,
	repoRootForWorktree,
} from "./git.js";
import { Gh } from "./github.js";
import { readState } from "./state.js";
import { buildAgentPayload, summarizeFailures } from "./summarize.js";
import type { Engine, WatchConfig } from "./types.js";
import { copyToClipboard, getGhToken, readJsonc, safeRead } from "./util.js";

export async function gather(opts: {
    worktree: string;
    engine: Engine;
    copy: boolean;
    branch?: string;
}) {
	const wt = opts.worktree;
	const root = await repoRoot();
	const repoBase = path.basename(root);
    const wtPath = repoRootForWorktree(repoBase, wt);
    // Ensure the worktree path exists; this command is scoped to that worktree
    try {
        await fs.access(wtPath);
    } catch {
        process.stderr.write(
            `Worktree '${wt}' not found at ${wtPath}. Create it or use --branch to target a remote branch.\n`,
        );
        process.exitCode = 1;
        return;
    }

	const cfgPath = path.join(root, ".awt", "config.jsonc");
	const cfg = (await readJsonc<WatchConfig>(cfgPath)) || {};
	const engine = cfg.engine || opts.engine;
	const summarizePerJobKB = cfg.summarizePerJobKB ?? 512;
	const summarizeTotalMB = cfg.summarizeTotalMB ?? 5;
	const promptPath = cfg.promptPath
		? path.join(root, cfg.promptPath)
		: path.join(root, ".awt", "prompts", "debug.md");
	const prompt = await safeRead(
		promptPath,
		"Please analyze the failures above and continue working to resolve them.",
	);

	const ghToken = await getGhToken();
	const gh = new Gh(ghToken || undefined);

	const state = await readState(root);
	const warnings: string[] = [];
	const ownerRepo =
		cfg.owner && cfg.repo
			? { owner: cfg.owner, repo: cfg.repo }
			: await originOwnerRepo(wtPath).catch(async () => originOwnerRepo(root));
	const { owner, repo } = ownerRepo;
    const branch = await currentBranch(wtPath).catch(() => "detached");
    let prNumber: number | null = null;
    if (!opts.branch && branch && branch !== "detached") {
        prNumber = await gh
            .findOpenPrForBranch({ owner, repo }, owner, branch)
            .catch(() => null);
    }

    // Determine target branch and remote HEAD strictly (remote-first behavior)
    let targetBranch: string | null = opts.branch || (branch !== "detached" ? branch : null);
    let sha: string | null = null;
    if (targetBranch) {
        sha =
            (await remoteHeadSha(wtPath, targetBranch).catch(async () =>
                remoteHeadSha(root, targetBranch),
            )) || null;
        if (!sha) {
            // Try GitHub API for branch ref
            sha = await gh.getBranchSha({ owner, repo }, targetBranch);
        }
        if (!sha) {
            // As a last remote check for this branch, use latest workflow runs to infer head_sha
            sha = await gh.headShaForBranch({ owner, repo }, targetBranch);
        }
    }
    if (!targetBranch) {
        const msg = `Cannot determine current branch for worktree '${wt}'. Specify --branch <remote-branch>.`;
        process.stderr.write(`${msg}\n`);
        process.exitCode = 1;
        return;
    }
    if (!sha) {
        // If invoked by worktree (no --branch) and a PR exists, fall back to PR head SHA
        if (!opts.branch && prNumber) {
            try {
                const prLite = await gh.getPrLite({ owner, repo }, prNumber);
                sha = prLite?.headSha || null;
            } catch {}
        }
        if (!sha) {
            const msg = `Unable to resolve remote HEAD for branch '${targetBranch}'. Ensure the branch exists on 'origin' and try: git fetch origin ${targetBranch}`;
            process.stderr.write(`${msg}\n`);
            process.exitCode = 1;
            return;
        }
    }

	let text = "";
	let isError = false; // When true, prefer STDERR output
	let footerInfo: string | null = null; // extra info for stdout (not copied)
    if (prNumber && sha) {
		const ci = await gh
			.latestCiForSha({ owner, repo }, sha)
			.catch(() => ({ conclusion: null, runs: [] }));
		try {
			const bundle = await gatherFailures(
				{ owner, repo },
				prNumber,
				sha,
				gh,
				summarizePerJobKB,
				summarizeTotalMB,
			);
			if (bundle) {
				const summary = await summarizeFailures(bundle, engine, {
					cwd: wtPath,
					repo: { owner, repo },
				});
				// Determine remote push timestamp: earliest workflow run createdAt for this SHA
				let sinceIso: string | null = null;
				try {
					const times = (ci.runs || [])
						.map((r) => r.createdAt)
						.filter((t): t is string => !!t)
						.map((t) => new Date(t).getTime())
						.filter((n) => Number.isFinite(n));
					if (times.length) sinceIso = new Date(Math.min(...times)).toISOString();
				} catch {}
				if (!sinceIso) sinceIso = await gh.getCommitDate({ owner, repo }, sha);

				let comments: { author: string; createdAt: string; body: string; url: string }[] = [];
				let sinceCount = 0;
				let priorCount = 0;
				let priorLatest: string | null = null;
				if (sinceIso) {
					comments = await gh
						.listCommentsSince(
							{ owner, repo },
							prNumber,
							sinceIso,
							cfg.maxRecentComments ?? 30,
						)
						.catch(() => []);
					sinceCount = comments?.length || 0;
					// Compute prior comment stats without widening the window
					const recentAll = await gh
						.listCommentsRecent(
							{ owner, repo },
							prNumber,
							cfg.maxRecentComments ?? 30,
						)
						.catch(() => []);
					const prior = recentAll.filter(
						(c) => (c.createdAt || "") < (sinceIso || ""),
					);
					priorCount = prior.length;
					priorLatest = prior.length
						? prior[prior.length - 1]?.createdAt || null
						: null;
				} else {
					warnings.push(
						"Warning: Unable to determine remote push time; PR comments since last push omitted.",
					);
				}
				const payload = await buildAgentPayload({
					prNumber,
					sha,
					failureSummary: summary,
					comments,
					debugPrompt: prompt,
					runs: ci.runs.map((r) => ({
						url: r.url,
						conclusion: r.conclusion || null,
					})),
					pushedAtIso: sinceIso || undefined,
				});
				text = payload.text;
				// Footer info: PR and run age + comment counts
				const createdAt = ci.runs[0]?.createdAt || sinceIso || "";
				const age = formatAge(createdAt);
				const priorDelta = priorLatest
					? `${formatDelta(
							new Date((sinceIso || createdAt) as string).getTime() -
								new Date(priorLatest).getTime(),
						)} before last push`
					: "no prior comments";
				footerInfo = sinceIso
					? `Source: PR #${prNumber} (branch '${targetBranch}'), run age: ${age}; comments since last push: ${sinceCount}, prior: ${priorCount} (${priorDelta})`
					: `Source: PR #${prNumber} (branch '${targetBranch}'), run age: ${age}; comments since last push: unavailable`;
			} else {
				text = `No failing runs found for PR #${prNumber} on ${sha.slice(0, 7)}. Latest CI: ${ci.conclusion || "unknown"}.`;
				isError = true;
			}
		} catch (_e) {
			// Could not gather context (API or other failure)
			text = `Unable to gather CI context for PR #${prNumber} on ${sha.slice(0, 7)}.`;
			isError = true;
		}
    } else if (sha && targetBranch) {
		// Branch-only mode: gather for latest CI failure on this branch
		const ci = await gh
			.latestCiForSha({ owner, repo }, sha)
			.catch(() => ({ conclusion: null, runs: [] }));
		try {
			const bundle = await gatherFailures(
				{ owner, repo },
				0, // sentinel: no PR
				sha,
				gh,
				summarizePerJobKB,
				summarizeTotalMB,
			);
			if (bundle) {
				const summary = await summarizeFailures(bundle, engine, {
					cwd: wtPath,
					repo: { owner, repo },
				});
				// No PR comments in branch mode
				const payload = await buildAgentPayload({
					prNumber: 0,
					sha,
					failureSummary: summary,
					comments: [],
					debugPrompt: prompt,
					runs: ci.runs.map((r) => ({
						url: r.url,
						conclusion: r.conclusion || null,
					})),
				});
				text = payload.text;
            const createdAt =
                ci.runs[0]?.createdAt ||
                (await gh.getCommitDate({ owner, repo }, sha)) ||
                new Date(0).toISOString();
            const age = formatAge(createdAt);
            footerInfo = `Source: branch '${targetBranch}' (sha ${sha.slice(0, 7)}), run age: ${age}`;
        } else {
            text = `No failing runs found for branch '${targetBranch}' on ${sha.slice(0, 7)}. Latest CI: ${ci.conclusion || "unknown"}.`;
            isError = true;
        }
		} catch (_e) {
			text = `Unable to gather CI context for branch '${targetBranch}' on ${sha.slice(0, 7)}.`;
			isError = true;
		}
	}

	// Append any warnings into output text and also echo to stderr
	if (warnings.length) {
		text += `\n\n${warnings.join("\n")}`;
	}

	// Always print the payload to stdout/stderr
	if (isError) process.stderr.write(`${text}\n`);
	else process.stdout.write(`${text}\n`);
	if (footerInfo) process.stdout.write(`\n${footerInfo}\n`);
	for (const w of warnings) process.stderr.write(`${w}\n`);

	// Also copy to clipboard unless disabled
	if (opts.copy) {
		const ok = await copyToClipboard(text);
		const msg = ok
			? "(copied to clipboard)"
			: isError
				? "(clipboard utility not found; printed to stderr)"
				: "(clipboard utility not found; printed to stdout)";
		process.stderr.write(`${msg}\n`);
	}
}

// safeRead moved to util.ts

function formatAge(iso: string): string {
	try {
		const t = new Date(iso).getTime();
		if (!Number.isFinite(t)) return "unknown";
		let ms = Date.now() - t;
		if (ms < 0) ms = 0;
		const totalMin = Math.floor(ms / 60000);
		const days = Math.floor(totalMin / (60 * 24));
		const hours = Math.floor((totalMin % (60 * 24)) / 60);
		const mins = totalMin % 60;
		if (days > 0) return `${days}d${hours}h${mins}m`;
		if (hours > 0) return `${hours}h${mins}m`;
		return `${mins}m`;
	} catch {
		return "unknown";
	}
}

function formatDelta(ms: number): string {
	if (ms <= 0) return "0m";
	const totalMin = Math.floor(ms / 60000);
	const days = Math.floor(totalMin / (60 * 24));
	const hours = Math.floor((totalMin % (60 * 24)) / 60);
	const mins = totalMin % 60;
	if (days > 0) return `${days}d${hours}h${mins}m`;
	if (hours > 0) return `${hours}h${mins}m`;
	return `${mins}m`;
}

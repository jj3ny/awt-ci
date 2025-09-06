import * as path from "node:path";
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
	const ownerRepo =
		cfg.owner && cfg.repo
			? { owner: cfg.owner, repo: cfg.repo }
			: await originOwnerRepo(wtPath).catch(async () => originOwnerRepo(root));
	const { owner, repo } = ownerRepo;
	const branch = await currentBranch(wtPath).catch(async () =>
		currentBranch(root),
	);
	let prNumber: number | null = null;
	if (!opts.branch && branch && branch !== "detached") {
		prNumber = await gh
			.findOpenPrForBranch({ owner, repo }, owner, branch)
			.catch(() => null);
	}

	// Determine target SHA
	let sha = state.last_push?.sha || null;
	if (opts.branch) {
		// Explicit remote branch mode: select latest remote HEAD for that branch
		sha =
			(await remoteHeadSha(wtPath, opts.branch).catch(async () =>
				remoteHeadSha(root, opts.branch as string),
			)) || sha;
	} else if (!sha && branch && branch !== "detached") {
		sha =
			(await remoteHeadSha(wtPath, branch).catch(async () =>
				remoteHeadSha(root, branch),
			)) || null;
	}
	if (!sha) sha = await headSha(wtPath).catch(async () => headSha(root));
	if (!sha) sha = ""; // best effort; CI may not be retrievable without SHA

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
				let sinceIso = state.last_push?.pushed_at;
				if (!sinceIso)
					sinceIso =
						(await gh.getCommitDate({ owner, repo }, sha)) ||
						new Date(0).toISOString();
				const comments = await gh
					.listCommentsSince(
						{ owner, repo },
						prNumber,
						sinceIso,
						cfg.maxRecentComments ?? 30,
					)
					.catch(() => []);
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
				const priorLatest = prior.length
					? prior[prior.length - 1]?.createdAt || null
					: null;
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
					pushedAtIso: sinceIso,
				});
				text = payload.text;
				// Footer info: PR and run age + comment counts
				const createdAt = ci.runs[0]?.createdAt || sinceIso;
				const age = formatAge(createdAt);
				const sinceCount = comments?.length || 0;
				const priorCount = prior.length;
				const priorDelta = priorLatest
					? `${formatDelta(
							new Date(sinceIso || createdAt!).getTime() -
								new Date(priorLatest).getTime(),
						)} before last push`
					: "no prior comments";
				footerInfo = `Source: PR #${prNumber} (branch '${branch}'), run age: ${age}; comments since last push: ${sinceCount}, prior: ${priorCount} (${priorDelta})`;
			} else {
				text = `No failing runs found for PR #${prNumber} on ${sha.slice(0, 7)}. Latest CI: ${ci.conclusion || "unknown"}.`;
				isError = true;
			}
		} catch (_e) {
			// Could not gather context (API or other failure)
			text = `Unable to gather CI context for PR #${prNumber} on ${sha.slice(0, 7)}.`;
			isError = true;
		}
	} else if (opts.branch && sha) {
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
				footerInfo = `Source: branch '${opts.branch}' (sha ${sha.slice(0, 7)}), run age: ${age}`;
			} else {
				text = `No failing runs found for branch '${opts.branch}' on ${sha.slice(0, 7)}. Latest CI: ${ci.conclusion || "unknown"}.`;
				isError = true;
			}
		} catch (_e) {
			text = `Unable to gather CI context for branch '${opts.branch}' on ${sha.slice(0, 7)}.`;
			isError = true;
		}
	} else {
		text = `No open PR found for branch '${branch}', and no --branch provided.`;
		isError = true;
	}

	// Always print the payload to stdout/stderr
	if (isError) process.stderr.write(`${text}\n`);
	else process.stdout.write(`${text}\n`);
	if (footerInfo) process.stdout.write(`\n${footerInfo}\n`);

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

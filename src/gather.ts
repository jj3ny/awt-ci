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
	if (branch && branch !== "detached") {
		prNumber = await gh
			.findOpenPrForBranch({ owner, repo }, owner, branch)
			.catch(() => null);
	}

	// Determine target SHA
	let sha = state.last_push?.sha || null;
	if (!sha && branch && branch !== "detached")
		sha =
			(await remoteHeadSha(wtPath, branch).catch(async () =>
				remoteHeadSha(root, branch),
			)) || null;
	if (!sha) sha = await headSha(wtPath).catch(async () => headSha(root));
	if (!sha) sha = ""; // best effort; CI may not be retrievable without SHA

	let text = "";
	let isError = false; // When true, prefer STDERR output
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
			} else {
				text = `No failing runs found for PR #${prNumber} on ${sha.slice(0, 7)}. Latest CI: ${ci.conclusion || "unknown"}.`;
				isError = true;
			}
		} catch (_e) {
			// Could not gather context (API or other failure)
			text = `Unable to gather CI context for PR #${prNumber} on ${sha.slice(0, 7)}.`;
			isError = true;
		}
	} else {
		text = `No open PR found for branch '${branch}'. Consider pushing and opening a PR first.`;
		isError = true;
	}

	if (opts.copy) {
		const ok = await copyToClipboard(text);
		if (!ok) {
			if (isError) {
				process.stderr.write(`${text}\n`);
				process.stderr.write(
					"(clipboard utility not found; printed to stderr)\n",
				);
			} else {
				process.stdout.write(`${text}\n`);
				process.stderr.write(
					"(clipboard utility not found; printed to stdout)\n",
				);
			}
		}
	} else {
		if (isError) process.stderr.write(`${text}\n`);
		else process.stdout.write(`${text}\n`);
	}
}

// safeRead moved to util.ts

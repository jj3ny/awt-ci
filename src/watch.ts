import * as path from "node:path";
import { exec, readJsonc, sleep, getGhToken, safeRead } from "./util.js";
import {
	repoRoot,
	repoRootForWorktree,
	currentBranch,
	headSha,
	originOwnerRepo,
	remoteHeadSha,
} from "./git.js";
import {
	resolveRepoSessionNameOrScan,
	windowNameForWt,
	resolvePrimaryPane,
	paneHistorySig,
	pasteAndEnter,
	notifyAll,
} from "./tmux.js";
import { readState, writeState } from "./state.js";
import { Gh } from "./github.js";
import { gatherFailures } from "./ci.js";
import { summarizeFailures, buildAgentPayload } from "./summarize.js";
import type { Engine, WatchConfig } from "./types.js";
import { promises as fs } from "node:fs";

export async function watch(opts: {
	worktree: string;
	engine: Engine;
	idleSec: number;
	pollSecIdle: number;
	pollSecPostPush: number;
	eventMode: boolean;
}) {
	const wt = opts.worktree;
	const root = await repoRoot();
	const repoBase = path.basename(root);
	const wtPath = repoRootForWorktree(repoBase, wt);

	// Load config.jsonc if present
	const cfgPath = path.join(root, ".awt", "config.jsonc");
	const cfg = (await readJsonc<WatchConfig>(cfgPath)) || {};
	const engine = cfg.engine || opts.engine;
	const summarizePerJobKB = cfg.summarizePerJobKB ?? 512;
	const summarizeTotalMB = cfg.summarizeTotalMB ?? 5;
  const pollIdle = cfg.pollSecIdle ?? opts.pollSecIdle;
  const pollFast = cfg.pollSecPostPush ?? opts.pollSecPostPush;
  const idleSec = cfg.idleSec ?? opts.idleSec;
  const conflictHints = cfg.conflictHints ?? "simple";
	const promptPath = cfg.promptPath
		? path.join(root, cfg.promptPath)
		: path.join(root, ".awt", "prompts", "debug.md");
  const prompt = await safeRead(promptPath);

	const win = windowNameForWt(wt);
	const sess = await resolveRepoSessionNameOrScan(root, win);
	let pane: string;
	try {
		pane = await resolvePrimaryPane(sess, win);
	} catch (e) {
		throw new Error(
			`tmux target not found for ${sess}:${win}. Ensure the worktree window exists.`,
		);
	}

	const ghToken = await getGhToken();
	const gh = new Gh(ghToken || undefined);
	const state = await readState(root);

	const ownerRepo =
		cfg.owner && cfg.repo
			? { owner: cfg.owner, repo: cfg.repo }
			: await originOwnerRepo(wtPath).catch(async () => originOwnerRepo(root));
	const { owner, repo } = ownerRepo;

	let lastSig: string | null = null;
	let idleStart: number | null = null;
	let lastNotifiedDormant = false;
	let postPush = false;
	let notifiedNoPrForSha: string | null = null;

	// Helper to notify once per idle period
	async function maybeNotifyDormant() {
		if (
			!state.last_push &&
			idleStart &&
			(Date.now() - idleStart) / 1000 >= idleSec &&
			!lastNotifiedDormant
		) {
			await notifyAll(
				sess,
				`AWT ${repoBase}/${wt}`,
				"Agent appears dormant; no push/PR yet.",
			);
			lastNotifiedDormant = true;
		}
	}

	// Minimal event-mode fast path: if invoked with CI env, gather once and exit
	if (opts.eventMode && process.env.GITHUB_HEAD_SHA) {
		const sha = process.env.GITHUB_HEAD_SHA;
		let prNumber: number | null = await gh
			.findPrBySha({ owner, repo }, sha)
			.catch(() => null);
		if (!prNumber) {
			const branch = await currentBranch(wtPath).catch(async () =>
				currentBranch(root),
			);
			if (branch && branch !== "detached") {
				prNumber = await gh
					.findOpenPrForBranch({ owner, repo }, owner, branch)
					.catch(() => null);
			}
		}
		if (prNumber) {
			const ci = await gh
				.latestCiForSha({ owner, repo }, sha)
				.catch(() => ({ conclusion: null, runs: [] }));
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
				const sinceIso =
					state.last_push?.pushed_at ||
					(await gh.getCommitDate({ owner, repo }, sha)) ||
					new Date(0).toISOString();
				const comments = await gh
					.listCommentsSince({ owner, repo }, prNumber, sinceIso, 30)
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
				await pasteAndEnter(pane, payload.text, payload.sentinel);
				await notifyAll(
					sess,
					`AWT ${repoBase}/${wt}`,
					`Posted CI failure summary (event-mode) for PR #${prNumber}.`,
				);
			}
		}
		return;
	}

	while (true) {
		try {
			// Idle detection via pane signature
			try {
				const sig = await paneHistorySig(sess, win);
				if (sig !== lastSig) {
					lastSig = sig;
					idleStart = Date.now();
					lastNotifiedDormant = false;
				} else if (!postPush) {
					await maybeNotifyDormant();
				}
			} catch {}

			// Determine branch & remote sha
			const branch = await currentBranch(wtPath).catch(async () =>
				currentBranch(root),
			);
			let remoteSha: string | null = null;
			if (branch && branch !== "detached") {
				remoteSha = await remoteHeadSha(wtPath, branch).catch(async () =>
					remoteHeadSha(root, branch),
				);
			}

			// Detect push (via remote HEAD change vs state)
			if (remoteSha && remoteSha !== state.last_push?.sha) {
				state.last_push = {
					sha: remoteSha,
					pushed_at: new Date().toISOString(),
				};
				await writeState(root, state);
				postPush = true;
				notifiedNoPrForSha = null;
			}

      // Resolve PR: prefer by SHA, then by branch
      let prNumber: number | null = null;
      if (state.last_push?.sha) {
        prNumber = await gh
          .findPrBySha({ owner, repo }, state.last_push.sha)
          .catch(() => null);
      }
      if (!prNumber && branch && branch !== "detached") {
        prNumber = await gh
          .findOpenPrForBranch({ owner, repo }, owner, branch)
          .catch(() => null);
      }
			if (
				postPush &&
				!prNumber &&
				state.last_push?.sha &&
				notifiedNoPrForSha !== state.last_push.sha
			) {
				await notifyAll(
					sess,
					`AWT ${repoBase}/${wt}`,
					"Detected push but no open PR yet.",
				);
				notifiedNoPrForSha = state.last_push.sha;
			}

			// If we have a PR and a push SHA, check mergeability and CI
			if (prNumber && state.last_push?.sha) {
				const prLite = await gh
					.getPrLite({ owner, repo }, prNumber)
					.catch(() => null);
				if (prLite) {
					if (["dirty", "behind"].includes(prLite.mergeable_state || "")) {
						const files = await gh
							.prFiles({ owner, repo }, prNumber)
							.catch(() => []);
						const likely = files
							.filter((f) => f.status === "modified" && f.changes > 100)
							.map((f) => f.filename)
							.slice(0, 10);
            const rebaseSummary =
              conflictHints === "simple+recent-base"
                ? "Rebase needed (merge conflicts or behind main). Please rebase on main and resolve.\n\nAlso inspect recent base changes to these files and nearby code:\n  git fetch origin\n  git log --name-only --since='7 days' origin/main | sed -n '1,200p'\n  git log --merges --since='14 days' origin/main | sed -n '1,200p'\n"
                : "Rebase needed (merge conflicts or behind main). Please rebase on main and resolve.";
            const payload = await buildAgentPayload({
              prNumber,
              sha: state.last_push.sha,
              failureSummary: rebaseSummary,
              comments: [],
              debugPrompt: prompt,
              runs: [],
              conflictFiles: likely,
              pushedAtIso: state.last_push.pushed_at,
            });
						const res = await pasteAndEnter(
							pane,
							payload.text,
							payload.sentinel,
						);
						if (res === "ok")
							await notifyAll(
								sess,
								`AWT ${repoBase}/${wt}`,
								`Posted rebase instructions for PR #${prNumber}.`,
							);
					} else {
						const ci = await gh
							.latestCiForSha({ owner, repo }, state.last_push.sha)
							.catch(() => ({ conclusion: null, runs: [] }));
						if (
							ci.conclusion === "failure" &&
							state.last_ci_seen_for_sha !== state.last_push.sha
						) {
							const bundle = await gatherFailures(
								{ owner, repo },
								prNumber,
								state.last_push.sha,
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
										(await gh.getCommitDate(
											{ owner, repo },
											state.last_push.sha,
										)) || new Date(0).toISOString();
								const comments = await gh
									.listCommentsSince({ owner, repo }, prNumber, sinceIso, 30)
									.catch(() => []);
								const payload = await buildAgentPayload({
									prNumber,
									sha: state.last_push.sha,
									failureSummary: summary,
									comments,
									debugPrompt: prompt,
									runs: ci.runs.map((r) => ({
										url: r.url,
										conclusion: r.conclusion || null,
									})),
									pushedAtIso: sinceIso,
								});
								const res = await pasteAndEnter(
									pane,
									payload.text,
									payload.sentinel,
								);
								if (res === "ok")
									await notifyAll(
										sess,
										`AWT ${repoBase}/${wt}`,
										`Posted CI failure summary for PR #${prNumber}.`,
									);
								state.last_ci_seen_for_sha = state.last_push.sha;
								state.last_ci_conclusion = "failure";
								await writeState(root, state);
							}
						} else if (
							ci.conclusion === "success" &&
							state.last_ci_seen_for_sha !== state.last_push.sha
						) {
							await notifyAll(
								sess,
								`AWT ${repoBase}/${wt}`,
								`CI passed for PR #${prNumber}.`,
							);
							state.last_ci_seen_for_sha = state.last_push.sha;
							state.last_ci_conclusion = "success";
							await writeState(root, state);
						}
					}
				}
			}

			// Sleep based on cadence with jitter to avoid synchronization
			const baseSec = postPush ? pollFast : pollIdle;
			const jitterSec = baseSec * (0.9 + Math.random() * 0.2);
			await sleep(jitterSec * 1000);
			// After CI seen for this sha, revert to idle cadence
			if (state.last_ci_seen_for_sha === state.last_push?.sha) postPush = false;
		} catch (err) {
			// keep the watcher alive
			await sleep(2000);
		}
	}
}

// safeRead moved to util.ts

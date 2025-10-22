import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
	currentBranch,
	originOwnerRepo,
	remoteHeadSha,
	repoRoot,
	repoRootForWorktree,
} from "./git.js";
import { Gh } from "./github.js";
import {
	buildMarkdownXmlReport,
	buildReportFilename,
	toRunExtract,
} from "./report.js";
import { summarizeErrorExcerptText } from "./summarize.js";
import type {
	Engine,
	GatherFlags,
	JobBrief,
	RunBrief,
	RunExtract,
	WatchConfig,
} from "./types.js";
import {
	type ansi,
	color,
	ensureDir,
	getGhToken,
	homePathDisplay,
	nowStampUTC,
	pathExists,
	readJsonc,
	safeRead,
	shortenSha,
	writeFileAtomic,
} from "./util.js";

export async function gather(opts: {
	worktree: string;
	engine: Engine;
	force: boolean;
	skipClaude: boolean;
	claudeOnly: boolean;
	branch?: string;
	out?: string;
}) {
	const wt = opts.worktree;
	const root = await repoRoot();
	const repoBase = path.basename(root);
	const wtPath = repoRootForWorktree(repoBase, wt);
	const branchMode = !!opts.branch;

	let wtExists = true;
	try {
		await fs.access(wtPath);
	} catch {
		wtExists = false;
	}
	if (!wtExists && !branchMode) {
		process.stderr.write(
			`Worktree '${wt}' not found at ${wtPath}. Create it or use --branch to target a remote branch.\n`,
		);
		process.exitCode = 1;
		return;
	}
	const ctxPath = wtExists ? wtPath : root;

	// Load config.jsonc if present
	const cfgPath = path.join(root, ".awt", "config.jsonc");
	const cfg = (await readJsonc<WatchConfig>(cfgPath)) || {};
	const engine = cfg.engine || opts.engine;
	const promptPath = cfg.promptPath
		? path.join(root, cfg.promptPath)
		: path.join(root, ".awt", "prompts", "debug.md");
	const _prompt = await safeRead(
		promptPath,
		"Please analyze the failures above and continue working to resolve them.",
	);

	const ghToken = await getGhToken();
	const gh = new Gh(ghToken || undefined);

	// Determine owner/repo from origin
	const ownerRepo =
		cfg.owner && cfg.repo
			? { owner: cfg.owner, repo: cfg.repo }
			: await originOwnerRepo(ctxPath).catch(async () => originOwnerRepo(root));
	const { owner, repo } = ownerRepo;

	// Resolve target branch (remote-only)
	const localBranch = wtExists
		? await currentBranch(wtPath).catch(() => "detached")
		: "detached";
	const targetBranch: string | null =
		opts.branch || (localBranch !== "detached" ? localBranch : null);
	if (!targetBranch) {
		process.stderr.write(
			`Cannot determine current branch for worktree '${wt}'. Specify --branch <remote-branch>.\n`,
		);
		process.exitCode = 1;
		return;
	}

	// Resolve remote HEAD sha
	let sha: string | null =
		(await remoteHeadSha(ctxPath, targetBranch).catch(async () =>
			remoteHeadSha(root, targetBranch),
		)) || null;
	if (!sha) {
		// GitHub API fallback confirms remote existence
		sha = await gh.getBranchSha({ owner, repo }, targetBranch);
	}
	if (!sha) {
		process.stderr.write(
			`No remote branch found for '${targetBranch}' on origin. Ensure it exists and fetch: git fetch origin ${targetBranch}\n`,
		);
		process.exitCode = 1;
		return;
	}

	// Last push time = commit date of remote HEAD
	const sinceIso: string =
		(await gh.getCommitDate({ owner, repo }, sha)) ||
		new Date(Date.now() - 24 * 3600 * 1000).toISOString();

	// PR number and comments since last push
	const prNumber: number | null = await gh
		.findOpenPrForBranch({ owner, repo }, owner, targetBranch)
		.catch(() => null);

	let commentsSince: {
		author: string;
		createdAt: string;
		body: string;
		url: string;
	}[] = [];
	let totalRecentComments = 0;
	if (prNumber) {
		try {
			commentsSince = await gh.listCommentsSince(
				{ owner, repo },
				prNumber,
				sinceIso,
				cfg.maxRecentComments ?? 30,
			);
			const recentAll = await gh.listCommentsRecent(
				{ owner, repo },
				prNumber,
				100,
			);
			totalRecentComments = recentAll.length;
		} catch {
			commentsSince = [];
		}
	}

	// Workflow runs since last push
	const runsSince = await gh.listWorkflowRunsSince(
		{ owner, repo },
		targetBranch,
		sinceIso,
	);
	const failureLike = new Set(["failure", "timed_out", "cancelled"]);
	const inProgress = runsSince.filter((r) => r.status !== "completed");
	const completedFailing = runsSince.filter(
		(r) =>
			r.status === "completed" && r.conclusion && failureLike.has(r.conclusion),
	);

	if (inProgress.length && !opts.force) {
		const msg = [
			`CI is still in progress for branch '${targetBranch}' (since ${sinceIso}).`,
			`Pending runs: ${inProgress.map((r) => `#${r.id}`).join(", ") || "(none)"}`,
			`Re-run with --force to compile partial information now.`,
		].join("\n");
		process.stderr.write(`${msg}\n`);
		process.exitCode = 2;
		return;
	}

	// Build run extracts (completed failing first, then forced in-progress)
	const runExtracts: RunExtract[] = [];
	const includedRunIds: number[] = [];

	async function fetchRunExtract(run: RunBrief): Promise<RunExtract | null> {
		const jobs = await gh.listJobsForRun({ owner, repo }, run.id);
		const failingJobs: JobBrief[] = jobs
			.filter(
				(j) =>
					(j.conclusion && failureLike.has(j.conclusion)) ||
					(run.status !== "completed" &&
						j.status === "completed" &&
						j.conclusion &&
						failureLike.has(j.conclusion)),
			)
			.map((j) => ({
				id: j.id,
				runId: run.id,
				name: j.name,
				html_url: j.html_url,
				conclusion: j.conclusion,
				status: j.status ?? null,
			}));

		if (!failingJobs.length && run.status !== "completed") {
			if (opts.force) {
				return {
					run,
					jobs: [],
					totalCounts: { error: 0, failed: 0, xfail: 0, lines: 0, chars: 0 },
				};
			}
			return null;
		}

		const jobLogs: Record<number, string> = {};
		for (const j of failingJobs) {
			try {
				const raw = await gh.fetchJobLog({ owner, repo }, j.id);
				jobLogs[j.id] = raw;
			} catch {
				jobLogs[j.id] = "(unable to fetch logs for this job; open in browser)";
			}
		}
		return toRunExtract(run, failingJobs, jobLogs);
	}

	for (const r of completedFailing) {
		const ex = await fetchRunExtract(r as RunBrief);
		if (ex) {
			runExtracts.push(ex);
			includedRunIds.push(r.id);
		}
	}
	if (opts.force) {
		for (const r of inProgress) {
			const ex = await fetchRunExtract(r as RunBrief);
			if (ex) {
				runExtracts.push(ex);
				includedRunIds.push(r.id);
			}
		}
	}

	// Curated excerpt for model summarization
	const curatedExcerpt = runExtracts
		.flatMap((rx) =>
			rx.jobs.map((jx) =>
				[
					`===== RUN ${rx.run.id} — ${rx.run.name ?? "Workflow"} — JOB ${jx.job.name} =====`,
					jx.excerpt,
				].join("\n"),
			),
		)
		.join("\n\n");

	// Summarize (unless skipped)
	let claudeSummary: string | undefined;
	if (!opts.skipClaude) {
		try {
			claudeSummary = await summarizeErrorExcerptText(curatedExcerpt, engine, {
				cwd: ctxPath,
				repo: { owner, repo },
				prNumber,
				sha,
				runIds: includedRunIds,
			});
		} catch {
			claudeSummary = undefined;
		}
	}

	// Build XML-marked markdown report
	const flags: GatherFlags = {
		force: !!opts.force,
		skipClaude: !!opts.skipClaude,
		claudeOnly: !!opts.claudeOnly,
	};
	const report = buildMarkdownXmlReport({
		owner,
		repo,
		branch: targetBranch,
		sha,
		sinceIso,
		prNumber,
		commentsSince,
		runExtracts,
		ghAstGrepForRun: (runId: number) =>
			[
				`sg -p "/\\\\b(ERROR|FAILED|XFAIL)\\\\b/" <(gh run view ${runId} --log) || true`,
				`# fallback:\nrg -n -i " (ERROR|FAILED|XFAIL) " <(gh run view ${runId} --log) || true`,
			].join("\n"),
		claudeSummary,
		flags,
	});

	// Decide output path
	let outDir = wtExists
		? path.join(wtPath, "docs", "tmp")
		: path.resolve(process.cwd());
	if (!(await pathExists(outDir))) {
		// Fallback to worktree root (or cwd)
		outDir = wtExists ? wtPath : path.resolve(process.cwd());
	} else {
		await ensureDir(outDir);
	}

	if (opts.out) {
		outDir = path.dirname(path.resolve(opts.out));
		await ensureDir(outDir);
	}
	const stamp = nowStampUTC();
	const fileName = opts.out
		? path.basename(opts.out)
		: buildReportFilename(repoBase, targetBranch, shortenSha(sha), stamp);
	const filePath = path.join(outDir, fileName);
	await writeFileAtomic(filePath, report.markdown);

	// Console summary
	const c = (k: keyof typeof ansi, s: string) => color(k, s);
	const totalErr = runExtracts.reduce((a, r) => a + r.totalCounts.error, 0);
	const totalFail = runExtracts.reduce((a, r) => a + r.totalCounts.failed, 0);
	const totalXf = runExtracts.reduce((a, r) => a + r.totalCounts.xfail, 0);
	const totalLines = runExtracts.reduce((a, r) => a + r.totalCounts.lines, 0);

	process.stdout.write(
		[
			`${c("bold", "AWT Gather Summary")}`,
			`  repo:        ${owner}/${repo}`,
			`  branch:      ${c("cyan", targetBranch)}  sha: ${shortenSha(sha)}`,
			`  PR:          ${prNumber ? c("yellow", `#${prNumber}`) : "(none)"}`,
			`  comments:    total recent=${totalRecentComments}, since last push=${commentsSince.length}`,
			...commentsSince
				.slice(0, 8)
				.map(
					(cmt) =>
						`    - @${cmt.author}: ${(cmt.body || "").split(/\r?\n/)[0]?.slice(0, 80) || ""}`,
				),
			`  runs:        ${runExtracts.length} included (${includedRunIds.map((id) => `#${id}`).join(", ") || "-"})`,
			`  captured:    ${c("red", `ERROR:${totalErr}`)}  ${c("red", `FAILED:${totalFail}`)}  ${c(
				"magenta",
				`XFAIL:${totalXf}`,
			)}  lines:${totalLines}`,
			`  sizes:       comments=${report.lengths.commentsSectionChars}  ci=${report.lengths.ciSectionChars}  claude=${report.lengths.claudeSectionChars}  total=${report.lengths.totalChars}`,
			`  output:      ${homePathDisplay(filePath)}`,
			"",
			...runExtracts.flatMap((rx) => {
				const header = `  run #${rx.run.id} ${rx.run.name ? `(${rx.run.name})` : ""} — ${rx.run.status}/${rx.run.conclusion ?? ""}`;
				const jobLines = rx.jobs.map(
					(jx) =>
						`    • ${jx.job.name}  ${c("red", `E:${jx.counts.error}`)} ${c("red", `F:${jx.counts.failed}`)} ${c(
							"magenta",
							`XF:${jx.counts.xfail}`,
						)}  lines:${jx.counts.lines} chars:${jx.counts.chars}`,
				);
				return [header, ...jobLines];
			}),
			"",
		].join("\n"),
	);
}

// safeRead moved to util.ts

function _formatAge(iso: string): string {
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

function _formatDelta(ms: number): string {
	if (ms <= 0) return "0m";
	const totalMin = Math.floor(ms / 60000);
	const days = Math.floor(totalMin / (60 * 24));
	const hours = Math.floor((totalMin % (60 * 24)) / 60);
	const mins = totalMin % 60;
	if (days > 0) return `${days}d${hours}h${mins}m`;
	if (hours > 0) return `${hours}h${mins}m`;
	return `${mins}m`;
}

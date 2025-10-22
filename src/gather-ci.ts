import * as path from "node:path";
import { repoRoot } from "./git.js";
import { Gh } from "./github.js";
import {
	buildMarkdownXmlReport,
	buildReportFilename,
	toRunExtract,
} from "./report.js";
import { resolveTarget } from "./resolve.js";
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

export interface GatherCiArgs {
	wt?: string;
	branch?: string;
	engine: Engine;
	force: boolean;
	skipClaude: boolean;
	claudeOnly: boolean;
	out?: string;
}

export async function runGatherCi(args: GatherCiArgs) {
	const root = await repoRoot();
	const cfgPath = path.join(root, ".awt", "config.jsonc");
	const cfg = (await readJsonc<WatchConfig>(cfgPath)) || {};
	const engine = cfg.engine || args.engine;

	const ghToken = await getGhToken();
	const gh = new Gh(ghToken || undefined);

	const target = await resolveTarget({
		explicitWt: args.wt || null,
		explicitBranch: args.branch || null,
		gh,
		cfg,
	});

	// Prompt
	const promptPath = cfg.promptPath
		? path.join(root, cfg.promptPath)
		: path.join(root, ".awt", "prompts", "debug.md");
	const _prompt = await safeRead(
		promptPath,
		"Please analyze the failures above and continue working to resolve them.",
	);

	// Fetch runs since last push
	const runsSince = await gh.listWorkflowRunsSince(
		{ owner: target.owner, repo: target.repo },
		target.remoteBranch!,
		target.sinceIso,
	);
	const failureLike = new Set(["failure", "timed_out", "cancelled"]);
	const inProgress = runsSince.filter((r) => r.status !== "completed");
	const completedFailing = runsSince.filter(
		(r) =>
			r.status === "completed" && r.conclusion && failureLike.has(r.conclusion),
	);

	if (inProgress.length && !args.force) {
		process.stderr.write(
			`${[
				`CI is still in progress for branch '${target.remoteBranch}' (since ${target.sinceIso}).`,
				`Pending runs: ${inProgress.map((r) => `#${r.id}`).join(", ") || "(none)"}`,
				`Re-run with --force to compile partial information now.`,
			].join("\n")}\n`,
		);
		process.exitCode = 2;
		return;
	}

	// Build run extracts (completed failing first, then forced in-progress)
	const runExtracts: RunExtract[] = [];
	const includedRunIds: number[] = [];

	async function fetchRunExtract(run: RunBrief): Promise<RunExtract | null> {
		const jobs = await gh.listJobsForRun(
			{ owner: target.owner, repo: target.repo },
			run.id,
		);
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
			if (args.force) {
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
				const raw = await gh.fetchJobLog(
					{ owner: target.owner, repo: target.repo },
					j.id,
				);
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
	if (args.force) {
		for (const r of inProgress) {
			const ex = await fetchRunExtract(r as RunBrief);
			if (ex) {
				runExtracts.push(ex);
				includedRunIds.push(r.id);
			}
		}
	}

	// Curated excerpt text for summarization
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

	// Summarize
	let claudeSummary: string | undefined;
	if (!args.skipClaude) {
		try {
			claudeSummary = await summarizeErrorExcerptText(curatedExcerpt, engine, {
				cwd: target.worktreePath,
				repo: { owner: target.owner, repo: target.repo },
				prNumber: target.prNumber,
				sha: target.headSha,
				runIds: includedRunIds,
			});
		} catch {
			claudeSummary = undefined;
		}
	}

	// Build XML-marked markdown report (compat)
	const flags: GatherFlags = {
		force: !!args.force,
		skipClaude: !!args.skipClaude,
		claudeOnly: !!args.claudeOnly,
	};
	const report = buildMarkdownXmlReport({
		owner: target.owner,
		repo: target.repo,
		branch: target.remoteBranch!,
		sha: target.headSha,
		sinceIso: target.sinceIso,
		prNumber: target.prNumber,
		commentsSince: [], // CI-only mode
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
	let outDir = target.worktreePath
		? path.join(target.worktreePath, "docs", "tmp")
		: path.resolve(process.cwd());
	if (!(await pathExists(outDir))) {
		outDir = target.worktreePath || path.resolve(process.cwd());
	} else {
		await ensureDir(outDir);
	}
	if (args.out) {
		outDir = path.dirname(path.resolve(args.out));
		await ensureDir(outDir);
	}

	const stamp = nowStampUTC();
	const fileName = args.out
		? path.basename(args.out)
		: buildReportFilename(
				path.basename(target.repoRoot),
				target.remoteBranch!,
				shortenSha(target.headSha),
				stamp,
			);
	const filePath = path.join(outDir, fileName);
	await writeFileAtomic(filePath, report.markdown);

	// Console summary
	const totalErr = runExtracts.reduce((a, r) => a + r.totalCounts.error, 0);
	const totalFail = runExtracts.reduce((a, r) => a + r.totalCounts.failed, 0);
	const totalXf = runExtracts.reduce((a, r) => a + r.totalCounts.xfail, 0);
	const totalLines = runExtracts.reduce((a, r) => a + r.totalCounts.lines, 0);
	process.stdout.write(
		[
			`AWT Gather CI Summary`,
			`  repo:        ${target.owner}/${target.repo}`,
			`  branch:      ${target.remoteBranch}  sha: ${shortenSha(target.headSha)}`,
			`  PR:          ${target.prNumber ? `#${target.prNumber}` : "(none)"}`,
			`  runs:        ${runExtracts.length} included (${
				includedRunIds.map((id) => `#${id}`).join(", ") || "-"
			})`,
			`  captured:    ERROR:${totalErr}  FAILED:${totalFail}  XFAIL:${totalXf}  lines:${totalLines}`,
			`  sizes:       ci=${report.lengths.ciSectionChars}  claude=${report.lengths.claudeSectionChars}  total=${report.lengths.totalChars}`,
			`  output:      ${homePathDisplay(filePath)}`,
			"",
		].join("\n"),
	);
}

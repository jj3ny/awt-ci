import * as path from "node:path";
import { gatherComments } from "./comments.js";
import { repoRoot } from "./git.js";
import { Gh } from "./github.js";
import { buildCommentReport } from "./report.comments.js";
import { buildReportFilename } from "./report.js";
import { resolveTarget } from "./resolve.js";
import type { WatchConfig } from "./types.js";
import {
	ensureDir,
	getGhToken,
	homePathDisplay,
	nowStampUTC,
	pathExists,
	readJsonc,
	shortenSha,
	writeFileAtomic,
} from "./util.js";

export interface GatherCommentsArgs {
	wt?: string;
	branch?: string;
	since?: string; // "auto" | ISO string
	max?: number; // cap total comments across threads
	fullThreads?: boolean; // include parents before since
	format?: "md" | "json" | "both";
	out?: string;
	authors?: string[];
	states?: ("APPROVED" | "CHANGES_REQUESTED" | "COMMENTED")[];
}

export async function runGatherComments(args: GatherCommentsArgs) {
	const root = await repoRoot();
	const cfgPath = path.join(root, ".awt", "config.jsonc");
	const cfg = (await readJsonc<WatchConfig>(cfgPath)) || {};

	const ghToken = await getGhToken();
	const gh = new Gh(ghToken || undefined);

	const target = await resolveTarget({
		explicitWt: args.wt || null,
		explicitBranch: args.branch || null,
		gh,
		cfg,
	});

	const sinceIso =
		(args.since && args.since !== "auto" ? args.since : target.sinceIso) ||
		target.sinceIso;

	const snapshot = await gatherComments({
		target,
		sinceIso,
		cap: args.max ?? cfg.commentsCap ?? 500,
		fullThreads: args.fullThreads ?? true,
		preferGraphQL: cfg.preferGraphQL ?? true,
		authors: args.authors,
		states: args.states,
		gh,
	});

	const report = buildCommentReport({
		snapshot,
		meta: {
			owner: target.owner,
			repo: target.repo,
			branch: target.remoteBranch!,
			sha: target.headSha,
		},
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
	const baseName = buildReportFilename(
		path.basename(target.repoRoot),
		target.remoteBranch!,
		shortenSha(target.headSha),
		stamp,
	).replace(/\.md$/, "");

	const wantMd = (args.format ?? "both") !== "json";
	const wantJson = (args.format ?? "both") !== "md";

	if (wantMd) {
		const mdPath = path.join(outDir, `${baseName}_comments.md`);
		await writeFileAtomic(mdPath, report.markdown);
		process.stdout.write(`Comments markdown: ${homePathDisplay(mdPath)}\n`);
	}
	if (wantJson) {
		const jsonPath = path.join(outDir, `${baseName}_comments.json`);
		await writeFileAtomic(jsonPath, JSON.stringify(report.json, null, 2));
		process.stdout.write(`Comments JSON:     ${homePathDisplay(jsonPath)}\n`);
	}

	process.stdout.write(
		`Threads: ${report.lengths.totalThreads}  Comments: ${report.lengths.totalComments}  Markdown chars: ${report.lengths.markdownChars}\n`,
	);
}

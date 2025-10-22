export type Engine = "claude" | "gemini";

export interface RepoRef {
	owner: string;
	repo: string;
}

export interface AwtState {
	last_push?: { sha: string; pushed_at: string };
	// Optional per-branch last push tracking
	last_push_by_branch?: Record<string, { sha: string; pushed_at: string }>;
	last_ci_seen_for_sha?: string;
	last_ci_conclusion?: string;

	last_comment_seen_at_for_sha?: Record<string, string>;
	last_consolidated_digest_for_sha?: Record<string, string>;
	last_comments_digest_for_sha?: Record<string, string>;
}

export interface WatchConfig {
	owner?: string;
	repo?: string;
	promptPath?: string;
	engine?: Engine;
	summarizePerJobKB?: number;
	summarizeTotalMB?: number;
	pollSecIdle?: number;
	pollSecPostPush?: number;
	idleSec?: number;
	eventMode?: boolean;
	maxRecentComments?: number;
	conflictHints?: "simple" | "simple+recent-base";
	worktreeSetupCommands?: string[];

	preferGraphQL?: boolean;
	commentsQuietSec?: number;
	commentsPollSec?: number;
	consolidatedPastePolicy?: "on_failure" | "always_on_settle";
	commentsCap?: number;
	emitCiJson?: boolean;
	emitCommentsJson?: boolean;
	deprecations?: boolean;
}

export interface FailureBundle {
	sha: string;
	prNumber: number;
	runs: { id: number; url: string; conclusion: string | null }[];
	jobs: { id: number; runId: number; name: string; html_url: string }[];
	logs: { jobId: number; runId: number; jobName: string; text: string }[];
}

// New types for curated run/job extracts

export interface RunBrief {
	id: number;
	url: string;
	status: string; // queued|in_progress|completed
	conclusion: string | null; // success|failure|cancelled|timed_out|null
	createdAt: string | null;
	name: string | null;
	headSha?: string | null;
}

export interface JobBrief {
	id: number;
	runId: number;
	name: string;
	html_url: string;
	conclusion: string | null;
	status?: string | null;
}

export interface ExtractCounts {
	error: number;
	failed: number;
	xfail: number;
	lines: number;
	chars: number;
}

export interface JobExtract {
	job: JobBrief;
	excerpt: string; // curated failure lines + optional summary block
	counts: ExtractCounts;
}

export interface RunExtract {
	run: RunBrief;
	jobs: JobExtract[];
	totalCounts: ExtractCounts;
}

export interface GatherFlags {
	force: boolean;
	skipClaude: boolean;
	claudeOnly: boolean;
}

export interface BuildReportInput {
	owner: string;
	repo: string;
	branch: string;
	sha: string;
	sinceIso: string;
	prNumber: number | null;
	commentsSince: {
		author: string;
		createdAt: string;
		body: string;
		url: string;
	}[];
	runExtracts: RunExtract[];
	ghAstGrepForRun: (runId: number) => string;
	claudeSummary?: string;
	flags: GatherFlags;
}

export interface BuildReportOutput {
	markdown: string;
	lengths: {
		commentsSectionChars: number;
		ciSectionChars: number;
		claudeSectionChars: number;
		totalChars: number;
	};
	perRunJobCounts: {
		runId: number;
		jobName: string;
		error: number;
		failed: number;
		xfail: number;
		lines: number;
		chars: number;
	}[];
}

export type CommentSource = "issue" | "review_line" | "review_summary";

export interface ReviewLineInfo {
	path: string;
	startLine?: number | null;
	line?: number | null;
	side?: "LEFT" | "RIGHT" | null;
	originalLine?: number | null;
	commitId?: string | null;
	inReplyToId?: string | null;
	threadId?: string | null;
}

export interface CommentItem {
	id: string;
	url: string;
	author: string;
	body: string;
	createdAt: string;
	updatedAt?: string | null;
	source: CommentSource;
	reviewState?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | null;
	reviewId?: string | null;
	line?: ReviewLineInfo | null;
	parentId?: string | null;
}

export interface CommentThread {
	threadId: string;
	path?: string | null;
	comments: CommentItem[];
	headCommit?: string | null;
	isResolved?: boolean | null;
}

export interface CommentSnapshot {
	prNumber: number;
	sinceIso: string;
	collectedAt: string;
	totalCount: number;
	threads: CommentThread[];
}

export interface BuildCommentReportInput {
	snapshot: CommentSnapshot;
	meta: { owner: string; repo: string; branch: string; sha: string };
}

export interface BuildCommentReportOutput {
	markdown: string;
	json: CommentSnapshot;
	lengths: {
		markdownChars: number;
		totalThreads: number;
		totalComments: number;
	};
}

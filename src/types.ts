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
}

export interface FailureBundle {
	sha: string;
	prNumber: number;
	runs: { id: number; url: string; conclusion: string | null }[];
	jobs: { id: number; runId: number; name: string; html_url: string }[];
	logs: { jobId: number; runId: number; jobName: string; text: string }[];
}

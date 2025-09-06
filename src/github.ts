import { Octokit } from "@octokit/rest";
import type { RepoRef } from "./types.js";

export class Gh {
	private octo: Octokit;
	constructor(token?: string) {
		this.octo = new Octokit(token ? { auth: token } : {});
	}

	async findOpenPrForBranch(
		ref: RepoRef,
		headOwner: string,
		branch: string,
	): Promise<number | null> {
		const head = `${headOwner}:${branch}`;
		const res = await this.octo.pulls.list({
			...ref,
			head,
			state: "open",
			per_page: 10,
		});
		const pr = res.data[0];
		return pr ? pr.number : null;
	}

	async getPrLite(
		ref: RepoRef,
		pr: number,
	): Promise<{
		mergeable_state: string | null;
		headSha: string;
		html_url: string;
	}> {
		const { data } = await this.octo.pulls.get({ ...ref, pull_number: pr });
		return {
			mergeable_state: data.mergeable_state ?? null,
			headSha: data.head.sha,
			html_url: data.html_url,
		};
	}

	async listCommentsSince(
		ref: RepoRef,
		pr: number,
		sinceIso: string,
		cap = 30,
	): Promise<
		{ author: string; createdAt: string; body: string; url: string }[]
	> {
		const items: {
			author: string;
			createdAt: string;
			body: string;
			url: string;
		}[] = [];
		// Issue comments
		try {
			const res = await this.octo.issues.listComments({
				...ref,
				issue_number: pr,
				per_page: 100,
				since: sinceIso,
			});
			for (const c of res.data) {
				items.push({
					author: c.user?.login || "unknown",
					createdAt: c.created_at || "",
					body: c.body || "",
					url: c.html_url || "",
				});
			}
		} catch {}
		// Review comments (code review line comments)
		try {
			const rc = await this.octo.pulls.listReviewComments({
				...ref,
				pull_number: pr,
				per_page: 100,
				since: sinceIso,
			});
			for (const c of rc.data) {
				items.push({
					author: c.user?.login || "unknown",
					createdAt: c.created_at || "",
					body: c.body || "",
					url: c.html_url || "",
				});
			}
		} catch {}
		// Review summaries
		try {
			const rv = await this.octo.pulls.listReviews({
				...ref,
				pull_number: pr,
				per_page: 100,
			});
			for (const r of rv.data) {
				const submitted = r.submitted_at || "";
				if (submitted && submitted > sinceIso) {
					items.push({
						author: r.user?.login || "unknown",
						createdAt: submitted,
						body: `[${r.state}]${r.body ? ` ${r.body}` : ""}`,
						url: (r as any).html_url || (r._links as any)?.html?.href || "",
					});
				}
			}
		} catch {}
		items.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
		return items.slice(0, cap);
	}

	async listCommentsRecent(
		ref: RepoRef,
		pr: number,
		cap = 100,
	): Promise<
		{ author: string; createdAt: string; body: string; url: string }[]
	> {
		const items: {
			author: string;
			createdAt: string;
			body: string;
			url: string;
		}[] = [];
		// Issue comments (recent)
		try {
			const res = await this.octo.issues.listComments({
				...ref,
				issue_number: pr,
				per_page: 100,
			});
			for (const c of res.data) {
				items.push({
					author: c.user?.login || "unknown",
					createdAt: c.created_at || "",
					body: c.body || "",
					url: c.html_url || "",
				});
			}
		} catch {}
		// Review comments
		try {
			const rc = await this.octo.pulls.listReviewComments({
				...ref,
				pull_number: pr,
				per_page: 100,
			});
			for (const c of rc.data) {
				items.push({
					author: c.user?.login || "unknown",
					createdAt: c.created_at || "",
					body: c.body || "",
					url: c.html_url || "",
				});
			}
		} catch {}
		// Reviews (summaries)
		try {
			const rv = await this.octo.pulls.listReviews({
				...ref,
				pull_number: pr,
				per_page: 100,
			});
			for (const r of rv.data) {
				const submitted = r.submitted_at || "";
				items.push({
					author: r.user?.login || "unknown",
					createdAt: submitted,
					body: `[${r.state}]${r.body ? ` ${r.body}` : ""}`,
					url: (r as any).html_url || (r._links as any)?.html?.href || "",
				});
			}
		} catch {}
		items.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
		return items.slice(-cap);
	}

	async latestCiForSha(
		ref: RepoRef,
		sha: string,
	): Promise<{
		conclusion: string | null;
		runs: {
			id: number;
			url: string;
			status: string;
			conclusion: string | null;
			createdAt: string | null;
		}[];
	}> {
		const runsRes = await this.octo.actions.listWorkflowRunsForRepo({
			...ref,
			per_page: 20,
			head_sha: sha,
		});
		const runs = runsRes.data.workflow_runs.map((r) => ({
			id: r.id,
			url: r.html_url || "",
			status: r.status || "queued",
			conclusion: r.conclusion,
			createdAt:
				(r as any).run_started_at || r.created_at || r.updated_at || null,
			name: (r as any).name || null,
		}));
		const failureLike = new Set(["failure", "timed_out", "cancelled"]);
		const allCompleted =
			runs.length > 0 && runs.every((r) => r.status === "completed");
		const anyFailed = runs.some(
			(r) =>
				r.status === "completed" &&
				r.conclusion &&
				failureLike.has(r.conclusion),
		);
		let conclusion: string | null = null;
		if (allCompleted) {
			conclusion = anyFailed
				? "failure"
				: runs.every((r) => r.conclusion === "success")
					? "success"
					: "neutral";
		}
		return { conclusion, runs };
	}

	async listJobsForRun(
		ref: RepoRef,
		runId: number,
	): Promise<
		{ id: number; name: string; html_url: string; conclusion: string | null }[]
	> {
		const { data } = await this.octo.actions.listJobsForWorkflowRun({
			...ref,
			run_id: runId,
			per_page: 100,
		});
		return data.jobs.map((j) => ({
			id: j.id,
			name: j.name,
			html_url: j.html_url || "",
			conclusion: j.conclusion || null,
		}));
	}

	async fetchJobLog(ref: RepoRef, jobId: number): Promise<string> {
		// GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs returns raw text (may be gzip-encoded)
		const res: any = await this.octo.request(
			"GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
			{ ...ref, job_id: jobId },
		);
		const enc = (
			res.headers?.["content-encoding"] ||
			res.headers?.["Content-Encoding"] ||
			""
		)
			.toString()
			.toLowerCase();
		const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
		if (enc.includes("gzip")) {
			const zlib = await import("node:zlib");
			return zlib.gunzipSync(buf).toString("utf8");
		}
		return buf.toString("utf8");
	}

	async prFiles(
		ref: RepoRef,
		pr: number,
		limit = 200,
	): Promise<
		{ filename: string; status: string; additions: number; changes: number }[]
	> {
		const { data } = await this.octo.pulls.listFiles({
			...ref,
			pull_number: pr,
			per_page: Math.min(limit, 300),
		});
		return data.map((f) => ({
			filename: f.filename,
			status: f.status as string,
			additions: f.additions ?? 0,
			changes: f.changes ?? 0,
		}));
	}

	async getCommitDate(ref: RepoRef, sha: string): Promise<string | null> {
		try {
			const { data } = await this.octo.repos.getCommit({ ...ref, ref: sha });
			return (data.commit?.author?.date ||
				data.commit?.committer?.date ||
				null) as string | null;
		} catch {
			return null;
		}
	}

	async findPrBySha(ref: RepoRef, sha: string): Promise<number | null> {
		try {
			const { data } =
				await this.octo.repos.listPullRequestsAssociatedWithCommit({
					...ref,
					commit_sha: sha,
				});
			return data[0]?.number ?? null;
		} catch {
			return null;
		}
	}
}

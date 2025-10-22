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
		try {
			const head = `${headOwner}:${branch}`;
			const { data } = await this.octo.pulls.list({
				...ref,
				head,
				state: "open",
				per_page: 10,
			});
			const [firstPr] = data;
			if (firstPr) return firstPr.number;
		} catch {}
		// Fallback: scan open PRs and match by head.ref
		try {
			const { data } = await this.octo.pulls.list({
				...ref,
				state: "open",
				per_page: 100,
				sort: "updated",
				direction: "desc",
			});
			const match = data.find((pull) => (pull.head?.ref || "") === branch);
			return match ? match.number : null;
		} catch {
			return null;
		}
	}

	async latestOpenPr(
		ref: RepoRef,
	): Promise<{ number: number; headRefName: string } | null> {
		const { data } = await this.octo.pulls.list({
			...ref,
			state: "open",
			per_page: 1,
			sort: "updated",
			direction: "desc",
		});
		const [pr] = data;
		if (!pr) return null;
		return { number: pr.number, headRefName: pr.head?.ref ?? "" };
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
					const htmlUrl =
						typeof r.html_url === "string" && r.html_url.length
							? r.html_url
							: typeof r._links?.html?.href === "string"
								? r._links.html.href
								: "";
					items.push({
						author: r.user?.login || "unknown",
						createdAt: submitted,
						body: `[${r.state}]${r.body ? ` ${r.body}` : ""}`,
						url: htmlUrl,
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
					url:
						typeof r.html_url === "string" && r.html_url.length
							? r.html_url
							: typeof r._links?.html?.href === "string"
								? r._links.html.href
								: "",
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
		const runs = runsRes.data.workflow_runs.map((run) => ({
			id: run.id,
			url: run.html_url ?? "",
			status: run.status ?? "queued",
			conclusion: run.conclusion ?? null,
			createdAt: run.run_started_at ?? run.created_at ?? run.updated_at ?? null,
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

	async headShaForBranch(ref: RepoRef, branch: string): Promise<string | null> {
		try {
			const runsRes = await this.octo.actions.listWorkflowRunsForRepo({
				...ref,
				per_page: 1,
				branch,
			});
			const run = runsRes.data.workflow_runs[0];
			return run?.head_sha ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Return the head_sha for the most recent failing run on a branch.
	 * Considers conclusions that indicate failure-like outcomes.
	 */
	async latestFailingShaForBranch(
		ref: RepoRef,
		branch: string,
		perPage = 50,
	): Promise<string | null> {
		try {
			const runsRes = await this.octo.actions.listWorkflowRunsForRepo({
				...ref,
				branch,
				per_page: Math.min(Math.max(perPage, 1), 100),
			});
			const failureLike = new Set(["failure", "timed_out", "cancelled"]);
			for (const run of runsRes.data.workflow_runs) {
				const status = (run.status || "").toString();
				const concl = (run.conclusion || "").toString();
				if (status === "completed" && failureLike.has(concl)) {
					return run.head_sha ?? null;
				}
			}
			return null;
		} catch {
			return null;
		}
	}

	async listJobsForRun(
		ref: RepoRef,
		runId: number,
	): Promise<
		{
			id: number;
			name: string;
			html_url: string;
			conclusion: string | null;
			status: string | null;
		}[]
	> {
		const { data } = await this.octo.actions.listJobsForWorkflowRun({
			...ref,
			run_id: runId,
			per_page: 100,
		});
		return data.jobs.map((job) => ({
			id: job.id,
			name: job.name,
			html_url: job.html_url ?? "",
			conclusion: job.conclusion ?? null,
			status: job.status ?? null,
		}));
	}

	async getBranchSha(ref: RepoRef, branch: string): Promise<string | null> {
		try {
			const { data } = await this.octo.repos.getBranch({
				...ref,
				branch,
			});
			return data.commit?.sha ?? null;
		} catch {
			try {
				const { data } = await this.octo.git.getRef({
					...ref,
					ref: `heads/${branch}`,
				});
				return data.object?.sha ?? null;
			} catch {
				return null;
			}
		}
	}

	async fetchJobLog(ref: RepoRef, jobId: number): Promise<string> {
		// GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs returns raw text (may be gzip-encoded)
		const res = await this.octo.request(
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
		const rawData = res.data;
		let buf: Buffer;
		if (Buffer.isBuffer(rawData)) {
			buf = rawData;
		} else if (typeof rawData === "string") {
			buf = Buffer.from(rawData, "utf8");
		} else if (rawData instanceof ArrayBuffer) {
			buf = Buffer.from(rawData);
		} else if (ArrayBuffer.isView(rawData)) {
			const view = rawData as ArrayBufferView;
			buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
		} else {
			buf = Buffer.from(String(rawData ?? ""), "utf8");
		}
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

	async listWorkflowRunsSince(
		ref: RepoRef,
		branch: string,
		sinceIso: string,
		perPage = 100,
	): Promise<
		{
			id: number;
			url: string;
			status: string;
			conclusion: string | null;
			createdAt: string | null;
			name: string | null;
			headSha: string | null;
		}[]
	> {
		try {
			const res = await this.octo.actions.listWorkflowRunsForRepo({
				...ref,
				branch,
				per_page: Math.min(100, Math.max(1, perPage)),
				// GitHub supports 'created' filter with qualifiers like '>=YYYY-MM-DD'
				created: `>=${sinceIso}`,
			});
			return res.data.workflow_runs.map((run) => ({
				id: run.id,
				url: run.html_url ?? "",
				status: run.status ?? "queued",
				conclusion: run.conclusion ?? null,
				createdAt:
					run.run_started_at ?? run.created_at ?? run.updated_at ?? null,
				name: run.name ?? null,
				headSha: run.head_sha ?? null,
			}));
		} catch {
			return [];
		}
	}
}

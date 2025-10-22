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

	/**
	 * Return branch names on GitHub that contain the given head commit.
	 */
	async branchesForCommit(ref: RepoRef, sha: string): Promise<string[] | null> {
		try {
			// Octokit endpoint: repos.listBranchesForHeadCommit
			const { data } = await this.octo.repos.listBranchesForHeadCommit({
				...ref,
				commit_sha: sha,
				per_page: 100,
			});
			return data.map((b) => b.name).filter(Boolean);
		} catch {
			return null;
		}
	}

	/**
	 * Comprehensive comment fetch (REST): issue comments, review line comments, and review summaries.
	 * Since GitHub APIs vary in `since` support, we filter client-side for review paths.
	 */
	async listCommentsRest(
		ref: RepoRef,
		pr: number,
		sinceIso: string,
		cap = 1000,
		fullThreads = true,
	): Promise<{
		issueComments: {
			id: number;
			body: string;
			created_at: string;
			updated_at?: string;
			html_url: string;
			user: string;
		}[];
		reviewComments: {
			id: number;
			body: string;
			created_at: string;
			updated_at?: string;
			html_url: string;
			user: string;
			path: string;
			line?: number;
			start_line?: number;
			original_line?: number;
			side?: string | null;
			commit_id?: string;
			in_reply_to_id?: number | null;
			thread_id?: number | null;
		}[];
		reviews: {
			id: number;
			body: string;
			state: string;
			html_url: string;
			submitted_at?: string;
			created_at?: string;
			updated_at?: string;
			user: string;
		}[];
	}> {
		const perPage = 100;

		// Issue comments (since supported)
		const issueComments: {
			id: number;
			body: string;
			created_at: string;
			updated_at?: string;
			html_url: string;
			user: string;
		}[] = [];
		try {
			let page = 1;
			while (true) {
				const { data } = await this.octo.issues.listComments({
					...ref,
					issue_number: pr,
					per_page: perPage,
					page,
					since: sinceIso,
				});
				for (const c of data) {
					issueComments.push({
						id: c.id,
						body: c.body || "",
						created_at: c.created_at || "",
						updated_at: c.updated_at || undefined,
						html_url: c.html_url || "",
						user: c.user?.login || "unknown",
					});
				}
				if (data.length < perPage || issueComments.length >= cap) break;
				page += 1;
			}
		} catch {
			// ignore
		}

		// Review comments (no reliable since in all modes; paginate + filter)
		const reviewComments: {
			id: number;
			body: string;
			created_at: string;
			updated_at?: string;
			html_url: string;
			user: string;
			path: string;
			line?: number;
			start_line?: number;
			original_line?: number;
			side?: string | null;
			commit_id?: string;
			in_reply_to_id?: number | null;
			thread_id?: number | null;
		}[] = [];
		try {
			let page = 1;
			while (true) {
				const { data } = await this.octo.pulls.listReviewComments({
					...ref,
					pull_number: pr,
					per_page: perPage,
					page,
				});
				for (const c of data) {
					const created = c.created_at || "";
					if (!created || created >= sinceIso) {
						reviewComments.push({
							id: c.id,
							body: c.body || "",
							created_at: created,
							updated_at: c.updated_at || undefined,
							html_url: c.html_url || "",
							user: c.user?.login || "unknown",
							path: c.path || "",
							line: (c as any).line,
							start_line: (c as any).start_line,
							original_line: (c as any).original_line,
							side: (c as any).side || null,
							commit_id: (c as any).commit_id,
							in_reply_to_id: (c as any).in_reply_to_id ?? null,
							thread_id: (c as any).pull_request_review_id ?? null,
						});
					}
				}
				if (data.length < perPage || reviewComments.length >= cap) break;
				page += 1;
			}
			// If fullThreads: backfill parents for replies (best-effort, bounded)
			if (fullThreads) {
				const parentsToFetch = Array.from(
					new Set(
						reviewComments
							.map((c) => c.in_reply_to_id)
							.filter((v): v is number => !!v),
					),
				);
				for (const pid of parentsToFetch.slice(0, 200)) {
					try {
						const { data: pc } = await this.octo.pulls.getReviewComment({
							...ref,
							comment_id: pid,
						});
						if (!reviewComments.some((c) => c.id === pc.id)) {
							reviewComments.push({
								id: pc.id,
								body: pc.body || "",
								created_at: pc.created_at || "",
								updated_at: pc.updated_at || undefined,
								html_url: pc.html_url || "",
								user: pc.user?.login || "unknown",
								path: pc.path || "",
								line: (pc as any).line,
								start_line: (pc as any).start_line,
								original_line: (pc as any).original_line,
								side: (pc as any).side || null,
								commit_id: (pc as any).commit_id,
								in_reply_to_id: (pc as any).in_reply_to_id ?? null,
								thread_id: (pc as any).pull_request_review_id ?? null,
							});
						}
					} catch {
						// ignore
					}
				}
			}
		} catch {
			// ignore
		}

		// Review summaries (filter client-side)
		const reviews: {
			id: number;
			body: string;
			state: string;
			html_url: string;
			submitted_at?: string;
			created_at?: string;
			updated_at?: string;
			user: string;
		}[] = [];
		try {
			let page = 1;
			while (true) {
				const { data } = await this.octo.pulls.listReviews({
					...ref,
					pull_number: pr,
					per_page: perPage,
					page,
				});
				for (const r of data) {
					const submitted =
						(r.submitted_at as string | undefined) ||
						((r as any).created_at as string | undefined) ||
						((r as any).updated_at as string | undefined) ||
						"";
					if (!submitted || submitted >= sinceIso) {
						reviews.push({
							id: r.id,
							body: r.body || "",
							state: r.state || "COMMENTED",
							html_url:
								typeof (r as any).html_url === "string" &&
								(r as any).html_url.length
									? ((r as any).html_url as string)
									: typeof (r as any)._links?.html?.href === "string"
										? ((r as any)._links.html.href as string)
										: "",
							submitted_at: r.submitted_at || undefined,
							created_at: (r as any).created_at || undefined,
							updated_at: (r as any).updated_at || undefined,
							user: r.user?.login || "unknown",
						});
					}
				}
				if (data.length < perPage || reviews.length >= cap) break;
				page += 1;
			}
		} catch {
			// ignore
		}

		return { issueComments, reviewComments, reviews };
	}
}

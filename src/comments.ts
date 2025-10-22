import type { Gh } from "./github.js";
import type { Target } from "./resolve.js";
import type {
	CommentItem,
	CommentSnapshot,
	CommentThread,
	ReviewLineInfo,
} from "./types.js";

export interface GatherCommentsOptions {
	target: Target;
	sinceIso: string;
	cap: number;
	fullThreads: boolean;
	preferGraphQL: boolean; // reserved for future GraphQL path; REST used today
	authors?: string[];
	states?: ("APPROVED" | "CHANGES_REQUESTED" | "COMMENTED")[];
	gh: Gh;
}

export async function gatherComments(
	opts: GatherCommentsOptions,
): Promise<CommentSnapshot> {
	const ref = { owner: opts.target.owner, repo: opts.target.repo };
	const gh = opts.gh;
	// Use REST path for now
	const { issueComments, reviewComments, reviews } = await gh.listCommentsRest(
		ref,
		opts.target.prNumber!,
		opts.sinceIso,
		opts.cap * 2,
		opts.fullThreads,
	);

	// Convert to unified items
	const items: CommentItem[] = [];

	for (const c of issueComments) {
		items.push({
			id: String(c.id),
			url: c.html_url || "",
			author: c.user || "unknown",
			body: c.body || "",
			createdAt: c.created_at,
			updatedAt: c.updated_at ?? null,
			source: "issue",
		});
	}

	// Build threads for review line comments
	const byThread = new Map<string, CommentThread>();
	for (const rc of reviewComments) {
		const info: ReviewLineInfo = {
			path: rc.path,
			startLine: rc.start_line ?? null,
			line: rc.line ?? null,
			side: (rc.side as any) || null,
			originalLine: rc.original_line ?? null,
			commitId: rc.commit_id ?? null,
			inReplyToId: rc.in_reply_to_id ? String(rc.in_reply_to_id) : null,
			threadId: rc.thread_id
				? String(rc.thread_id)
				: rc.in_reply_to_id
					? String(rc.in_reply_to_id)
					: `${rc.path}:${rc.commit_id || ""}`,
		};
		const threadId = info.threadId || `${rc.path}:${rc.commit_id || ""}`;
		if (!byThread.has(threadId)) {
			byThread.set(threadId, {
				threadId,
				path: rc.path || null,
				comments: [],
				headCommit: rc.commit_id || null,
				isResolved: null,
			});
		}
		const item: CommentItem = {
			id: String(rc.id),
			url: rc.html_url || "",
			author: rc.user || "unknown",
			body: rc.body || "",
			createdAt: rc.created_at,
			updatedAt: rc.updated_at ?? null,
			source: "review_line",
			line: info,
			parentId: info.inReplyToId || null,
		};
		byThread.get(threadId)?.comments.push(item);
	}

	// Review summaries (per-review, not per-line)
	for (const r of reviews) {
		items.push({
			id: String(r.id),
			url: r.html_url || "",
			author: r.user || "unknown",
			body: r.body || "",
			createdAt:
				r.submitted_at || r.created_at || r.updated_at || r.created_at || "",
			updatedAt: r.updated_at ?? null,
			source: "review_summary",
			reviewState: r.state as any,
			reviewId: String(r.id),
		});
	}

	// Apply author/state filters
	const authorSet = opts.authors?.length
		? new Set(opts.authors.map((a) => a.toLowerCase()))
		: null;
	const stateSet = opts.states?.length ? new Set(opts.states) : null;

	function keepItem(i: CommentItem): boolean {
		if (authorSet && !authorSet.has(i.author.toLowerCase())) return false;
		if (
			stateSet &&
			i.source === "review_summary" &&
			i.reviewState &&
			!stateSet.has(i.reviewState)
		)
			return false;
		return true;
	}

	// Build threads list
	const threads: CommentThread[] = Array.from(byThread.values())
		.map((t) => {
			// chronological by createdAt
			t.comments.sort((a, b) =>
				(a.createdAt || "").localeCompare(b.createdAt || ""),
			);
			// filter items
			t.comments = t.comments.filter(keepItem);
			return t;
		})
		// drop empty after filters
		.filter((t) => t.comments.length > 0);

	// Non-threaded items (issue + review summaries) → each as its own "thread"
	const singletons: CommentThread[] = items
		.filter((i) => i.source !== "review_line")
		.filter(keepItem)
		.map((i) => ({
			threadId: `${i.source}:${i.id}`,
			path: null,
			comments: [i],
			headCommit: null,
			isResolved: null,
		}));

	const allThreads = [...threads, ...singletons];

	// Order threads by most recent comment
	allThreads.sort((a, b) => {
		const la = a.comments[a.comments.length - 1]?.createdAt || "";
		const lb = b.comments[b.comments.length - 1]?.createdAt || "";
		return la.localeCompare(lb);
	});

	// Enforce cap by dropping oldest full threads
	if (opts.cap > 0) {
		// compute total comments
		let total = 0;
		for (const t of allThreads) total += t.comments.length;
		if (total > opts.cap) {
			// Drop oldest threads first
			while (total > opts.cap && allThreads.length > 0) {
				const drop = allThreads.shift()!;
				total -= drop.comments.length;
			}
		}
	}

	const totalCount = allThreads.reduce((n, t) => n + t.comments.length, 0);
	const collectedAt = new Date().toISOString();

	const snapshot: CommentSnapshot = {
		prNumber: opts.target.prNumber || 0,
		sinceIso: opts.sinceIso,
		collectedAt,
		totalCount,
		threads: allThreads,
	};
	return snapshot;
}

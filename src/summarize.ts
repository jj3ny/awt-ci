import type { Engine, FailureBundle, RepoRef } from "./types.js";

// Optional Gemini fallback
let GoogleGenerativeAI: any = null;
try {
	({ GoogleGenerativeAI } = await import("@google/generative-ai"));
} catch {}

// Claude Code SDK summarizer with fallback to heuristic
export async function summarizeFailures(
	bundle: FailureBundle,
	engine: Engine,
	opts: { cwd: string; repo: RepoRef },
): Promise<string> {
	const prompt = buildClaudePrompt(bundle, opts.repo);
	try {
		// Ensure subscription-based auth (Claude Code runtime) and avoid API billing
		delete (process.env as any).ANTHROPIC_API_KEY;
		delete (process.env as any).CLAUDE_API_KEY;
		delete (process.env as any).ANTHROPIC_AUTH_TOKEN;
		delete (process.env as any).ANTHROPIC_BASE_URL;
		delete (process.env as any).ANTHROPIC_API_URL;
		const { query } = await import("@anthropic-ai/claude-code");
		const primaryModel = process.env.AWT_CLAUDE_MODEL || "claude-sonnet-4-0";
		const fallbackModel = process.env.AWT_CLAUDE_FALLBACK || "claude-opus-4-1";

		const summary = await runClaudeQuery(query, prompt, opts.cwd, primaryModel);
		if (summary) return summary;
		const summary2 = await runClaudeQuery(
			query,
			prompt,
			opts.cwd,
			fallbackModel,
		);
		if (summary2) return summary2;
	} catch (_e) {
		// fall through to heuristic
	}
	// Try Gemini if preferred or available
	if (engine === "gemini" || process.env.GOOGLE_API_KEY) {
		const text = buildGeminiPrompt(bundle, opts.repo);
		const g = await runGemini(text);
		if (g) return g;
	}
	return heuristicSummary(bundle, opts.repo);
}

function buildClaudePrompt(bundle: FailureBundle, repo: RepoRef): string {
	const header: string[] = [];
	header.push(
		`You are assisting as a senior engineer triaging CI failures for ${repo.owner}/${repo.repo}.`,
	);
	if (bundle.prNumber && bundle.prNumber > 0) {
		header.push(
			`Produce a concise, actionable report for PR #${bundle.prNumber} (SHA ${bundle.sha.slice(0, 7)}).`,
		);
	} else {
		header.push(
			`Produce a concise, actionable report for branch SHA ${bundle.sha.slice(0, 7)}.`,
		);
	}
	header.push(
		`For each failed job: (1) name the failing tests/files with file::line if visible, (2) include key quoted log lines, (3) likely root cause, (4) minimal next actions, (5) exact gh commands to inspect details.`,
	);
	header.push(
		`Also include suggested ast-grep queries when relevant to pinpoint code patterns causing failures.`,
	);
	header.push(
		`You may run read-only commands (git/gh/cat/grep/rg) to fetch additional context if helpful.`,
	);
	header.push(`Prefer precise references and keep commands copy-pasteable.`);

	const runs = bundle.runs
		.map((r) => `- run ${r.id}: ${r.url} (${r.conclusion || "?"})`)
		.join("\n");

	const logs: string[] = [];
	for (const l of bundle.logs) {
		logs.push(
			`\n===== JOB ${l.jobName} (run ${l.runId}, job ${l.jobId}) =====\n`,
		);
		logs.push(l.text);
	}

	const ghHints = bundle.runs
		.map((r) => `gh run view ${r.id} --log | less`)
		.join("\n");

	return [
		header.join("\n"),
		"\nCI runs:",
		runs,
		`\nIf needed, retrieve full logs locally with:\n${ghHints}`,
		"\nLogs (tail, truncated):",
		logs.join("\n"),
	].join("\n");
}

function buildGeminiPrompt(bundle: FailureBundle, repo: RepoRef): string {
	// Use a text-only prompt containing the same info
	const intro = `You are assisting as a senior engineer triaging CI failures for ${repo.owner}/${repo.repo}. For each failed job, list failing tests/files (with file::line where visible), include key quoted log lines, likely root cause, minimal next actions, and exact gh commands to inspect details. Include suggested ast-grep queries where helpful.`;
	const runs = bundle.runs
		.map((r) => `- run ${r.id}: ${r.url} (${r.conclusion || "?"})`)
		.join("\n");
	const logs: string[] = [];
	for (const l of bundle.logs) {
		logs.push(
			`\n===== JOB ${l.jobName} (run ${l.runId}, job ${l.jobId}) =====\n`,
		);
		logs.push(l.text);
	}
	const hints = bundle.runs
		.map((r) => `gh run view ${r.id} --log | less`)
		.join("\n");
	return [
		intro,
		"\nCI runs:",
		runs,
		"\nCommands:",
		hints,
		"\nLogs:",
		logs.join("\n"),
	].join("\n");
}

async function runGemini(text: string): Promise<string | null> {
	try {
		if (!GoogleGenerativeAI) return null;
		const key = process.env.GOOGLE_API_KEY;
		if (!key) return null;
		const genai = new GoogleGenerativeAI(key);
		const model = process.env.AWT_GEMINI_MODEL || "gemini-2.5-flash-lite";
		const res = await genai.getGenerativeModel({ model }).generateContent(text);
		const out =
			(res as any).response?.text?.() ||
			(res as any).response?.candidates?.[0]?.content?.parts
				?.map((p: any) => p.text)
				.join("\n");
		return typeof out === "string" && out.trim().length ? out.trim() : null;
	} catch {
		return null;
	}
}

async function runClaudeQuery(
	queryFn: any,
	prompt: string,
	cwd: string,
	model: string,
): Promise<string | null> {
	const messages: any[] = [];
	for await (const message of queryFn({
		prompt,
		options: {
			cwd,
			model,
			maxTurns: 3,
			allowedTools: ["Bash", "Read", "Grep", "WebSearch"],
			canUseTool: async (toolName: string, input: any) => {
				if (toolName === "Bash") {
					const cmd = String(input?.command || "");
					if (/\b(rm|mv|chmod|chown|truncate|mkfs|dd|kill)\b/.test(cmd)) {
						return {
							behavior: "deny",
							message: "Dangerous commands are not allowed",
						};
					}
					if (
						/[>]|\btee\b|\binstall\b|\bapt\b|\byum\b|\bpip\b|\bnpm\b|\byarn\b/.test(
							cmd,
						)
					) {
						return {
							behavior: "deny",
							message: "Write operations are not allowed",
						};
					}
					// Allow read-only git/gh and typical inspection commands
					if (
						/^(git|gh|cat|grep|rg|sed|awk|less|head|tail|find|ls|printf|echo)\b/.test(
							cmd,
						)
					) {
						return { behavior: "allow", updatedInput: input };
					}
					return { behavior: "allow", updatedInput: input };
				}
				return { behavior: "allow", updatedInput: input };
			},
			appendSystemPrompt:
				"Be terse and highly technical. Always include exact commands and key quoted log lines.",
		},
	})) {
		messages.push(message);
	}
	const result = messages.find(
		(m: any) => m.type === "result" && m.subtype === "success",
	);
	return result?.result || null;
}

function heuristicSummary(bundle: FailureBundle, repo: RepoRef): string {
	const out: string[] = [];
	if (bundle.prNumber && bundle.prNumber > 0) {
		out.push(
			`Found CI failures for ${repo.owner}/${repo.repo} PR #${bundle.prNumber} on ${bundle.sha.slice(0, 7)}`,
		);
	} else {
		out.push(
			`Found CI failures for ${repo.owner}/${repo.repo} branch SHA ${bundle.sha.slice(0, 7)}`,
		);
	}
	if (bundle.runs?.length) {
		out.push("Runs:");
		out.push(...bundle.runs.map((r) => `- ${r.url} (${r.conclusion || "?"})`));
	}
	for (const l of bundle.logs) {
		out.push(`\n--- Job ${l.jobName} (run ${l.runId}) ---`);
		const interesting = l.text
			.split(/\n/)
			.filter((ln) =>
				/FAIL|FAILED|ERROR|AssertionError|\b(?:test|spec)\b|\bError:/.test(ln),
			)
			.slice(-50);
		if (interesting.length) {
			out.push("Key lines:");
			out.push(...interesting);
		} else {
			out.push("(No obvious failure lines found; use gh run view <id> --log)");
		}
	}
	out.push(
		"\nSuggested commands:\n" +
			bundle.runs.map((r) => `gh run view ${r.id} --log | less`).join("\n"),
	);
	return out.join("\n");
}

export async function buildAgentPayload(args: {
	prNumber: number;
	sha: string;
	failureSummary: string;
	comments: { author: string; createdAt: string; body: string; url: string }[];
	debugPrompt: string;
	runs: { url: string; conclusion: string | null }[];
		summaryEngine?: string;
		logs?: { jobId: number; runId: number; jobName: string; text: string }[];
	conflictFiles?: string[];
	pushedAtIso?: string;
}): Promise<{ sentinel: string; text: string }> {
	const sentinel =
		args.prNumber && args.prNumber > 0
			? `AWT-PR-${args.prNumber}-${args.sha.slice(0, 7)}`
			: `AWT-BRANCH-${args.sha.slice(0, 7)}`;
	const lines: string[] = [];
	if (args.prNumber && args.prNumber > 0) {
		lines.push(
			`# CI failed for PR #${args.prNumber} on ${args.sha.slice(0, 7)}`,
		);
	} else {
		lines.push(`# CI failed for branch SHA ${args.sha.slice(0, 7)}`);
	}
	if (args.runs?.length)
		lines.push(
			`Runs: ${args.runs.map((r) => `${r.url} (${r.conclusion || "?"})`).join(", ")}`,
		);
	if (args.conflictFiles?.length) {
		lines.push("\nMerge conflicts detected. Suggested focus files:");
		for (const f of args.conflictFiles) lines.push(`- ${f}`);
		lines.push(
			"\nPlease rebase on main: git fetch origin && git rebase origin/main",
		);
	}
	lines.push("\n## Summary of Failures");
	lines.push(args.failureSummary);
		lines.push("</ci-context>");
	if (args.prNumber && args.prNumber > 0 && args.comments?.length) {
		lines.push(`\n## Comments since ${args.pushedAtIso || "last push"}`);
		for (const c of args.comments)
			lines.push(`- @${c.author} (${c.createdAt}): ${c.body} — ${c.url}`);
	}
	if (args.logs && args.logs.length) {
			lines.push("\n## Raw Logs (truncated)");
			lines.push("<ci-logs>");
			for (const l of args.logs) {
				lines.push(`\n--- Job ${l.jobName} (run ${l.runId}, job ${l.jobId}) ---`);
				lines.push("<pre>");
				lines.push(l.text);
				lines.push("</pre>");
			}
			lines.push("</ci-logs>");
		}
		lines.push(`\n## Next actions\n${args.debugPrompt}`);
	lines.push(`\n<sentinel:${sentinel}>`);
	return { sentinel, text: lines.join("\n") };
}

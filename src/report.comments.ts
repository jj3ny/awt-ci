import { escapeXmlAttr } from "./report.js";
import type {
	BuildCommentReportInput,
	BuildCommentReportOutput,
} from "./types.js";

export function buildCommentReport(
	input: BuildCommentReportInput,
): BuildCommentReportOutput {
	const { snapshot, meta } = input;
	const lines: string[] = [];

	lines.push(`# PR Comments Detailed`);
	lines.push(
		`Repo: **${meta.owner}/${meta.repo}**  |  Branch: **${meta.branch}**  |  SHA: **${meta.sha.slice(0, 7)}**  |  Since: **${snapshot.sinceIso}**`,
	);
	lines.push("");

	lines.push(
		`<pr-comments-detailed pr="${snapshot.prNumber}" since="${escapeXmlAttr(snapshot.sinceIso)}">`,
	);

	for (const t of snapshot.threads) {
		lines.push(
			`<thread id="${escapeXmlAttr(t.threadId)}"${t.path ? ` path="${escapeXmlAttr(t.path)}"` : ""}${t.headCommit ? ` headCommit="${escapeXmlAttr(t.headCommit)}"` : ""}${
				typeof t.isResolved === "boolean"
					? ` resolved="${String(t.isResolved)}"`
					: ""
			}>`,
		);
		for (const c of t.comments) {
			lines.push(
				`<comment id="${escapeXmlAttr(c.id)}" author="${escapeXmlAttr(c.author)}" createdAt="${escapeXmlAttr(
					c.createdAt,
				)}" source="${c.source}" url="${escapeXmlAttr(c.url)}"${
					c.reviewState ? ` reviewState="${c.reviewState}"` : ""
				}${c.line?.path ? ` path="${escapeXmlAttr(c.line.path)}"` : ""}${
					c.line?.line ? ` line="${c.line.line}"` : ""
				}${c.parentId ? ` parent="${escapeXmlAttr(c.parentId)}"` : ""}>`,
			);
			lines.push("<pre>");
			lines.push(c.body || "");
			lines.push("</pre>");
			lines.push("</comment>");
		}
		lines.push("</thread>");
	}
	lines.push("</pr-comments-detailed>");
	lines.push("");

	const out: BuildCommentReportOutput = {
		markdown: lines.join("\n"),
		json: snapshot,
		lengths: {
			markdownChars: lines.join("\n").length,
			totalThreads: snapshot.threads.length,
			totalComments: snapshot.totalCount,
		},
	};
	return out;
}

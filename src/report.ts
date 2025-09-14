import * as path from "node:path";
import {
    BuildReportInput,
    BuildReportOutput,
    ExtractCounts,
    JobBrief,
    JobExtract,
    RunBrief,
    RunExtract,
} from "./types.js";
import { sanitizeName } from "./util.js";

const MAX_LINE_CHARS = 600;
const MAX_JOB_EXCERPT_CHARS = 12000; // per job excerpt
const TRIM_SKIPPED_THRESHOLD = 15000;

const RE_ERROR = /(^|[ \t])ERROR([ \t]|$)/;
const RE_FAILED = /(^|[ \t])FAILED([ \t]|$)/;
const RE_XFAIL = /(^|[ \t])XFAIL([ \t]|$)/;

const RE_SKIPPED = /\bSKIPPED\b/;
const SHORT_SUMMARY_HEADER =
    "=========================== short test summary info ============================";

function truncateLine(s: string): string {
    if (s.length <= MAX_LINE_CHARS) return s;
    const head = s.slice(0, MAX_LINE_CHARS);
    return `${head} … [trimmed]`;
}

function truncateMiddle(s: string, max: number): string {
    if (s.length <= max) return s;
    const half = Math.max(1, Math.floor((max - 32) / 2));
    const head = s.slice(0, half);
    const tail = s.slice(-half);
    return `${head}\n… [truncated ${s.length - max} chars] …\n${tail}`;
}

function countInteresting(line: string): { err: number; fail: number; xfail: number } {
    let err = 0,
        fail = 0,
        xfail = 0;
    if (RE_ERROR.test(line)) err = 1;
    if (RE_FAILED.test(line)) fail = 1;
    if (RE_XFAIL.test(line)) xfail = 1;
    return { err, fail, xfail };
}

function isInterestingLine(line: string): boolean {
    return RE_ERROR.test(line) || RE_FAILED.test(line) || RE_XFAIL.test(line);
}

function extractShortSummaryBlock(text: string): string | null {
    const idx = text.indexOf(SHORT_SUMMARY_HEADER);
    if (idx < 0) return null;
    // Take from header to the end of text; trimming will be applied later.
    const block = text.slice(idx);
    return block;
}

function curateJobExcerpt(raw: string): { excerpt: string; counts: ExtractCounts } {
    const lines = raw.split(/\r?\n/);

    const kept: string[] = [];
    let err = 0,
        fail = 0,
        xfail = 0;

    for (const ln of lines) {
        if (!isInterestingLine(ln)) continue;
        const t = truncateLine(ln);
        const c = countInteresting(t);
        err += c.err;
        fail += c.fail;
        xfail += c.xfail;
        kept.push(t);
    }

    // Attach short summary block if present
    const summary = extractShortSummaryBlock(raw);
    if (summary) {
        kept.push(""); // spacer
        kept.push(SHORT_SUMMARY_HEADER);
        const summaryLines = summary.split(/\r?\n/).slice(1); // skip header reprint
        for (const ln of summaryLines) {
            kept.push(truncateLine(ln));
        }
    }

    let excerpt = kept.join("\n");
    // If extremely large, prefer dropping SKIPPED lines first
    if (excerpt.length > TRIM_SKIPPED_THRESHOLD) {
        const noSkipped = excerpt
            .split(/\r?\n/)
            .filter((ln) => !RE_SKIPPED.test(ln))
            .join("\n");
        excerpt = noSkipped.length > 0 ? noSkipped : excerpt;
    }

    // Enforce per-job middle truncation
    excerpt = truncateMiddle(excerpt, MAX_JOB_EXCERPT_CHARS);

    // Recompute line/char counts after truncation
    const lnCount = excerpt.length ? excerpt.split(/\r?\n/).length : 0;
    const counts: ExtractCounts = {
        error: err,
        failed: fail,
        xfail,
        lines: lnCount,
        chars: excerpt.length,
    };
    return { excerpt, counts };
}

export function toRunExtract(
    run: RunBrief,
    jobs: JobBrief[],
    jobLogs: Record<number, string>,
): RunExtract {
    const jobExtracts: JobExtract[] = [];
    let totalErr = 0,
        totalFail = 0,
        totalXf = 0,
        totalLines = 0,
        totalChars = 0;

    for (const jb of jobs) {
        const raw = jobLogs[jb.id] || "";
        const { excerpt, counts } = curateJobExcerpt(raw);
        jobExtracts.push({ job: jb, excerpt, counts });
        totalErr += counts.error;
        totalFail += counts.failed;
        totalXf += counts.xfail;
        totalLines += counts.lines;
        totalChars += counts.chars;
    }

    const totalCounts: ExtractCounts = {
        error: totalErr,
        failed: totalFail,
        xfail: totalXf,
        lines: totalLines,
        chars: totalChars,
    };

    return { run, jobs: jobExtracts, totalCounts };
}

export function buildReportFilename(
    repoBase: string,
    branch: string,
    shaShort: string,
    stamp: string,
): string {
    const cleanBranch = sanitizeName(branch).replace(/[:/]+/g, "-").slice(0, 30);
    return `${repoBase}-${cleanBranch}-${shaShort}_${stamp}.md`;
}

export function buildMarkdownXmlReport(input: BuildReportInput): BuildReportOutput {
    const {
        owner,
        repo,
        branch,
        sha,
        sinceIso,
        prNumber,
        commentsSince,
        runExtracts,
        ghAstGrepForRun,
        claudeSummary,
        flags,
    } = input;

    const lines: string[] = [];
    const sectionStart = (heading: string, xmlOpen: string) => {
        lines.push(heading);
        lines.push(xmlOpen);
    };
    const sectionEnd = (xmlClose: string) => {
        lines.push(xmlClose);
        lines.push("");
    };

    // Header
    lines.push(`# CI Gather Report`);
    lines.push(
        `Repo: **${owner}/${repo}**  |  Branch: **${branch}**  |  SHA: **${sha.slice(0, 7)}**  |  Since (last push): **${sinceIso}**`,
    );
    if (flags.force) lines.push(`> Note: Generated with \`--force\`.`);
    lines.push("");

    // (A) PR Comments
    {
        const preLen = lines.join("\n").length;
        sectionStart("## PR Comments (since last push)", `<pr-comments since="${sinceIso}">`);
        if (prNumber && commentsSince.length) {
            lines.push(`PR #${prNumber} — ${commentsSince.length} new comment(s):`);
            for (const c of commentsSince) {
                const firstLine = (c.body || "").split(/\r?\n/)[0] || "";
                lines.push(`- @${c.author} (${c.createdAt}): ${firstLine} — ${c.url}`);
            }
        } else if (prNumber) {
            lines.push(`PR #${prNumber} — no new comments since last push.`);
        } else {
            lines.push(`No open PR for branch **${branch}**.`);
        }
        sectionEnd("</pr-comments>");
        var commentsSectionChars = lines.join("\n").length - preLen;
    }

    // (B) Failing CI Excerpts
    let ciSectionChars = 0;
    if (!flags.claudeOnly) {
        const preLen = lines.join("\n").length;
        sectionStart("## Failing CI (runs since last push)", `<ci-runs branch="${branch}" sha="${sha.slice(0,7)}">`);
        if (!runExtracts.length) {
            lines.push("(No failing runs found in the window.)");
        } else {
            for (const rx of runExtracts) {
                const r = rx.run;
                lines.push(`### Run #${r.id}${r.name ? ` — ${r.name}` : ""} — ${r.status}/${r.conclusion || ""}`);
                lines.push(`${r.url}`);
                lines.push(`<ci-run id="${r.id}">`);
                lines.push(`<run-meta createdAt="${r.createdAt || ""}" headSha="${(r.headSha || "").slice(0,7)}"/>`);
                lines.push("<gh-astgrep>");
                lines.push(ghAstGrepForRun(r.id));
                lines.push("</gh-astgrep>");
                lines.push("<jobs>");
                for (const jx of rx.jobs) {
                    lines.push(
                        `<job name="${escapeXmlAttr(jx.job.name)}" id="${jx.job.id}" conclusion="${jx.job.conclusion || ""}">`,
                    );
                    lines.push(
                        `<counts error="${jx.counts.error}" failed="${jx.counts.failed}" xfail="${jx.counts.xfail}" lines="${jx.counts.lines}" chars="${jx.counts.chars}"/>`,
                    );
                    lines.push("<pre>");
                    lines.push(jx.excerpt || "(no failure lines extracted)");
                    lines.push("</pre>");
                    lines.push("</job>");
                }
                lines.push("</jobs>");
                lines.push("</ci-run>");
                lines.push("");
            }
        }
        sectionEnd("</ci-runs>");
        ciSectionChars = lines.join("\n").length - preLen;
    }

    // (C) Claude / Gemini summary
    const preSummaryLen = lines.join("\n").length;
    sectionStart("## Summary of failing CI (Claude Code)", `<ci-summary engine="${claudeSummary ? "claude" : "none"}">`);
    if (claudeSummary) {
        lines.push(claudeSummary);
    } else {
        lines.push("(Summarization skipped or unavailable.)");
    }
    sectionEnd("</ci-summary>");
    const claudeSectionChars = lines.join("\n").length - preSummaryLen;

    // Totals
    const perRunJobCounts = runExtracts.flatMap((rx) =>
        rx.jobs.map((jx) => ({
            runId: rx.run.id,
            jobName: jx.job.name,
            error: jx.counts.error,
            failed: jx.counts.failed,
            xfail: jx.counts.xfail,
            lines: jx.counts.lines,
            chars: jx.counts.chars,
        })),
    );
    const out: BuildReportOutput = {
        markdown: lines.join("\n"),
        lengths: {
            commentsSectionChars,
            ciSectionChars,
            claudeSectionChars,
            totalChars: lines.join("\n").length,
        },
        perRunJobCounts,
    };
    return out;
}

function escapeXmlAttr(s: string): string {
    // Properly escape XML attribute characters.
    return s
        .replace(/&/g, "&")
        .replace(/"/g, """)
        .replace(/</g, "<")
        .replace(/>/g, ">");
}
import type { RepoRef, FailureBundle } from "./types.js";
import { Gh } from "./github.js";
import { truncateByKB } from "./util.js";

export async function gatherFailures(
	ref: RepoRef,
	pr: number,
	sha: string,
	gh: Gh,
	perJobKB = 512,
	totalMB = 5,
): Promise<FailureBundle | null> {
	const ci = await gh.latestCiForSha(ref, sha);
	if (!ci.runs.length) return null;
  const failureLike = new Set(["failure", "timed_out", "cancelled"]);
  const anyFailed = ci.runs.some((r) => r.conclusion && failureLike.has(r.conclusion));
	if (!anyFailed) return null;

	const jobsAll: {
		id: number;
		runId: number;
		name: string;
		html_url: string;
	}[] = [];
	const logEntries: {
		jobId: number;
		runId: number;
		jobName: string;
		text: string;
	}[] = [];

  for (const r of ci.runs.filter((r) => r.conclusion && failureLike.has(r.conclusion))) {
    const jobs = await gh.listJobsForRun(ref, r.id);
    for (const j of jobs.filter((j) => j.conclusion && failureLike.has(j.conclusion))) {
			jobsAll.push({
				id: j.id,
				runId: r.id,
				name: j.name,
				html_url: j.html_url,
			});
			try {
				const raw = await gh.fetchJobLog(ref, j.id);
				const text = truncateByKB(raw, perJobKB);
				logEntries.push({ jobId: j.id, runId: r.id, jobName: j.name, text });
			} catch (e) {
				logEntries.push({
					jobId: j.id,
					runId: r.id,
					jobName: j.name,
					text: `Unable to fetch job log. View online: https://github.com/${ref.owner}/${ref.repo}/runs/${j.id}`,
				});
			}
		}
	}

	// Apply total cap across logs
	const totalLimitBytes = totalMB * 1024 * 1024;
	let acc = 0;
	const capped: typeof logEntries = [];
	for (const l of logEntries) {
		const size = Buffer.byteLength(l.text, "utf8");
		if (acc + size > totalLimitBytes) break;
		capped.push(l);
		acc += size;
	}

	return {
		sha,
		prNumber: pr,
		runs: ci.runs.map((r) => ({
			id: r.id,
			url: r.url,
			conclusion: r.conclusion,
		})),
		jobs: jobsAll,
		logs: capped,
	};
}

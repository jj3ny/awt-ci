import { exec, hashString, sanitizeName, writeTempFile } from "./util.js";
import * as path from "node:path";
import { createHash } from "node:crypto";

function md5Hex(s: string): string {
	return createHash("md5").update(s).digest("hex");
}

export function sessionNameForRepo(repoRoot: string): string {
	const base = path.basename(repoRoot);
	const id = md5Hex(repoRoot).slice(0, 6);
	return `r_${base}_${id}`;
}

export async function resolveRepoSessionNameOrScan(
	repoRoot: string,
	wtWindow: string,
): Promise<string> {
	const preferred = sessionNameForRepo(repoRoot);
	const has = (await exec("tmux", ["has-session", "-t", preferred])).code === 0;
	if (has) return preferred;
	const base = path.basename(repoRoot);
	const ls = await exec("tmux", ["list-sessions", "-F", "#{session_name}"]);
	for (const name of ls.stdout
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean)) {
		if (!name.startsWith(`r_${base}_`)) continue;
		const wins = await exec("tmux", [
			"list-windows",
			"-t",
			name,
			"-F",
			"#{window_name}",
		]);
		if (wins.stdout.split("\n").some((w) => w.trim() === wtWindow)) return name;
	}
	return preferred;
}

export function windowNameForWt(wt: string): string {
	return `wt_${sanitizeName(wt)}`;
}

export async function resolvePrimaryPane(
	sess: string,
	win: string,
): Promise<string> {
	const fmt = "#{?pane_active,1,0} #{pane_id} #{pane_last_active}";
	const out = (
		await exec("tmux", ["list-panes", "-t", `${sess}:${win}`, "-F", fmt])
	).stdout.trim();
	if (!out) throw new Error(`No panes in ${sess}:${win}`);
	const rows = out
		.split("\n")
		.map((l) => {
			const [active, id, last] = l.trim().split(" ");
			return { active: active === "1", id: id ?? "", last: Number(last || "0") };
		})
		.filter((r) => r.id.length > 0);
	const act = rows.find((r) => r.active);
	if (act && act.id) return act.id;
	rows.sort((a, b) => a.last - b.last);
	if (rows.length === 0) throw new Error(`No panes in ${sess}:${win}`);
	const first = rows[0];
	if (!first) throw new Error(`No panes in ${sess}:${win}`);
	return first.id;
}

export async function paneHistorySig(
	sess: string,
	win: string,
): Promise<string> {
	const cap = await exec("tmux", [
		"capture-pane",
		"-p",
		"-S",
		"-200",
		"-t",
		`${sess}:${win}`,
	]);
	const len = cap.stdout.split(/\n/).length;
	return `${len}:${hashString(cap.stdout)}`;
}

export async function pasteAndEnter(
    paneId: string,
    payload: string,
    sentinel: string,
): Promise<"ok" | "retry"> {
	const tmp = await writeTempFile(payload);
	const buf = `awtci:${Date.now()}`;
	await exec("tmux", ["load-buffer", "-b", buf, tmp]);
	await exec("tmux", ["paste-buffer", "-b", buf, "-t", paneId]);
	await exec("tmux", ["send-keys", "-t", paneId, "Enter"]);
  for (let i = 0; i < 8; i++) {
      const tail = (
          await exec("tmux", ["capture-pane", "-p", "-S", "-120", "-t", paneId])
      ).stdout;
      if (tail.includes(sentinel)) return "ok";
      await new Promise((r) => setTimeout(r, 500));
  }
  return "retry";
}

export async function notifyAll(
	sess: string,
	title: string,
	body: string,
): Promise<void> {
	// tmux message
	await exec("tmux", ["display-message", "-t", sess, `${title}: ${body}`]);
	const msg = `${title} — ${body}`;
	// macOS notification paths
	await exec("bash", [
		"-lc",
		`if command -v terminal-notifier >/dev/null; then terminal-notifier -message ${JSON.stringify(msg)} -title ${JSON.stringify(title)}; elif command -v osascript >/dev/null; then osascript -e 'display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)}'; fi`,
	]);
	// Linux
	await exec("bash", [
		"-lc",
		`if command -v notify-send >/dev/null; then notify-send ${JSON.stringify(title)} ${JSON.stringify(body)}; fi`,
	]);
	// OSC 9 for SSH-capable terminals
	process.stdout.write(`\u001b]9;${msg}\u0007`);
}

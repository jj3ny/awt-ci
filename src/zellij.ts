import { createHash } from "node:crypto";
import * as path from "node:path";
import { exec, hashString, sanitizeName, writeTempFile } from "./util.js";

function md5Hex(s: string): string {
	return createHash("md5").update(s).digest("hex");
}

export function sessionNameForRepo(repoRoot: string): string {
	// For zellij, use simple repo basename
	const base = path.basename(repoRoot);
	return base;
}

export async function resolveRepoSessionNameOrScan(
	repoRoot: string,
	wtWindow: string,
): Promise<string> {
	const preferred = sessionNameForRepo(repoRoot);
	// Check if session exists
	const ls = await exec("zellij", ["list-sessions"]);
	if (ls.stdout.split("\n").some(line => line.trim() === preferred)) {
		return preferred;
	}
	// For zellij, just return the preferred name - it will be created if needed
	return preferred;
}

export function windowNameForWt(wt: string): string {
	// No wt_ prefix for zellij tabs
	return sanitizeName(wt);
}

export async function resolvePrimaryPane(
	sess: string,
	win: string,
): Promise<string> {
	// Zellij doesn't expose pane IDs the same way as tmux
	// Return a placeholder that indicates the active pane in the tab
	return `${sess}:${win}:active`;
}

export async function paneHistorySig(
	sess: string,
	win: string,
): Promise<string> {
	// Zellij doesn't expose pane capture; use a stable signature so idle detection can function.
	return `${sess}:${win}`;
}

export async function pasteAndEnter(
	paneId: string,
	payload: string,
	sentinel: string,
): Promise<"ok" | "retry"> {
	// Parse the paneId format (sess:tab:active)
	const [sess] = paneId.split(":");

	// Write payload to temp file
	const tmp = await writeTempFile(payload);

	try {
		// Open a new pane that prints the payload and the sentinel. This is reliable across zellij versions.
		const script = `cat ${JSON.stringify(tmp)}; echo; echo ${JSON.stringify(sentinel)}`;
		await exec("zellij", ["--session", sess, "action", "new-pane", "--", "bash", "-lc", script]);
		return "ok";
	} catch (e) {
		console.error("Failed to display payload in zellij pane:", e);
		return "retry";
	}
}

export async function notifyAll(
	sess: string,
	title: string,
	body: string,
): Promise<void> {
	// Zellij doesn't have built-in messaging like tmux display-message
	const msg = `${title} — ${body}`;
	
	// macOS notification
	await exec("bash", [
		"-lc",
		`if command -v terminal-notifier >/dev/null; then terminal-notifier -message ${JSON.stringify(msg)} -title ${JSON.stringify(title)}; elif command -v osascript >/dev/null; then osascript -e 'display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)}'; fi`,
	]).catch(() => {});
	
	// Linux notification
	await exec("bash", [
		"-lc",
		`if command -v notify-send >/dev/null; then notify-send ${JSON.stringify(title)} ${JSON.stringify(body)}; fi`,
	]).catch(() => {});
	
	// OSC 9 for SSH-capable terminals
	process.stdout.write(`\u001b]9;${msg}\u0007`);
}
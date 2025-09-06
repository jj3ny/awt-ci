import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse } from "jsonc-parser";

export async function exec(
	cmd: string,
	args: string[],
	stdin?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const p = spawn(cmd, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		let out = "";
		let err = "";
		p.stdout.on("data", (d) => {
			out += d.toString();
		});
		p.stderr.on("data", (d) => {
			err += d.toString();
		});
		p.on("close", (code) =>
			resolve({ stdout: out, stderr: err, code: code ?? 0 }),
		);
		if (stdin) p.stdin.end(stdin);
	});
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function readJsonc<T>(file: string): Promise<T | null> {
	try {
		const raw = await fs.readFile(file, "utf8");
		return parse(raw) as T;
	} catch {
		return null;
	}
}

export function hashString(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

export function truncateByKB(text: string, kb: number): string {
	const bytes = Buffer.byteLength(text, "utf8");
	const limit = kb * 1024;
	if (bytes <= limit) return text;
	const buf = Buffer.from(text, "utf8");
	const slice = buf.subarray(buf.length - limit);
	return `(truncated to ${kb}KB tail)\n${slice.toString("utf8")}`;
}

export async function writeTempFile(content: string): Promise<string> {
	const dir = path.join(os.tmpdir(), "awt-ci");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `${randomUUID()}.txt`);
	await fs.writeFile(file, content, "utf8");
	return file;
}

export function sanitizeName(s: string): string {
	return s
		.replace(/[\n\r\t]/g, " ")
		.replace(/[\s/]/g, "_")
		.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export async function getGhToken(): Promise<string | null> {
	if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
	if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
	// Attempt to use gh CLI for local auth
	try {
		const { stdout, code } = await exec("gh", ["auth", "token"]);
		if (code === 0 && stdout.trim()) return stdout.trim();
	} catch {}
	return null;
}

export async function copyToClipboard(text: string): Promise<boolean> {
	// Prefer native pbcopy on macOS
	if (process.platform === "darwin") {
		try {
			const { code } = await exec(
				"bash",
				["-lc", "command -v /usr/bin/pbcopy >/dev/null && /usr/bin/pbcopy"],
				text,
			);
			if (code === 0) return true;
		} catch {}
	}
	// Try pbcopy in PATH (could be your OSC52 script)
	try {
		const { code } = await exec(
			"bash",
			["-lc", "command -v pbcopy >/dev/null && pbcopy"],
			text,
		);
		if (code === 0) return true;
	} catch {}
	// Wayland clipboard
	try {
		const { code } = await exec(
			"bash",
			["-lc", "command -v wl-copy >/dev/null && wl-copy"],
			text,
		);
		if (code === 0) return true;
	} catch {}
	// X11 clipboard
	try {
		const { code } = await exec(
			"bash",
			["-lc", "command -v xclip >/dev/null && xclip -selection clipboard"],
			text,
		);
		if (code === 0) return true;
	} catch {}
	return false;
}

export async function safeRead(filePath: string, fallback = "Please analyze the failures above and continue working to resolve them."): Promise<string> {
  try {
    return await (await fs.readFile(filePath, "utf8")).toString();
  } catch {
    return fallback;
  }
}

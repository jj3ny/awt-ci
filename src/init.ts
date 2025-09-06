import { promises as fs } from "node:fs";
import * as path from "node:path";
import { repoRoot } from "./git.js";
import { exec } from "./util.js";

const DEFAULT_CONFIG = `{
  // Optional owner/repo override; usually auto-detected from origin remote
  // "owner": "your-org",
  // "repo": "your-repo",
  "promptPath": ".awt/prompts/debug.md",
  "engine": "claude",
  "summarizePerJobKB": 512,
  "summarizeTotalMB": 5,
  "pollSecIdle": 60,
  "pollSecPostPush": 20,
  "idleSec": 300,
  "eventMode": false,
  "maxRecentComments": 30
}
`;

const DEFAULT_PROMPT = `# Continue fixing CI failures

Please analyze the summary and quoted log lines above and do the following:

1) Identify the failing tests/files and the root cause.
2) Propose minimal, targeted fixes (code edits or test updates).
3) If unclear, run read-only commands to gather more context (git/gh/cat/grep/rg).
4) Apply fixes and re-run tests locally as needed.
5) Push updates to the same branch and confirm CI turns green.

Prefer small, safe changes. Explain any risky edits.
`;

const PRE_PUSH_REPO = `#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
sha="$(git rev-parse HEAD)"
now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
mkdir -p "$root/.awt"
state="$root/.awt/state.json"
tmp="$state.tmp.$$"
if command -v python3 >/dev/null 2>&1; then
python3 - "$state" "$tmp" "$sha" "$now" <<'PY'
import json, sys, os
src, dst, sha, now = sys.argv[1:]
data = {}
if os.path.exists(src):
    try:
        with open(src) as f:
            data = json.load(f)
    except Exception:
        data = {}
data["last_push"] = {"sha": sha, "pushed_at": now}
with open(dst, "w") as f:
    json.dump(data, f)
PY
  mv "$tmp" "$state"
else
  printf '{"last_push":{"sha":"%s","pushed_at":"%s"}}' "$sha" "$now" > "$state"
fi
exit 0
`;

const PRE_PUSH_GLOBAL_GUARDED = `#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -z "$root" ]] && exit 0
[[ -d "$root/.awt" ]] || exit 0
sha="$(git rev-parse HEAD)"
now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
mkdir -p "$root/.awt"
state="$root/.awt/state.json"
tmp="$state.tmp.$$"
if command -v python3 >/dev/null 2>&1; then
python3 - "$state" "$tmp" "$sha" "$now" <<'PY'
import json, sys, os
src, dst, sha, now = sys.argv[1:]
data = {}
if os.path.exists(src):
    try:
        with open(src) as f:
            data = json.load(f)
    except Exception:
        data = {}
data["last_push"] = {"sha": sha, "pushed_at": now}
with open(dst, "w") as f:
    json.dump(data, f)
PY
  mv "$tmp" "$state"
else
  printf '{"last_push":{"sha":"%s","pushed_at":"%s"}}' "$sha" "$now" > "$state"
fi
exit 0
`;

// removed old EVENT_WORKFLOW_TEMPLATE

export async function initRepo(opts: {
	withHook: boolean;
	withConfig: boolean;
	withPrompt: boolean;
}) {
	const root = await repoRoot();
	if (opts.withConfig) {
		const cfgDir = path.join(root, ".awt");
		await fs.mkdir(cfgDir, { recursive: true });
		const cfgPath = path.join(cfgDir, "config.jsonc");
		try {
			await fs.access(cfgPath);
		} catch {
			await fs.writeFile(cfgPath, DEFAULT_CONFIG, "utf8");
		}
	}
	if (opts.withPrompt) {
		const pDir = path.join(root, ".awt", "prompts");
		await fs.mkdir(pDir, { recursive: true });
		const pPath = path.join(pDir, "debug.md");
		try {
			await fs.access(pPath);
		} catch {
			await fs.writeFile(pPath, DEFAULT_PROMPT, "utf8");
		}
	}
	if (opts.withHook) {
		const hooksDir = path.join(root, ".githooks");
		await fs.mkdir(hooksDir, { recursive: true });
		const prePush = path.join(hooksDir, "pre-push");
		await fs.writeFile(prePush, PRE_PUSH_REPO, {
			encoding: "utf8",
			mode: 0o755,
		});
		await exec("git", ["config", "core.hooksPath", ".githooks"]);
	}
}

export async function initGlobalHook(opts: { configureGit: boolean }) {
	const home = process.env.HOME || process.env.USERPROFILE || ".";
	const dir = path.join(home, ".config", "git", "hooks");
	await fs.mkdir(dir, { recursive: true });
	const p = path.join(dir, "pre-push");
	await fs.writeFile(p, PRE_PUSH_GLOBAL_GUARDED, {
		encoding: "utf8",
		mode: 0o755,
	});
	if (opts.configureGit) {
		await exec("git", ["config", "--global", "core.hooksPath", dir]);
	}
}

export async function scaffoldEventWorkflow(opts: {
	workflow: string;
	worktree: string;
}) {
	const root = await repoRoot();
	const wfDir = path.join(root, ".github", "workflows");
	await fs.mkdir(wfDir, { recursive: true });
	const wfPath = path.join(wfDir, "awt-event-paste.yml");
	const yml = EVENT_WORKFLOW_TEMPLATE_FIXED(opts.workflow, opts.worktree);
	await fs.writeFile(wfPath, yml, "utf8");
}

// Fixed YAML template (actual newlines, no stray characters)
const EVENT_WORKFLOW_TEMPLATE_FIXED = (
	workflowName: string,
	wt: string,
) => `name: AWT Event Paste

on:
  workflow_run:
    workflows: ["${workflowName}"]
    types: [completed]

jobs:
  paste-on-failure:
    if: \${{ github.event.workflow_run.conclusion == 'failure' }}
    runs-on: self-hosted
    steps:
      - name: Paste failure summary into tmux
        run: |
          export GITHUB_HEAD_SHA="\${{ github.event.workflow_run.head_sha }}"
          awt-ci watch --wt ${wt} --event-mode
`;

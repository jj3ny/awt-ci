# awt-ci (Agent WorkTree CI helper)

Local TypeScript CLI to watch a worktree's branch/PR/CI, gather CI failure context and PR comments since last push, and inject a ready-to-run prompt back into the agent's tmux pane.

## Install

```bash
cd awt-ci
npm install
npm run build
npm run link   # installs 'awt-ci' globally
```

## Auth & Setup

Claude Code (subscription billing; no API keys):

```
npm i -g @anthropic-ai/claude-code
claude login    # sign in with your Pro/Max account
```

Important: Do not set ANTHROPIC_API_KEY (or CLAUDE_API_KEY). awt-ci explicitly unsets these at runtime so summaries bill against your Claude subscription via the installed Claude Code runtime.

GitHub (uses your local gh login; no token env needed):

```
gh auth login   # ensure access to your repo and Actions logs
```

If you prefer env tokens, set `GITHUB_TOKEN` or `GH_TOKEN`. Otherwise awt-ci will call `gh auth token` to authenticate API requests.

## Usage

From inside a repo:

```bash
awt watch <worktree-name> --engine claude
```

Configure per repo in `.awt/config.jsonc` and edit your prompt in `.awt/prompts/debug.md`.

Manual one-shot gather to clipboard or stdout:

```
awt gather <worktree-name> --copy      # copy to clipboard (pbcopy/OSC52/wl-copy/xclip)
awt gather <worktree-name>             # print to stdout
```

## Notes

- Requires `tmux`. GitHub auth is taken from your local `gh` login by default.
- Summarization uses Claude Code SDK (subscription billing). If Claude is unavailable, a heuristic fallback is used.
- Uses tmux buffer paste with sentinel verification for reliability.

## Git hook (optional, recommended)

You can add a pre-push hook so awt-ci knows the exact time of your last push. This makes “comments since last push” precise.

Example hook is provided in `examples/githooks/pre-push`.

Per repo:

```
cp -R examples/githooks .githooks
git config core.hooksPath .githooks
chmod +x .githooks/pre-push
```

Notes:
- The hook requires `python3` for a safe JSON merge. If not present, it still writes `last_push` fields.
- If you push with `--no-verify`, hooks are skipped.
- Pushing via GitHub UI/API won’t run local hooks; awt-ci still works via polling.

You can also copy this same `.githooks` folder to other repos — it’s generic. Only your `.awt/prompts/debug.md` and `.awt/config.jsonc` are repo-specific.

## Scaffolding helpers

Initialize a repo with `.awt/` and a local pre-push hook:

```
awt-ci init                      # creates .awt/ files and .githooks/pre-push
```

Install a guarded global pre-push hook (runs only when `.awt/` exists):

```
awt-ci init-global-hook --configure-git
```

Create a self-hosted runner workflow that pastes on CI failure (event-mode):

```
awt-ci scaffold-event-workflow --workflow "Your CI Workflow Name" --wt <worktree>
```

Notes:
- `--workflow` must match the workflow’s `name:` (not the filename).
- The self-hosted runner must be the same host where tmux + awt sessions run.

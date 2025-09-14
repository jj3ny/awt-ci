import { spawn } from "node:child_process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

yargs(hideBin(process.argv))
	.scriptName("awt-ci")
	.command(
		"watch",
		"Watch a worktree/PR/CI and inject feedback",
		(y) =>
			y
				.option("wt", {
					type: "string",
					demandOption: true,
					desc: "worktree name",
				})
				.option("engine", {
					choices: ["claude", "gemini"] as const,
					default: "claude",
				})
				.option("mux", {
					choices: ["tmux", "zellij"] as const,
					desc: "Terminal multiplexer (defaults to AWT_MULTIPLEXER env or zellij)",
				})
				.option("idle-sec", { type: "number", default: 300 })
				.option("poll-sec-idle", { type: "number", default: 60 })
				.option("poll-sec-post-push", { type: "number", default: 20 })
				.option("event-mode", { type: "boolean", default: false })
				.option("foreground", {
					type: "boolean",
					default: false,
					desc: "run in foreground (no detach)",
				}),
		async (argv) => {
			const {
				wt,
				engine,
				mux,
				idleSec,
				pollSecIdle,
				pollSecPostPush,
				eventMode,
				foreground,
			} = argv as any;

			if (mux) {
				process.env.AWT_MULTIPLEXER = mux;
			}

			// Detach by default unless explicitly in event mode or foreground
			if (!eventMode && !foreground) {
				const node = process.execPath;
				const script = process.argv[1] || new URL(import.meta.url).pathname;
				const args: readonly string[] = [
					script,
					...process.argv.slice(2),
					"--foreground",
				];
				const child = spawn(node, args as string[], {
					detached: true,
					stdio: "ignore",
					cwd: process.cwd(),
					env: process.env,
				});
				(child as unknown as { unref: () => void }).unref();
				console.log(
					"awt-ci watch started in background. Use --foreground to run interactively.",
				);
				return;
			}

			const { watch } = await import("./watch.js");
			await watch({
				worktree: wt,
				engine,
				idleSec,
				pollSecIdle,
				pollSecPostPush,
				eventMode,
			});
		},
	)
	.command(
		"gather",
		"Gather CI failures since last push (remote-only), summarize, and write a markdown report",
		(y) =>
			y
				.option("wt", {
					type: "string",
					desc: "worktree name (uses its current branch's *remote* counterpart)",
				})
				.option("engine", {
					choices: ["claude", "gemini"] as const,
					default: "claude",
				})
				.option("branch", {
					type: "string",
					desc: "remote branch name (gather for this branch if no worktree)",
				})
				.option("force", {
					type: "boolean",
					default: false,
					desc: "proceed even if CI is still in progress",
				})
				.option("skip-claude", {
					type: "boolean",
					default: false,
					desc: "skip Claude/Gemini summary",
				})
				.option("claude-only", {
					type: "boolean",
					default: false,
					desc: "include only Claude/Gemini summary (omit raw failure lines)",
				})
				.option("out", {
					type: "string",
					desc: "optional explicit output file path",
				})
				.check((argv) => {
					if (!argv.wt && !argv.branch) {
						throw new Error("Either --wt or --branch must be provided");
					}
					return true;
				}),
		async (argv) => {
			const {
				wt = "",
				engine,
				force,
				skipClaude,
				claudeOnly,
				branch,
				out,
			} = argv as any;
			const { gather } = await import("./gather.js");
			await gather({
				worktree: wt,
				engine,
				force,
				skipClaude,
				claudeOnly,
				branch,
				out,
			});
		},
	)
	.command(
		"init",
		"Scaffold .awt and local pre-push hook",
		(y) =>
			y
				.option("with-hook", {
					type: "boolean",
					default: true,
					desc: "install repo pre-push hook",
				})
				.option("with-config", {
					type: "boolean",
					default: true,
					desc: "create .awt/config.jsonc if missing",
				})
				.option("with-prompt", {
					type: "boolean",
					default: true,
					desc: "create .awt/prompts/debug.md if missing",
				}),
		async (argv) => {
			const { withHook, withConfig, withPrompt } = argv as any;
			const { initRepo } = await import("./init.js");
			await initRepo({
				withHook: withHook,
				withConfig: withConfig,
				withPrompt: withPrompt,
			});
			console.log("Initialized .awt and pre-push hook (if selected).");
		},
	)
	.command(
		"init-global-hook",
		"Install guarded global pre-push hook (~/.config/git/hooks)",
		(y) =>
			y.option("configure-git", {
				type: "boolean",
				default: false,
				desc: "set git --global core.hooksPath",
			}),
		async (argv) => {
			const { configureGit } = argv as any;
			const { initGlobalHook } = await import("./init.js");
			await initGlobalHook({ configureGit });
			console.log("Installed guarded global pre-push hook.");
		},
	)
	.command(
		"scaffold-event-workflow",
		"Create a self-hosted runner workflow to paste on CI failure",
		(y) =>
			y
				.option("workflow", {
					type: "string",
					demandOption: true,
					desc: "CI workflow name to watch",
				})
				.option("wt", {
					type: "string",
					demandOption: true,
					desc: "worktree name for tmux window on the host",
				}),
		async (argv) => {
			const { workflow, wt } = argv as any;
			const { scaffoldEventWorkflow } = await import("./init.js");
			await scaffoldEventWorkflow({ workflow, worktree: wt });
			console.log("Created .github/workflows/awt-event-paste.yml");
		},
	)
	.demandCommand(1)
	.strict()
	.help()
	.parse();

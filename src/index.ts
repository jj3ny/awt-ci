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
				.option("idle-sec", { type: "number", default: 300 })
				.option("poll-sec-idle", { type: "number", default: 60 })
				.option("poll-sec-post-push", { type: "number", default: 20 })
				.option("event-mode", { type: "boolean", default: false }),
		async (argv) => {
			const { wt, engine, idleSec, pollSecIdle, pollSecPostPush, eventMode } =
				argv as any;
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
		"Gather CI failure context and print/copy",
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
				.option("copy", {
					type: "boolean",
					default: false,
					desc: "copy to clipboard if possible",
				}),
		async (argv) => {
			const { wt, engine, copy } = argv as any;
			const { gather } = await import("./gather.js");
			await gather({ worktree: wt, engine, copy });
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

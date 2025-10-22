# Plan: Resolve TypeScript errors in GitHub + Zellij helpers

1. Baseline the problem: run `pnpm exec tsc --noEmit` and capture the exact errors for `src/github.ts` and `src/zellij.ts` so we know what needs to change.
2. Fix `src/github.ts`: make the `latestOpenPr` helper safely handle empty results (no unsafe `[0]` access) and replace the loose `as any` cast with explicit optional chaining so TypeScript can prove the object exists before we dereference it.
3. Fix `src/zellij.ts`: tighten the pane parsing logic so we either return a validated session string or throw a descriptive error instead of passing a potential `undefined` into `exec`.
4. Quality gate: format + lint touched files with `biome check src/github.ts src/zellij.ts --write`, then re-run `pnpm exec tsc --noEmit` to confirm the type errors are gone. If there are project tests (none discovered yet), run the relevant script and document the outcome.

# Plan: Fix `pnpm install`

1. Inspect the failing code path in `src/report.ts` (around line 290) to confirm the intended XML escaping for attributes and check for similar helpers that might need attention.
2. Add regression coverage for `escapeXmlAttr` (e.g., a new `src/report.test.ts` that exercises attribute escaping) and observe the test fail under the current implementation.
3. Update `escapeXmlAttr` to perform explicit replacements for `&`, `"`, `'`, `<`, and `>` → `&amp;`, `&quot;`, `&apos;`, `&lt;`, `&gt;`, ensuring the order prevents double-escaping (escape ampersands first) and keeping the helper focused on attribute values.
4. Re-run the full quality gate: `pnpm install` (which triggers the prepare script), then `pnpm dlx @biomejs/biome@latest check . --apply`, `pnpm dlx tsc --noEmit`, and any relevant project tests (currently none); address any new lint/type errors that surface (e.g., normalizing `commentsSectionChars` declaration scope in `src/report.ts`).

Notes:
- No other files should require modification unless additional build errors surface after the first fix.
- If further issues appear, extend the plan and repeat the inspection/fix loop.

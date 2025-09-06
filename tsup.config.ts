import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	outDir: "dist",
	format: ["esm"],
	target: "node20",
	sourcemap: true,
	clean: true,
	dts: false,
	banner: { js: "#!/usr/bin/env node" },
	platform: "node",
	splitting: true,
	treeshake: false,
});

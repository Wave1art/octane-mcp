import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  bundle: true,
  // Bundle everything (including the MCP SDK) into one file so `npx octane-mcp`
  // cold-starts fast and has no install-time surprises on locked-down machines.
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  clean: true,
  minify: false,
  // The bundle is ESM but undici and parts of the SDK are CJS: give them a working require().
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from \"node:module\"; const require = __createRequire(import.meta.url);",
  },
});

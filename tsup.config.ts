import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

const CLI_BINS = ["dist/cli/main.js", "dist/server/serve.js"];

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/core/index.ts",
    "src/core/models.ts",
    "src/core/store.ts",
    "src/core/cas.ts",
    "src/core/frontier.ts",
    "src/core/manifest.ts",
    "src/core/reconciler.ts",
    "src/local/index.ts",
    "src/local/sqlite-store.ts",
    "src/local/fs-cas.ts",
    "src/cli/main.ts",
    "src/server/index.ts",
    "src/server/app.ts",
    "src/server/serve.ts",
    "src/nexus/index.ts",
  ],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  external: [
    "bun:sqlite",
    "bun:ffi",
    "@opentui/core",
    "@opentui/react",
    "ghostty-opentui",
    "ghostty-opentui/terminal-buffer",
  ],
  clean: true,
  treeshake: true,
  target: "node22",
  async onSuccess() {
    // Add bun shebang to CLI binaries so they work with `bun link`
    for (const bin of CLI_BINS) {
      const path = join(process.cwd(), bin);
      try {
        const content = readFileSync(path, "utf-8");
        if (!content.startsWith("#!")) {
          writeFileSync(path, `#!/usr/bin/env bun\n${content}`);
          chmodSync(path, 0o755);
        }
      } catch {
        // File may not exist if entry was removed
      }
    }
  },
});

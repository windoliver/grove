import { defineConfig } from "tsup";

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
  external: ["bun:sqlite"],
  clean: true,
  treeshake: true,
  target: "node22",
});

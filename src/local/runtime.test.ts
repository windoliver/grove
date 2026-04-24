import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalRuntime } from "./runtime.js";

describe("createLocalRuntime", () => {
  test("falls back to GROVE.md for configless sessions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "grove-runtime-"));
    const groveDir = join(rootDir, ".grove");
    const previousSessionId = process.env.GROVE_SESSION_ID;

    try {
      await mkdir(groveDir, { recursive: true });
      await Bun.write(
        join(rootDir, "GROVE.md"),
        `---
contract_version: 1
name: runtime-fallback-test
---
# Runtime fallback test
`,
      );

      const seedRuntime = createLocalRuntime({
        groveDir,
        parseContract: false,
      });
      const session = await seedRuntime.goalSessionStore.createSession({
        goal: "configless session",
      });
      seedRuntime.close();

      process.env.GROVE_SESSION_ID = session.id;

      const runtime = createLocalRuntime({ groveDir });
      try {
        expect(runtime.contract?.contractVersion).toBe(1);
        expect(runtime.contract?.name).toBe("runtime-fallback-test");
      } finally {
        runtime.close();
      }
    } finally {
      if (previousSessionId === undefined) {
        delete process.env.GROVE_SESSION_ID;
      } else {
        process.env.GROVE_SESSION_ID = previousSessionId;
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

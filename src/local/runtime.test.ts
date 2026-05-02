import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeClaim, makeContribution } from "../core/test-helpers.js";
import { WatchHub } from "../core/watch-hub.js";
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

  test("watchHub republishes contribution + claim writes (PR2 #388)", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "grove-runtime-watch-"));
    const groveDir = join(rootDir, ".grove");
    const NS = "test-ns";

    try {
      await mkdir(groveDir, { recursive: true });
      const hub = new WatchHub();
      const runtime = createLocalRuntime({
        groveDir,
        parseContract: false,
        watchHub: hub,
        watchNamespace: NS,
      });
      try {
        const c = makeContribution({ summary: "watch-c-1" });
        await runtime.contributionStore.put(c);
        expect(hub.currentRv(NS, "Contribution")).toBe(1n);

        const claim = makeClaim({ targetRef: "watch-c-target" });
        await runtime.claimStore.createClaim(claim);
        expect(hub.currentRv(NS, "Claim")).toBe(1n);

        await runtime.claimStore.complete(claim.claimId);
        expect(hub.currentRv(NS, "Claim")).toBe(2n);
      } finally {
        runtime.close();
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("watchHub without watchNamespace throws", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "grove-runtime-watch-bad-"));
    const groveDir = join(rootDir, ".grove");
    try {
      await mkdir(groveDir, { recursive: true });
      const hub = new WatchHub();
      expect(() =>
        createLocalRuntime({
          groveDir,
          parseContract: false,
          watchHub: hub,
        }),
      ).toThrow(/watchNamespace is required/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

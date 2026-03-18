/**
 * Tests for the grove release command handler.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaimStatus } from "../../core/models.js";
import type { ClaimStore } from "../../core/store.js";
import { makeClaim } from "../../core/test-helpers.js";
import { createSqliteStores } from "../../local/sqlite-store.js";
import type { ReleaseDeps } from "./release.js";
import { runRelease } from "./release.js";

describe("grove release", () => {
  let claimStore: ClaimStore;
  let close: () => void;
  let tempDir: string;
  let stdout: string[];
  let stderr: string[];
  let deps: ReleaseDeps;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grove-release-test-"));
    const stores = createSqliteStores(join(tempDir, "test.db"));
    claimStore = stores.claimStore;
    close = stores.close;
    stdout = [];
    stderr = [];
    deps = {
      claimStore,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    };
  });

  afterEach(async () => {
    close();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("releases an active claim", async () => {
    const claim = makeClaim({ claimId: "rel-1", targetRef: "rel-target" });
    await claimStore.createClaim(claim);

    await runRelease(["rel-1"], deps);

    expect(stdout.length).toBe(1);
    expect(stdout[0]).toContain("Released");
    expect(stdout[0]).toContain("rel-1");

    const retrieved = await claimStore.getClaim("rel-1");
    expect(retrieved?.status).toBe(ClaimStatus.Released);
  });

  test("completes a claim with --completed flag", async () => {
    const claim = makeClaim({ claimId: "comp-1", targetRef: "comp-target" });
    await claimStore.createClaim(claim);

    await runRelease(["comp-1", "--completed"], deps);

    expect(stdout.length).toBe(1);
    expect(stdout[0]).toContain("Completed");
    expect(stdout[0]).toContain("comp-1");

    const retrieved = await claimStore.getClaim("comp-1");
    expect(retrieved?.status).toBe(ClaimStatus.Completed);
  });

  test("shows error when claim-id is missing", async () => {
    await expect(runRelease([], deps)).rejects.toThrow("Missing required argument: <claim-id>");
  });

  test("throws when releasing non-existent claim", async () => {
    await expect(runRelease(["nonexistent"], deps)).rejects.toThrow();
  });

  test("throws when releasing already-released claim", async () => {
    const claim = makeClaim({ claimId: "double-rel", targetRef: "double-target" });
    await claimStore.createClaim(claim);
    await claimStore.release("double-rel");

    await expect(runRelease(["double-rel"], deps)).rejects.toThrow();
  });
});

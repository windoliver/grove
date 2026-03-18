/**
 * Tests for the grove claim command handler.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClaimStore } from "../../core/store.js";
import { createSqliteStores } from "../../local/sqlite-store.js";
import type { ClaimDeps } from "./claim.js";
import { runClaim } from "./claim.js";

describe("grove claim", () => {
  let claimStore: ClaimStore;
  let close: () => void;
  let tempDir: string;
  let stdout: string[];
  let stderr: string[];
  let deps: ClaimDeps;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grove-claim-test-"));
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

  test("creates a claim with default lease", async () => {
    await runClaim(["optimize-parser"], deps);

    expect(stdout.length).toBe(1);
    expect(stdout[0]).toContain("Claimed");
    expect(stdout[0]).toContain("optimize-parser");

    const claims = await claimStore.activeClaims("optimize-parser");
    expect(claims.length).toBe(1);
    expect(claims[0]?.targetRef).toBe("optimize-parser");
    expect(claims[0]?.intentSummary).toBe("optimize-parser");
  });

  test("creates a claim with explicit lease", async () => {
    await runClaim(["my-target", "--lease", "1h"], deps);

    const claims = await claimStore.activeClaims("my-target");
    expect(claims.length).toBe(1);
    const claim = claims[0];
    expect(claim).toBeDefined();
    const remaining = new Date(claim?.leaseExpiresAt ?? "").getTime() - Date.now();
    // Should be approximately 1 hour (with some tolerance)
    expect(remaining).toBeGreaterThan(3_500_000);
    expect(remaining).toBeLessThan(3_700_000);
  });

  test("creates a claim with short lease flag", async () => {
    await runClaim(["my-target", "-l", "30m"], deps);

    const claims = await claimStore.activeClaims("my-target");
    expect(claims.length).toBe(1);
    const claim = claims[0];
    expect(claim).toBeDefined();
    const remaining = new Date(claim?.leaseExpiresAt ?? "").getTime() - Date.now();
    expect(remaining).toBeGreaterThan(1_700_000);
    expect(remaining).toBeLessThan(1_900_000);
  });

  test("creates a claim with explicit intent", async () => {
    await runClaim(["blake3:abc123", "--intent", "extend with caching"], deps);

    const claims = await claimStore.activeClaims("blake3:abc123");
    expect(claims.length).toBe(1);
    expect(claims[0]?.intentSummary).toBe("extend with caching");
  });

  test("uses target as intent when --intent not specified", async () => {
    await runClaim(["optimize the parser"], deps);

    const claims = await claimStore.activeClaims("optimize the parser");
    expect(claims[0]?.intentSummary).toBe("optimize the parser");
  });

  test("renews lease when same agent reclaims same target", async () => {
    await runClaim(["target-A", "--lease", "1h"], deps);
    stdout = [];
    stderr = [];

    // Same agent reclaims — should renew, not fail
    await runClaim(["target-A", "--lease", "30m", "--intent", "updated"], deps);
    expect(stdout.length).toBe(1);
    expect(stdout[0]).toContain("Renewed");
    expect(stderr.length).toBe(0);

    // Still one active claim
    const claims = await claimStore.activeClaims("target-A");
    expect(claims.length).toBe(1);
    expect(claims[0]?.intentSummary).toBe("updated");
  });

  test("warns when different agent holds the target", async () => {
    await runClaim(["target-B", "--lease", "1h", "--agent-id", "agent-a"], deps);
    stdout = [];
    stderr = [];

    // Different agent tries to claim — warns and then fails
    await expect(
      runClaim(["target-B", "--lease", "30m", "--agent-id", "agent-b"], deps),
    ).rejects.toThrow(/active claim/);
    expect(stderr.length).toBe(1);
    expect(stderr[0]).toContain("Warning");
    expect(stderr[0]).toContain("agent-a");
  });

  test("shows error when target is missing", async () => {
    await expect(runClaim([], deps)).rejects.toThrow("Missing required argument: <target>");
  });

  test("outputs claim_id on success", async () => {
    await runClaim(["my-target"], deps);

    expect(stdout[0]).toContain("Claimed");
    // The output should contain a UUID-format claim ID
    const claims = await claimStore.activeClaims("my-target");
    expect(claims.length).toBe(1);
    expect(stdout[0]).toContain(claims[0]?.claimId);
  });

  test("respects --agent-id flag", async () => {
    await runClaim(["target-x", "--agent-id", "custom-agent"], deps);

    const claims = await claimStore.activeClaims("target-x");
    expect(claims[0]?.agent.agentId).toBe("custom-agent");
  });
});

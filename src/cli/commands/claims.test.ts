/**
 * Tests for the grove claims (list) command handler.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimStore } from "../../core/store.js";
import { makeClaim } from "../../core/test-helpers.js";
import { createSqliteStores } from "../../local/sqlite-store.js";
import type { ClaimsDeps } from "./claims.js";
import { runClaims } from "./claims.js";

describe("grove claims", () => {
  let claimStore: ClaimStore;
  let close: () => void;
  let tempDir: string;
  let stdout: string[];
  let stderr: string[];
  let deps: ClaimsDeps;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grove-claims-test-"));
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

  test("shows 'no claims found' when empty", async () => {
    await runClaims([], deps);

    expect(stdout.length).toBe(1);
    expect(stdout[0]).toContain("No claims found");
  });

  test("lists active claims by default", async () => {
    const c1 = makeClaim({ claimId: "active-1", targetRef: "t-1", intentSummary: "task one" });
    const c2 = makeClaim({ claimId: "active-2", targetRef: "t-2", intentSummary: "task two" });
    await claimStore.createClaim(c1);
    await claimStore.createClaim(c2);

    await runClaims([], deps);

    expect(stdout.length).toBe(1);
    const output = stdout[0] ?? "";
    expect(output).toContain("active-1");
    expect(output).toContain("active-2");
    expect(output).toContain("CLAIM_ID");
    expect(output).toContain("TARGET");
  });

  test("excludes released claims from default listing", async () => {
    const active = makeClaim({ claimId: "stays", targetRef: "t-s" });
    const released = makeClaim({ claimId: "gone", targetRef: "t-g" });
    await claimStore.createClaim(active);
    await claimStore.createClaim(released);
    await claimStore.release("gone");

    await runClaims([], deps);

    const output = stdout[0] ?? "";
    expect(output).toContain("stays");
    expect(output).not.toContain("gone");
  });

  test("filters by agent with --agent flag", async () => {
    const c1 = makeClaim({
      claimId: "a1",
      targetRef: "ta-1",
      agent: { agentId: "agent-bob" },
    });
    const c2 = makeClaim({
      claimId: "a2",
      targetRef: "ta-2",
      agent: { agentId: "agent-alice" },
    });
    await claimStore.createClaim(c1);
    await claimStore.createClaim(c2);

    await runClaims(["--agent", "agent-bob"], deps);

    const output = stdout[0] ?? "";
    expect(output).toContain("a1");
    expect(output).not.toContain("a2");
  });

  test("filters by agent with -a short flag", async () => {
    const c1 = makeClaim({
      claimId: "s1",
      targetRef: "ts-1",
      agent: { agentId: "agent-x" },
    });
    await claimStore.createClaim(c1);

    await runClaims(["-a", "agent-x"], deps);

    expect(stdout[0]).toContain("s1");
  });

  test("shows expired/released/completed claims with --expired flag", async () => {
    const active = makeClaim({ claimId: "still-active", targetRef: "te-1" });
    const released = makeClaim({ claimId: "was-released", targetRef: "te-2" });
    const completed = makeClaim({ claimId: "was-completed", targetRef: "te-3" });
    await claimStore.createClaim(active);
    await claimStore.createClaim(released);
    await claimStore.createClaim(completed);
    await claimStore.release("was-released");
    await claimStore.complete("was-completed");

    await runClaims(["--expired"], deps);

    const output = stdout[0] ?? "";
    expect(output).toContain("was-released");
    expect(output).toContain("was-completed");
    expect(output).not.toContain("still-active");
  });

  test("combines --agent and --expired flags", async () => {
    const c1 = makeClaim({
      claimId: "combo-1",
      targetRef: "tc-1",
      agent: { agentId: "agent-a" },
    });
    const c2 = makeClaim({
      claimId: "combo-2",
      targetRef: "tc-2",
      agent: { agentId: "agent-b" },
    });
    await claimStore.createClaim(c1);
    await claimStore.createClaim(c2);
    await claimStore.release("combo-1");
    await claimStore.release("combo-2");

    await runClaims(["--expired", "--agent", "agent-a"], deps);

    const output = stdout[0] ?? "";
    expect(output).toContain("combo-1");
    expect(output).not.toContain("combo-2");
  });
});

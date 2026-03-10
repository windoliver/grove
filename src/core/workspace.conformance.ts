/**
 * Conformance test suite for WorkspaceManager implementations.
 *
 * Any backend implementing WorkspaceManager must pass these tests.
 * Uses the same factory pattern as store.conformance.ts and cas.conformance.ts.
 *
 * Tests cover:
 * - Checkout creates workspace with artifacts
 * - Idempotent re-checkout
 * - Workspace listing and filtering
 * - Cleanup lifecycle
 * - Stale detection
 * - Active claim blocks cleanup
 * - Partial materialization recovery
 * - Touch workspace updates activity
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Contribution, ContributionInput } from "./models.js";
import { makeAgent } from "./test-helpers.js";
import type { WorkspaceManager } from "./workspace.js";
import { WorkspaceStatus } from "./workspace.js";

// ---------------------------------------------------------------------------
// Factory type
// ---------------------------------------------------------------------------

export interface WorkspaceTestContext {
  readonly manager: WorkspaceManager;
  /**
   * Create a contribution in the store with the given artifacts in CAS.
   * Returns the contribution (with computed CID).
   * Artifacts are stored as bytes keyed by name.
   */
  readonly createContributionWithArtifacts: (
    artifacts: Record<string, Uint8Array>,
    overrides?: Partial<ContributionInput>,
  ) => Promise<Contribution>;
  /**
   * Create an active claim for the given target ref.
   * Used to test that cleanup is blocked when claim is active.
   */
  readonly createActiveClaim: (targetRef: string) => Promise<void>;
  /** Clean up all resources. */
  readonly cleanup: () => Promise<void>;
}

export type WorkspaceManagerFactory = () => Promise<WorkspaceTestContext>;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

export function runWorkspaceManagerTests(factory: WorkspaceManagerFactory): void {
  let ctx: WorkspaceTestContext;

  beforeEach(async () => {
    ctx = await factory();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // =========================================================================
  // Checkout
  // =========================================================================

  describe("checkout", () => {
    test("creates workspace with materialized artifacts", async () => {
      const artifacts = {
        "report.json": new TextEncoder().encode('{"score": 0.95}'),
        "model.bin": new Uint8Array([1, 2, 3, 4]),
      };
      const contribution = await ctx.createContributionWithArtifacts(artifacts);
      const agent = makeAgent({ agentId: "agent-checkout" });

      const info = await ctx.manager.checkout(contribution.cid, { agent });

      expect(info.cid).toBe(contribution.cid);
      expect(info.agent.agentId).toBe("agent-checkout");
      expect(info.status).toBe(WorkspaceStatus.Active);
      expect(info.workspacePath.length).toBeGreaterThan(0);

      // Verify artifacts were materialized
      const reportFile = Bun.file(`${info.workspacePath}/report.json`);
      const reportContent = await reportFile.text();
      expect(reportContent).toBe('{"score": 0.95}');

      const modelFile = Bun.file(`${info.workspacePath}/model.bin`);
      const modelBytes = new Uint8Array(await modelFile.arrayBuffer());
      expect(modelBytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    });

    test("checkout with no artifacts creates empty workspace", async () => {
      const contribution = await ctx.createContributionWithArtifacts({});
      const agent = makeAgent();

      const info = await ctx.manager.checkout(contribution.cid, { agent });

      expect(info.cid).toBe(contribution.cid);
      expect(info.status).toBe(WorkspaceStatus.Active);
    });

    test("idempotent re-checkout returns existing workspace", async () => {
      const contribution = await ctx.createContributionWithArtifacts({
        "file.txt": new TextEncoder().encode("hello"),
      });
      const agent = makeAgent();

      const first = await ctx.manager.checkout(contribution.cid, { agent });
      const second = await ctx.manager.checkout(contribution.cid, { agent });

      expect(second.cid).toBe(first.cid);
      expect(second.workspacePath).toBe(first.workspacePath);
      expect(second.status).toBe(WorkspaceStatus.Active);
    });

    test("throws for non-existent contribution", async () => {
      const fakeCid = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
      const agent = makeAgent();

      await expect(ctx.manager.checkout(fakeCid, { agent })).rejects.toThrow("not found");
    });

    test("stores context metadata", async () => {
      const contribution = await ctx.createContributionWithArtifacts({});
      const agent = makeAgent();

      const info = await ctx.manager.checkout(contribution.cid, {
        agent,
        context: { purpose: "evaluation", attempt: 3 },
      });

      expect(info.context).toEqual({ purpose: "evaluation", attempt: 3 });
    });
  });

  // =========================================================================
  // Get / List
  // =========================================================================

  describe("getWorkspace", () => {
    test("returns undefined for non-existent workspace", async () => {
      const result = await ctx.manager.getWorkspace(
        "blake3:1111111111111111111111111111111111111111111111111111111111111111",
      );
      expect(result).toBeUndefined();
    });

    test("returns workspace after checkout", async () => {
      const contribution = await ctx.createContributionWithArtifacts({});
      const agent = makeAgent({ agentId: "test-get" });

      await ctx.manager.checkout(contribution.cid, { agent });
      const info = await ctx.manager.getWorkspace(contribution.cid);

      expect(info).toBeDefined();
      expect(info?.cid).toBe(contribution.cid);
      expect(info?.agent.agentId).toBe("test-get");
    });
  });

  describe("listWorkspaces", () => {
    test("returns empty list when no workspaces", async () => {
      const list = await ctx.manager.listWorkspaces();
      expect(list).toHaveLength(0);
    });

    test("lists all workspaces", async () => {
      const c1 = await ctx.createContributionWithArtifacts({});
      const c2 = await ctx.createContributionWithArtifacts({
        "x.txt": new TextEncoder().encode("x"),
      });
      const agent = makeAgent();

      await ctx.manager.checkout(c1.cid, { agent });
      await ctx.manager.checkout(c2.cid, { agent });

      const list = await ctx.manager.listWorkspaces();
      expect(list).toHaveLength(2);
    });

    test("filters by status", async () => {
      const c1 = await ctx.createContributionWithArtifacts({});
      const c2 = await ctx.createContributionWithArtifacts({
        "y.txt": new TextEncoder().encode("y"),
      });
      const agent = makeAgent();

      await ctx.manager.checkout(c1.cid, { agent });
      await ctx.manager.checkout(c2.cid, { agent });
      await ctx.manager.cleanWorkspace(c1.cid);

      const active = await ctx.manager.listWorkspaces({
        status: WorkspaceStatus.Active,
      });
      expect(active).toHaveLength(1);
      expect(active[0]?.cid).toBe(c2.cid);

      const cleaned = await ctx.manager.listWorkspaces({
        status: WorkspaceStatus.Cleaned,
      });
      expect(cleaned).toHaveLength(1);
      expect(cleaned[0]?.cid).toBe(c1.cid);
    });

    test("filters by agent ID", async () => {
      const c1 = await ctx.createContributionWithArtifacts({});
      const c2 = await ctx.createContributionWithArtifacts({
        "z.txt": new TextEncoder().encode("z"),
      });

      await ctx.manager.checkout(c1.cid, {
        agent: makeAgent({ agentId: "alice" }),
      });
      await ctx.manager.checkout(c2.cid, {
        agent: makeAgent({ agentId: "bob" }),
      });

      const aliceWorkspaces = await ctx.manager.listWorkspaces({
        agentId: "alice",
      });
      expect(aliceWorkspaces).toHaveLength(1);
      expect(aliceWorkspaces[0]?.agent.agentId).toBe("alice");
    });

    test("respects limit", async () => {
      const c1 = await ctx.createContributionWithArtifacts({});
      const c2 = await ctx.createContributionWithArtifacts({
        "a.txt": new TextEncoder().encode("a"),
      });
      const agent = makeAgent();

      await ctx.manager.checkout(c1.cid, { agent });
      await ctx.manager.checkout(c2.cid, { agent });

      const limited = await ctx.manager.listWorkspaces({ limit: 1 });
      expect(limited).toHaveLength(1);
    });
  });

  // =========================================================================
  // Cleanup
  // =========================================================================

  describe("cleanWorkspace", () => {
    test("cleans existing workspace", async () => {
      const contribution = await ctx.createContributionWithArtifacts({
        "file.txt": new TextEncoder().encode("data"),
      });
      const agent = makeAgent();

      const info = await ctx.manager.checkout(contribution.cid, { agent });

      const result = await ctx.manager.cleanWorkspace(contribution.cid);
      expect(result).toBe(true);

      // Verify directory is removed
      const file = Bun.file(`${info.workspacePath}/file.txt`);
      expect(await file.exists()).toBe(false);

      // Verify status updated
      const updated = await ctx.manager.getWorkspace(contribution.cid);
      expect(updated).toBeDefined();
      expect(updated?.status).toBe(WorkspaceStatus.Cleaned);
    });

    test("returns false for non-existent workspace", async () => {
      const result = await ctx.manager.cleanWorkspace(
        "blake3:2222222222222222222222222222222222222222222222222222222222222222",
      );
      expect(result).toBe(false);
    });

    test("blocks cleanup when claim is active", async () => {
      const contribution = await ctx.createContributionWithArtifacts({});
      const agent = makeAgent();

      await ctx.manager.checkout(contribution.cid, { agent });
      await ctx.createActiveClaim(contribution.cid);

      await expect(ctx.manager.cleanWorkspace(contribution.cid)).rejects.toThrow("still active");
    });
  });

  // =========================================================================
  // Stale detection
  // =========================================================================

  describe("markStale", () => {
    test("marks idle workspaces as stale", async () => {
      const contribution = await ctx.createContributionWithArtifacts({});
      const agent = makeAgent();

      await ctx.manager.checkout(contribution.cid, { agent });

      // Small delay to ensure the workspace's lastActivityAt is in the past
      await new Promise((r) => setTimeout(r, 20));

      // Mark as stale with very short idle threshold
      const stale = await ctx.manager.markStale({ maxIdleMs: 1 });
      expect(stale).toHaveLength(1);
      expect(stale[0]?.cid).toBe(contribution.cid);
      expect(stale[0]?.status).toBe(WorkspaceStatus.Stale);
    });

    test("does not mark recently active workspaces", async () => {
      const contribution = await ctx.createContributionWithArtifacts({});
      const agent = makeAgent();

      await ctx.manager.checkout(contribution.cid, { agent });

      // Very long idle threshold — nothing should be stale
      const stale = await ctx.manager.markStale({
        maxIdleMs: 24 * 60 * 60 * 1000,
      });
      expect(stale).toHaveLength(0);
    });

    test("only marks active workspaces, not cleaned ones", async () => {
      const c1 = await ctx.createContributionWithArtifacts({});
      const c2 = await ctx.createContributionWithArtifacts({
        "f.txt": new TextEncoder().encode("f"),
      });
      const agent = makeAgent();

      await ctx.manager.checkout(c1.cid, { agent });
      await ctx.manager.checkout(c2.cid, { agent });
      await ctx.manager.cleanWorkspace(c1.cid);

      // Small delay to ensure lastActivityAt is in the past
      await new Promise((r) => setTimeout(r, 20));

      const stale = await ctx.manager.markStale({ maxIdleMs: 1 });
      // Only c2 should be marked stale (c1 is already cleaned)
      expect(stale).toHaveLength(1);
      expect(stale[0]?.cid).toBe(c2.cid);
    });
  });

  // =========================================================================
  // Touch
  // =========================================================================

  describe("touchWorkspace", () => {
    test("updates lastActivityAt", async () => {
      const contribution = await ctx.createContributionWithArtifacts({});
      const agent = makeAgent();

      const initial = await ctx.manager.checkout(contribution.cid, { agent });

      // Small delay to ensure timestamp changes
      await new Promise((r) => setTimeout(r, 10));

      const touched = await ctx.manager.touchWorkspace(contribution.cid);

      expect(touched.lastActivityAt).not.toBe(initial.lastActivityAt);
      expect(new Date(touched.lastActivityAt).getTime()).toBeGreaterThan(
        new Date(initial.lastActivityAt).getTime(),
      );
    });

    test("throws for non-existent workspace", async () => {
      await expect(
        ctx.manager.touchWorkspace(
          "blake3:3333333333333333333333333333333333333333333333333333333333333333",
        ),
      ).rejects.toThrow("not found");
    });
  });
}

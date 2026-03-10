/**
 * Workspace manager tests — implementation-specific + conformance suite.
 *
 * Covers full lifecycle:
 * 1. Create workspace
 * 2. Checkout artifacts
 * 3. Re-checkout idempotency
 * 4. Agent assignment
 * 5. Cleanup
 * 6. Stale detection
 * 7. Active claim blocks cleanup
 * 8. Partial materialization recovery
 * 9. Concurrent operations
 * 10. Hook integration
 */

import { describe, expect, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createContribution } from "../core/manifest.js";
import type { ContributionInput } from "../core/models.js";
import { ContributionKind, ContributionMode } from "../core/models.js";
import { makeAgent } from "../core/test-helpers.js";
import type { WorkspaceTestContext } from "../core/workspace.conformance.js";
import { runWorkspaceManagerTests } from "../core/workspace.conformance.js";
import { WorkspaceStatus } from "../core/workspace.js";
import { FsCas } from "./fs-cas.js";
import { LocalHookRunner } from "./hook-runner.js";
import { initSqliteDb, SqliteClaimStore, SqliteContributionStore } from "./sqlite-store.js";
import { LocalWorkspaceManager } from "./workspace.js";

// ---------------------------------------------------------------------------
// Factory for conformance tests
// ---------------------------------------------------------------------------

async function createTestContext(): Promise<WorkspaceTestContext> {
  const dir = join(tmpdir(), `grove-workspace-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  const dbPath = join(dir, "test.db");
  const casRoot = join(dir, "cas");
  const groveRoot = join(dir, "grove");

  await mkdir(casRoot, { recursive: true });
  await mkdir(groveRoot, { recursive: true });

  const db = initSqliteDb(dbPath);
  const contributionStore = new SqliteContributionStore(db);
  const claimStore = new SqliteClaimStore(db);
  const cas = new FsCas(casRoot);

  const manager = new LocalWorkspaceManager({
    groveRoot,
    db,
    contributionStore,
    cas,
  });

  let artifactCounter = 0;

  return {
    manager,
    createContributionWithArtifacts: async (
      artifacts: Record<string, Uint8Array>,
      overrides?: Partial<ContributionInput>,
    ) => {
      // Store each artifact in CAS and build the artifacts map
      const artifactMap: Record<string, string> = {};
      for (const [name, data] of Object.entries(artifacts)) {
        const hash = await cas.put(data);
        artifactMap[name] = hash;
      }

      // Create unique contribution
      artifactCounter++;
      const input: ContributionInput = {
        kind: ContributionKind.Work,
        mode: ContributionMode.Evaluation,
        summary: `Test contribution ${artifactCounter}`,
        artifacts: artifactMap,
        relations: [],
        tags: [],
        agent: makeAgent(),
        createdAt: new Date(Date.now() + artifactCounter).toISOString(),
        ...overrides,
      };
      const contribution = createContribution(input);
      await contributionStore.put(contribution);
      return contribution;
    },
    createActiveClaim: async (targetRef: string) => {
      const now = new Date();
      const lease = new Date(now.getTime() + 300_000);
      await claimStore.createClaim({
        claimId: `claim-${targetRef}-${Date.now()}`,
        targetRef,
        agent: makeAgent(),
        status: "active" as const,
        intentSummary: "Test claim",
        createdAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        leaseExpiresAt: lease.toISOString(),
      });
    },
    cleanup: async () => {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Conformance suite
// ---------------------------------------------------------------------------

describe("LocalWorkspaceManager conformance", () => {
  runWorkspaceManagerTests(createTestContext);
});

// ---------------------------------------------------------------------------
// Implementation-specific tests
// ---------------------------------------------------------------------------

describe("LocalWorkspaceManager implementation", () => {
  test("workspace directory uses CID hex as name", async () => {
    const ctx = await createTestContext();
    try {
      const contribution = await ctx.createContributionWithArtifacts({});
      const agent = makeAgent();

      const info = await ctx.manager.checkout(contribution.cid, { agent });

      // Path should contain the hex portion of the CID
      const cidHex = contribution.cid.replace("blake3:", "");
      expect(info.workspacePath).toContain(cidHex);
    } finally {
      await ctx.cleanup();
    }
  });

  test("workspace directory is under grove root", async () => {
    const ctx = await createTestContext();
    try {
      const contribution = await ctx.createContributionWithArtifacts({});
      const agent = makeAgent();

      const info = await ctx.manager.checkout(contribution.cid, { agent });

      expect(info.workspacePath).toContain("workspaces");
    } finally {
      await ctx.cleanup();
    }
  });

  test("partial materialization cleans up temp directory", async () => {
    const dir = join(tmpdir(), `grove-workspace-partial-${Date.now()}`);
    await mkdir(dir, { recursive: true });

    const dbPath = join(dir, "test.db");
    const casRoot = join(dir, "cas");
    const groveRoot = join(dir, "grove");

    await mkdir(casRoot, { recursive: true });
    await mkdir(groveRoot, { recursive: true });

    const db = initSqliteDb(dbPath);
    const contributionStore = new SqliteContributionStore(db);
    const cas = new FsCas(casRoot);

    const manager = new LocalWorkspaceManager({
      groveRoot,
      db,
      contributionStore,
      cas,
    });

    try {
      // Create a contribution referencing an artifact that doesn't exist in CAS
      const input: ContributionInput = {
        kind: ContributionKind.Work,
        mode: ContributionMode.Evaluation,
        summary: "Missing artifact test",
        artifacts: {
          "exists.txt": "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        },
        relations: [],
        tags: [],
        agent: makeAgent(),
        createdAt: new Date().toISOString(),
      };
      const contribution = createContribution(input);
      await contributionStore.put(contribution);

      // Checkout should fail because the artifact doesn't exist in CAS
      await expect(manager.checkout(contribution.cid, { agent: makeAgent() })).rejects.toThrow(
        "not found in CAS",
      );

      // Verify no temp directory was left behind
      const workspacesDir = join(groveRoot, "workspaces");
      try {
        const entries = await readdir(workspacesDir);
        // Should have no .tmp directories
        const tmpEntries = entries.filter((e) => e.includes(".tmp."));
        expect(tmpEntries).toHaveLength(0);
      } catch (err) {
        // workspaces dir might not exist at all — that's fine
        if (
          !(
            err instanceof Error &&
            "code" in err &&
            (err as NodeJS.ErrnoException).code === "ENOENT"
          )
        ) {
          throw err;
        }
      }
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("checkout after clean creates fresh workspace", async () => {
    const ctx = await createTestContext();
    try {
      const contribution = await ctx.createContributionWithArtifacts({
        "file.txt": new TextEncoder().encode("original"),
      });
      const agent = makeAgent();

      // First checkout
      const first = await ctx.manager.checkout(contribution.cid, { agent });
      const _firstPath = first.workspacePath;

      // Clean
      await ctx.manager.cleanWorkspace(contribution.cid);

      // Second checkout — should create fresh workspace
      const second = await ctx.manager.checkout(contribution.cid, { agent });

      expect(second.status).toBe(WorkspaceStatus.Active);

      // Verify file is re-materialized
      const file = Bun.file(join(second.workspacePath, "file.txt"));
      expect(await file.text()).toBe("original");
    } finally {
      await ctx.cleanup();
    }
  });

  test("rejects malicious content hash with path traversal", async () => {
    const dir = join(tmpdir(), `grove-workspace-hash-attack-${Date.now()}`);
    await mkdir(dir, { recursive: true });

    const dbPath = join(dir, "test.db");
    const casRoot = join(dir, "cas");
    const groveRoot = join(dir, "grove");

    await mkdir(casRoot, { recursive: true });
    await mkdir(groveRoot, { recursive: true });

    const db = initSqliteDb(dbPath);
    const contributionStore = new SqliteContributionStore(db);
    const cas = new FsCas(casRoot);

    const manager = new LocalWorkspaceManager({
      groveRoot,
      db,
      contributionStore,
      cas,
    });

    try {
      // Directly insert a contribution with a malicious content hash
      // that attempts path traversal via the CAS blob path
      const maliciousHash = "blake3:aa/../../../etc/passwd";
      const input: ContributionInput = {
        kind: ContributionKind.Work,
        mode: ContributionMode.Evaluation,
        summary: "Malicious hash test",
        artifacts: { "payload.txt": maliciousHash },
        relations: [],
        tags: [],
        agent: makeAgent(),
        createdAt: new Date().toISOString(),
      };
      const contribution = createContribution(input);
      await contributionStore.put(contribution);

      // Checkout should reject the malicious hash format
      await expect(manager.checkout(contribution.cid, { agent: makeAgent() })).rejects.toThrow(
        "Invalid content hash format",
      );
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("hooks integration — after_checkout runs", async () => {
    const dir = join(tmpdir(), `grove-workspace-hooks-${Date.now()}`);
    await mkdir(dir, { recursive: true });

    const dbPath = join(dir, "test.db");
    const casRoot = join(dir, "cas");
    const groveRoot = join(dir, "grove");

    await mkdir(casRoot, { recursive: true });
    await mkdir(groveRoot, { recursive: true });

    const db = initSqliteDb(dbPath);
    const contributionStore = new SqliteContributionStore(db);
    const cas = new FsCas(casRoot);
    const hookRunner = new LocalHookRunner({ defaultTimeoutMs: 5000 });

    const manager = new LocalWorkspaceManager({
      groveRoot,
      db,
      contributionStore,
      cas,
      hookRunner,
      hooksConfig: {
        after_checkout: 'echo "hook-ran" > .hook-marker',
      },
    });

    try {
      // Create contribution with an artifact
      const hash = await cas.put(new TextEncoder().encode("data"));
      const input: ContributionInput = {
        kind: ContributionKind.Work,
        mode: ContributionMode.Evaluation,
        summary: "Hook test",
        artifacts: { "data.txt": hash },
        relations: [],
        tags: [],
        agent: makeAgent(),
        createdAt: new Date().toISOString(),
      };
      const contribution = createContribution(input);
      await contributionStore.put(contribution);

      const info = await manager.checkout(contribution.cid, {
        agent: makeAgent(),
      });

      // Verify the hook ran and created the marker file
      const marker = Bun.file(join(info.workspacePath, ".hook-marker"));
      expect(await marker.exists()).toBe(true);
      expect((await marker.text()).trim()).toBe("hook-ran");
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

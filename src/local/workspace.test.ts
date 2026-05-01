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
import { lstat, mkdir, readdir, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HookRunner } from "../core/hooks.js";
import { createContribution } from "../core/manifest.js";
import type { ContributionInput } from "../core/models.js";
import { ContributionKind, ContributionMode } from "../core/models.js";
import { makeAgent } from "../core/test-helpers.js";
import { InMemoryContributionStore } from "../core/testing.js";
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

type LocalWorkspaceTestContext = WorkspaceTestContext & {
  readonly createActiveClaimForAgent: (targetRef: string, agentId: string) => Promise<void>;
  readonly workspacesRoot: string;
};

async function createTestContext(): Promise<LocalWorkspaceTestContext> {
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
  const createActiveClaimForAgent = async (targetRef: string, agentId: string) => {
    const now = new Date();
    const lease = new Date(now.getTime() + 300_000);
    await claimStore.createClaim({
      claimId: `claim-${targetRef}-${agentId}-${Date.now()}`,
      targetRef,
      agent: makeAgent({ agentId }),
      status: "active" as const,
      intentSummary: "Test claim",
      createdAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: lease.toISOString(),
    });
  };

  return {
    manager,
    workspacesRoot: join(groveRoot, "workspaces"),
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
    createActiveClaim: async (targetRef: string) =>
      createActiveClaimForAgent(targetRef, makeAgent().agentId),
    createActiveClaimForAgent,
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
      await ctx.manager.cleanWorkspace(contribution.cid, agent.agentId);

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
    const contributionStore = new InMemoryContributionStore();
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
      const contribution = {
        ...createContribution({ ...input, artifacts: {} }),
        artifacts: input.artifacts,
      };
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

  test("concurrent checkout waits for after_checkout hook completion", async () => {
    const dir = join(tmpdir(), `grove-workspace-hook-race-${Date.now()}`);
    await mkdir(dir, { recursive: true });

    const dbPath = join(dir, "test.db");
    const casRoot = join(dir, "cas");
    const groveRoot = join(dir, "grove");

    await mkdir(casRoot, { recursive: true });
    await mkdir(groveRoot, { recursive: true });

    const db = initSqliteDb(dbPath);
    const contributionStore = new SqliteContributionStore(db);
    const cas = new FsCas(casRoot);

    let releaseHook!: () => void;
    const hookReleased = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    let signalHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolve) => {
      signalHookStarted = resolve;
    });
    const hookRunner: HookRunner = {
      run: async () => {
        signalHookStarted();
        await hookReleased;
        return {
          success: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          command: "test-hook",
          durationMs: 0,
        };
      },
    };

    const manager = new LocalWorkspaceManager({
      groveRoot,
      db,
      contributionStore,
      cas,
      hookRunner,
      hooksConfig: {
        after_checkout: "test-hook",
      },
    });

    try {
      const hash = await cas.put(new TextEncoder().encode("data"));
      const input: ContributionInput = {
        kind: ContributionKind.Work,
        mode: ContributionMode.Evaluation,
        summary: "Hook race test",
        artifacts: { "data.txt": hash },
        relations: [],
        tags: [],
        agent: makeAgent(),
        createdAt: new Date().toISOString(),
      };
      const contribution = createContribution(input);
      await contributionStore.put(contribution);

      const agent = makeAgent({ agentId: "hook-agent" });
      const firstCheckout = manager.checkout(contribution.cid, { agent });
      await hookStarted;

      const secondCheckout = manager.checkout(contribution.cid, { agent });
      const secondState = await Promise.race([
        secondCheckout.then(() => "resolved" as const),
        new Promise<"pending">((resolve) => {
          setTimeout(() => resolve("pending"), 150);
        }),
      ]);

      expect(secondState).toBe("pending");

      releaseHook();

      const [first, second] = await Promise.all([firstCheckout, secondCheckout]);
      expect(first.workspacePath).toBe(second.workspacePath);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("concurrent checkout for the same agent waits for the first materialization", async () => {
    const ctx = await createTestContext();
    const manager = ctx.manager as unknown as {
      casGetToFile: (contentHash: string, destPath: string) => Promise<boolean>;
    };
    const originalCasGetToFile = manager.casGetToFile.bind(ctx.manager);

    let releaseFirstCopy!: () => void;
    const firstCopyReleased = new Promise<void>((resolve) => {
      releaseFirstCopy = resolve;
    });
    let signalFirstCopyStarted!: () => void;
    const firstCopyStarted = new Promise<void>((resolve) => {
      signalFirstCopyStarted = resolve;
    });
    let intercepted = false;

    manager.casGetToFile = async (contentHash: string, destPath: string) => {
      if (!intercepted) {
        intercepted = true;
        signalFirstCopyStarted();
        await firstCopyReleased;
      }
      return originalCasGetToFile(contentHash, destPath);
    };

    try {
      const contribution = await ctx.createContributionWithArtifacts({
        "file.txt": new TextEncoder().encode("data"),
      });
      const agent = makeAgent({ agentId: "shared-agent" });

      const firstCheckout = ctx.manager.checkout(contribution.cid, { agent });
      await firstCopyStarted;

      const secondCheckout = ctx.manager.checkout(contribution.cid, { agent });
      const secondState = await Promise.race([
        secondCheckout.then(() => "resolved" as const),
        new Promise<"pending">((resolve) => {
          setTimeout(() => resolve("pending"), 100);
        }),
      ]);

      expect(secondState).toBe("pending");

      releaseFirstCopy();

      const [first, second] = await Promise.all([firstCheckout, secondCheckout]);
      expect(first.workspacePath).toBe(second.workspacePath);

      const file = Bun.file(join(first.workspacePath, "file.txt"));
      expect(await file.text()).toBe("data");
    } finally {
      manager.casGetToFile = originalCasGetToFile;
      await ctx.cleanup();
    }
  });

  test("checkout recovers from a stale workspace lock owned by a dead process", async () => {
    const ctx = await createTestContext();
    try {
      const contribution = await ctx.createContributionWithArtifacts({
        "file.txt": new TextEncoder().encode("data"),
      });
      const agent = makeAgent({ agentId: "stale-lock-agent" });
      const cidHex = contribution.cid.replace("blake3:", "");
      const workspacePath = join(ctx.workspacesRoot, `${cidHex}-${agent.agentId}`);
      const lockPath = `${workspacePath}.lock`;

      await Bun.write(lockPath, JSON.stringify({ pid: 999_999_999, token: "dead-token" }));

      const info = await ctx.manager.checkout(contribution.cid, { agent });
      const file = Bun.file(join(info.workspacePath, "file.txt"));
      expect(await file.text()).toBe("data");
    } finally {
      await ctx.cleanup();
    }
  });

  test("checkout recovers from a stale workspace lock missing owner metadata", async () => {
    const ctx = await createTestContext();
    try {
      const contribution = await ctx.createContributionWithArtifacts({
        "file.txt": new TextEncoder().encode("data"),
      });
      const agent = makeAgent({ agentId: "missing-owner-agent" });
      const cidHex = contribution.cid.replace("blake3:", "");
      const workspacePath = join(ctx.workspacesRoot, `${cidHex}-${agent.agentId}`);
      const lockPath = `${workspacePath}.lock`;
      const staleTime = new Date(Date.now() - 10 * 60 * 1000);

      await Bun.write(lockPath, "");
      await utimes(lockPath, staleTime, staleTime);

      const info = await ctx.manager.checkout(contribution.cid, { agent });
      const file = Bun.file(join(info.workspacePath, "file.txt"));
      expect(await file.text()).toBe("data");
    } finally {
      await ctx.cleanup();
    }
  });

  test("checkout recreates an active workspace path replaced by a symlink", async () => {
    const ctx = await createTestContext();
    const outsideDir = join(tmpdir(), `grove-workspace-symlink-${Date.now()}`);
    try {
      const contribution = await ctx.createContributionWithArtifacts({
        "file.txt": new TextEncoder().encode("data"),
      });
      const agent = makeAgent({ agentId: "symlink-agent" });

      const first = await ctx.manager.checkout(contribution.cid, { agent });
      await mkdir(outsideDir, { recursive: true });
      await Bun.write(join(outsideDir, "file.txt"), "outside");

      await rm(first.workspacePath, { recursive: true, force: true });
      await symlink(outsideDir, first.workspacePath);

      const second = await ctx.manager.checkout(contribution.cid, { agent });
      const stats = await lstat(second.workspacePath);
      expect(stats.isSymbolicLink()).toBe(false);
      expect(await Bun.file(join(second.workspacePath, "file.txt")).text()).toBe("data");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
      await ctx.cleanup();
    }
  });

  test("createBareWorkspace recreates a missing active directory", async () => {
    const ctx = await createTestContext();
    try {
      const agent = makeAgent({ agentId: "bare-agent" });
      const first = await ctx.manager.createBareWorkspace("spawn-1", { agent });

      await rm(first.workspacePath, { recursive: true, force: true });

      const second = await ctx.manager.createBareWorkspace("spawn-1", { agent });
      await Bun.write(join(second.workspacePath, ".probe"), "ok");
      expect(await Bun.file(join(second.workspacePath, ".probe")).text()).toBe("ok");
    } finally {
      await ctx.cleanup();
    }
  });

  test("createBareWorkspace recreates an active workspace path replaced by a symlink", async () => {
    const ctx = await createTestContext();
    const outsideDir = join(tmpdir(), `grove-bare-workspace-symlink-${Date.now()}`);
    try {
      const agent = makeAgent({ agentId: "bare-symlink-agent" });
      const first = await ctx.manager.createBareWorkspace("spawn-symlink", { agent });
      await mkdir(outsideDir, { recursive: true });
      await Bun.write(join(outsideDir, ".probe"), "outside");

      await rm(first.workspacePath, { recursive: true, force: true });
      await symlink(outsideDir, first.workspacePath);

      const second = await ctx.manager.createBareWorkspace("spawn-symlink", { agent });
      const stats = await lstat(second.workspacePath);
      expect(stats.isSymbolicLink()).toBe(false);
      await Bun.write(join(second.workspacePath, ".probe"), "ok");
      expect(await Bun.file(join(second.workspacePath, ".probe")).text()).toBe("ok");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
      await ctx.cleanup();
    }
  });

  test("cleanup ignores an active claim held by another agent", async () => {
    const ctx = await createTestContext();
    try {
      const contribution = await ctx.createContributionWithArtifacts({
        "file.txt": new TextEncoder().encode("data"),
      });
      const alice = makeAgent({ agentId: "alice" });
      const bob = makeAgent({ agentId: "bob" });

      await ctx.manager.checkout(contribution.cid, { agent: alice });
      const bobWorkspace = await ctx.manager.checkout(contribution.cid, { agent: bob });
      await ctx.createActiveClaimForAgent(contribution.cid, "bob");

      await expect(ctx.manager.cleanWorkspace(contribution.cid, "alice")).resolves.toBe(true);

      const aliceInfo = await ctx.manager.getWorkspace(contribution.cid, "alice");
      expect(aliceInfo?.status).toBe(WorkspaceStatus.Cleaned);

      const bobFile = Bun.file(join(bobWorkspace.workspacePath, "file.txt"));
      expect(await bobFile.text()).toBe("data");
    } finally {
      await ctx.cleanup();
    }
  });
});

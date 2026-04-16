/**
 * E2E test: handoff deadline lifecycle with real stores.
 *
 * Exercises the full flow:
 * 1. Parse contract with reply_timeout_seconds on edges
 * 2. Coder submits work → handoff created with replyDueAt + requiresReply
 * 3. DeadlineWatcher registers timer
 * 4. grove_ack_handoff marks seen/acked
 * 5. Reviewer replies → handoff resolved, timer cancelled
 * 6. Overdue path: no reply → handoff.overdue event fires
 *
 * Uses real SQLite stores — no Nexus needed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeadlineWatcher } from "../../src/core/deadline-watcher.js";
import type { GroveEvent } from "../../src/core/event-bus.js";
import { HandoffStatus } from "../../src/core/handoff.js";
import { LocalEventBus } from "../../src/core/local-event-bus.js";
import { contributeOperation } from "../../src/core/operations/contribute.js";
import type { OperationDeps } from "../../src/core/operations/deps.js";
import { parseGroveContract } from "../../src/core/contract.js";
import { TopologyRouter } from "../../src/core/topology-router.js";
import { initSqliteDb, SqliteContributionStore } from "../../src/local/sqlite-store.js";
import { SqliteHandoffStore } from "../../src/local/sqlite-handoff-store.js";

const CONTRACT_YAML = `---
contract_version: 3
name: deadline-e2e
mode: exploration
agent_topology:
  structure: graph
  roles:
    - name: coder
      edges:
        - target: reviewer
          edge_type: delegates
          reply_timeout_seconds: 30
    - name: reviewer
      edges:
        - target: coder
          edge_type: feedback
---
`;

describe("handoff deadline E2E", () => {
  let tempDir: string;
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    await cleanup?.();
  });

  async function setup() {
    tempDir = await mkdtemp(join(tmpdir(), "grove-deadline-e2e-"));
    const db = initSqliteDb(join(tempDir, "test.db"));
    const contributionStore = new SqliteContributionStore(db);
    const handoffStore = new SqliteHandoffStore(db);
    const bus = new LocalEventBus();

    const contract = parseGroveContract(CONTRACT_YAML);
    expect(contract).toBeDefined();
    const topology = contract!.topology!;

    // Verify edge has replyTimeoutSeconds
    const coderRole = topology.roles.find((r) => r.name === "coder");
    const delegatesEdge = coderRole?.edges?.find((e) => e.target === "reviewer");
    expect(delegatesEdge?.replyTimeoutSeconds).toBe(30);

    const router = new TopologyRouter(topology, bus);
    const watcher = new DeadlineWatcher({ handoffStore, eventBus: bus });

    const deps: OperationDeps = {
      contributionStore,
      handoffStore,
      topologyRouter: router,
      eventBus: bus,
      deadlineWatcher: watcher,
    };

    cleanup = async () => {
      watcher.close();
      bus.close();
      db.close();
      await rm(tempDir, { recursive: true, force: true });
    };

    return { deps, handoffStore, bus, watcher };
  }

  test("coder submit creates handoff with deadline from edge config", async () => {
    const { deps, handoffStore } = await setup();

    const result = await contributeOperation(
      {
        kind: "work",
        summary: "Implement feature",
        agent: { agentId: "coder-1", role: "coder" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Wait for fire-and-forget handoff creation + watcher registration
    await new Promise((r) => setTimeout(r, 100));

    const handoffs = await handoffStore.list();
    expect(handoffs.length).toBeGreaterThanOrEqual(1);

    const h = handoffs.find((h) => h.toRole === "reviewer");
    expect(h).toBeDefined();
    expect(h!.requiresReply).toBe(true);
    expect(h!.replyDueAt).toBeDefined();

    // Verify deadline is ~30s from now (within 5s tolerance)
    const deadline = new Date(h!.replyDueAt!).getTime();
    const expectedDeadline = Date.now() + 30_000;
    expect(Math.abs(deadline - expectedDeadline)).toBeLessThan(5000);
  });

  test("markSeen and markAcked update receipt timestamps", async () => {
    const { deps, handoffStore } = await setup();

    const result = await contributeOperation(
      {
        kind: "work",
        summary: "Implement feature",
        agent: { agentId: "coder-1", role: "coder" },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await new Promise((r) => setTimeout(r, 100));
    const handoffs = await handoffStore.list();
    const h = handoffs.find((h) => h.toRole === "reviewer")!;

    // Mark seen
    await handoffStore.markSeen(h.handoffId);
    const seen = await handoffStore.get(h.handoffId);
    expect(seen?.seenAt).toBeDefined();
    expect(seen?.ackedAt).toBeUndefined();

    // Mark acked
    await handoffStore.markAcked(h.handoffId);
    const acked = await handoffStore.get(h.handoffId);
    expect(acked?.ackedAt).toBeDefined();
    expect(acked?.seenAt).toBe(seen?.seenAt); // preserved original seenAt
  });

  test("reviewer reply resolves handoff and cancels deadline timer", async () => {
    const { deps, handoffStore, watcher } = await setup();

    // Coder submits work
    const workResult = await contributeOperation(
      {
        kind: "work",
        summary: "Implement feature",
        agent: { agentId: "coder-1", role: "coder" },
      },
      deps,
    );
    expect(workResult.ok).toBe(true);
    if (!workResult.ok) return;

    await new Promise((r) => setTimeout(r, 100));

    // Verify timer is registered
    expect(watcher.activeCount).toBeGreaterThanOrEqual(1);

    // Reviewer submits review targeting the work
    const reviewResult = await contributeOperation(
      {
        kind: "review",
        summary: "LGTM",
        scores: { quality: { value: 0.9, direction: "maximize" } },
        relations: [
          { targetCid: workResult.value.cid, relationType: "reviews" },
        ],
        agent: { agentId: "reviewer-1", role: "reviewer" },
      },
      deps,
    );
    expect(reviewResult.ok).toBe(true);

    // Wait for fire-and-forget reply marking + timer cancellation
    await new Promise((r) => setTimeout(r, 200));

    // Handoff should be replied
    const handoffs = await handoffStore.list({ status: HandoffStatus.Replied });
    expect(handoffs.length).toBeGreaterThanOrEqual(1);
    const resolved = handoffs.find((h) => h.toRole === "reviewer");
    expect(resolved?.resolvedByCid).toBe(reviewResult.ok ? reviewResult.value.cid : undefined);

    // Timer should be cancelled
    expect(watcher.activeCount).toBe(0);
  });

  test("overdue handoff emits handoff.overdue event", async () => {
    const { deps, handoffStore, bus } = await setup();

    // Collect events
    const events: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => events.push(e));

    // Create a handoff with a very short deadline (we'll manually create one)
    const h = await handoffStore.create({
      sourceCid: "blake3:test-overdue",
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
      replyDueAt: new Date(Date.now() + 100).toISOString(), // 100ms
    });

    // Register with deadline watcher
    const watcher = new DeadlineWatcher({ handoffStore, eventBus: bus });
    watcher.watch(h);

    // Wait for deadline to pass + timer to fire
    await new Promise((r) => setTimeout(r, 300));

    // Should have emitted handoff.overdue
    const overdueEvents = events.filter((e) => e.type === "handoff.overdue");
    expect(overdueEvents).toHaveLength(1);
    expect(overdueEvents[0]?.payload.handoffId).toBe(h.handoffId);
    expect(overdueEvents[0]?.targetRole).toBe("reviewer");

    watcher.close();
  });

  test("rebuildFromStore skips unscoped SQLite stores (no session scoping)", async () => {
    const { handoffStore, bus } = await setup();

    // Unscoped setup() uses new SqliteHandoffStore(db) without a sessionId.
    // Without session scoping, rebuild must refuse to arm timers since
    // list() would return handoffs from every session in the DB.
    await handoffStore.create({
      sourceCid: "blake3:test-rebuild",
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
      replyDueAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const watcher2 = new DeadlineWatcher({ handoffStore, eventBus: bus });
    const count = await watcher2.rebuildFromStore();

    expect(count).toBe(0);
    expect(watcher2.activeCount).toBe(0);

    watcher2.close();
  });

  test("rebuildFromStore restores timers on scoped SQLite stores", async () => {
    const tempDir2 = await mkdtemp(join(tmpdir(), "grove-scoped-rebuild-"));
    const db = initSqliteDb(join(tempDir2, "test.db"));
    const scoped = new SqliteHandoffStore(db, "session-X");
    const bus = new LocalEventBus();

    try {
      await scoped.create({
        sourceCid: "blake3:test-rebuild",
        fromRole: "coder",
        toRole: "reviewer",
        requiresReply: true,
        replyDueAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const watcher2 = new DeadlineWatcher({ handoffStore: scoped, eventBus: bus });
      const count = await watcher2.rebuildFromStore();

      expect(count).toBe(1);
      expect(watcher2.activeCount).toBe(1);

      watcher2.close();
    } finally {
      bus.close();
      db.close();
      await rm(tempDir2, { recursive: true, force: true });
    }
  });
});

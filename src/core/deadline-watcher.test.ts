/**
 * Tests for DeadlineWatcher — proactive deadline enforcement.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DeadlineWatcher } from "./deadline-watcher.js";
import type { GroveEvent } from "./event-bus.js";
import type { Handoff } from "./handoff.js";
import { HandoffStatus } from "./handoff.js";
import { InMemoryHandoffStore } from "./in-memory-handoff-store.js";
import { LocalEventBus } from "./local-event-bus.js";

/**
 * Poll `check` up to `timeoutMs` (default 2s) with `intervalMs` waits
 * between attempts. Returns once `check` returns truthy or throws if
 * the timeout is hit. Used instead of fixed sleeps in timer tests so
 * slow CI runners don't produce false negatives when the event loop
 * schedules our setTimeout slightly later than the optimistic wait.
 */
async function waitFor(
  check: () => Promise<boolean> | boolean,
  { timeoutMs = 2000, intervalMs = 25 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

function makeHandoff(overrides?: Partial<Handoff>): Handoff {
  return {
    handoffId: crypto.randomUUID(),
    sourceCid: "blake3:test",
    fromRole: "coder",
    toRole: "reviewer",
    status: HandoffStatus.PendingPickup,
    requiresReply: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("DeadlineWatcher", () => {
  let store: InMemoryHandoffStore;
  let bus: LocalEventBus;
  let watcher: DeadlineWatcher;

  beforeEach(() => {
    store = new InMemoryHandoffStore();
    bus = new LocalEventBus();
    watcher = new DeadlineWatcher({ handoffStore: store, eventBus: bus });
  });

  afterEach(() => {
    watcher.close();
    bus.close();
    store.close();
  });

  // ------------------------------------------------------------------
  // watch / cancel
  // ------------------------------------------------------------------

  test("watch registers a timer for handoff with deadline", () => {
    const h = makeHandoff({
      replyDueAt: new Date(Date.now() + 60_000).toISOString(),
    });
    watcher.watch(h);
    expect(watcher.activeCount).toBe(1);
  });

  test("watch is no-op when handoff has no replyDueAt", () => {
    const h = makeHandoff({ replyDueAt: undefined });
    watcher.watch(h);
    expect(watcher.activeCount).toBe(0);
  });

  test("cancel removes the timer", () => {
    const h = makeHandoff({
      replyDueAt: new Date(Date.now() + 60_000).toISOString(),
    });
    watcher.watch(h);
    expect(watcher.activeCount).toBe(1);

    watcher.cancel(h.handoffId);
    expect(watcher.activeCount).toBe(0);
  });

  test("cancel is safe for non-existent handoffId", () => {
    watcher.cancel("nonexistent");
    expect(watcher.activeCount).toBe(0);
  });

  test("watch replaces existing timer for same handoffId", () => {
    const h = makeHandoff({
      replyDueAt: new Date(Date.now() + 60_000).toISOString(),
    });
    watcher.watch(h);
    watcher.watch(h);
    expect(watcher.activeCount).toBe(1);
  });

  // ------------------------------------------------------------------
  // overdue event emission
  // ------------------------------------------------------------------

  test("emits handoff.overdue when deadline passes and handoff still unresolved", async () => {
    // Create a real handoff in the store
    const h = await store.create({
      sourceCid: "blake3:test",
      fromRole: "coder",
      toRole: "reviewer",
      replyDueAt: new Date(Date.now() + 50).toISOString(), // 50ms from now
      requiresReply: true,
    });

    const events: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => events.push(e));

    watcher.watch(h);

    // Wait for the timer to fire
    await new Promise((r) => setTimeout(r, 200));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("handoff.overdue");
    expect(events[0]?.sourceRole).toBe("coder");
    expect(events[0]?.targetRole).toBe("reviewer");
    expect(events[0]?.payload.handoffId).toBe(h.handoffId);
  });

  test("does not emit overdue when handoff is already replied", async () => {
    const h = await store.create({
      sourceCid: "blake3:test",
      fromRole: "coder",
      toRole: "reviewer",
      replyDueAt: new Date(Date.now() + 50).toISOString(),
      requiresReply: true,
    });

    const events: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => events.push(e));

    watcher.watch(h);

    // Resolve the handoff before deadline fires
    await store.markDelivered(h.handoffId);
    await store.markReplied(h.handoffId, "blake3:reply-cid");

    // Wait for the timer
    await new Promise((r) => setTimeout(r, 200));

    // No overdue event because the handoff was resolved
    expect(events).toHaveLength(0);
  });

  test("emits immediately when deadline is already past", async () => {
    const h = await store.create({
      sourceCid: "blake3:test",
      fromRole: "coder",
      toRole: "reviewer",
      replyDueAt: new Date(Date.now() - 1000).toISOString(), // already past
      requiresReply: true,
    });

    const events: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => events.push(e));

    watcher.watch(h);

    await waitFor(() => events.length > 0);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("handoff.overdue");
  });

  test("two watchers on same handoff emit overdue at most once (single-owner)", async () => {
    const h = await store.create({
      sourceCid: "blake3:test",
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
      replyDueAt: new Date(Date.now() + 50).toISOString(),
    });

    const events: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => events.push(e));

    // Two watchers observe the same store — simulates two MCP processes
    const watcher2 = new DeadlineWatcher({ handoffStore: store, eventBus: bus });

    watcher.watch(h);
    watcher2.watch(h);

    // Poll up to 2s for expiry — avoids CI timing flakes where a loaded
    // runner can miss the fixed-duration window between setTimeout fire
    // and expireStale commit.
    await waitFor(
      async () => (await store.get(h.handoffId))?.status === HandoffStatus.Expired,
    );

    // Only ONE overdue event should be emitted — the watcher whose
    // expireStale() CAS flipped the row wins; the other sees empty and
    // skips emission.
    const overdueEvents = events.filter((e) => e.type === "handoff.overdue");
    expect(overdueEvents).toHaveLength(1);
    expect(overdueEvents[0]?.payload.handoffId).toBe(h.handoffId);

    watcher2.close();
  });

  test("late reply is rejected after timer fires (expiry flush)", async () => {
    const h = await store.create({
      sourceCid: "blake3:test",
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
      replyDueAt: new Date(Date.now() + 50).toISOString(),
    });

    watcher.watch(h);

    // Poll for expiry instead of sleeping a fixed duration — under CI
    // load the 50ms deadline + expireStale can take longer than 200ms.
    await waitFor(
      async () => (await store.get(h.handoffId))?.status === HandoffStatus.Expired,
    );

    const afterExpiry = await store.get(h.handoffId);
    expect(afterExpiry?.status).toBe(HandoffStatus.Expired);

    // Late reply attempt must be rejected because the handoff is now expired
    await expect(store.markReplied(h.handoffId, "blake3:reply-cid")).rejects.toThrow();
  });

  // ------------------------------------------------------------------
  // rebuildFromStore
  // ------------------------------------------------------------------

  test("rebuildFromStore re-registers timers for unresolved handoffs", async () => {
    await store.create({
      sourceCid: "blake3:a",
      fromRole: "coder",
      toRole: "reviewer",
      replyDueAt: new Date(Date.now() + 60_000).toISOString(),
      requiresReply: true,
    });
    await store.create({
      sourceCid: "blake3:b",
      fromRole: "coder",
      toRole: "tester",
      replyDueAt: new Date(Date.now() + 60_000).toISOString(),
      requiresReply: true,
    });
    // This one has no deadline — should not get a timer
    await store.create({
      sourceCid: "blake3:c",
      fromRole: "coder",
      toRole: "auditor",
    });

    const registered = await watcher.rebuildFromStore();
    expect(registered).toBe(2);
    expect(watcher.activeCount).toBe(2);
  });

  test("rebuildFromStore skips already-resolved handoffs", async () => {
    const h = await store.create({
      sourceCid: "blake3:a",
      fromRole: "coder",
      toRole: "reviewer",
      replyDueAt: new Date(Date.now() + 60_000).toISOString(),
      requiresReply: true,
    });
    await store.markDelivered(h.handoffId);
    await store.markReplied(h.handoffId, "blake3:reply");

    const registered = await watcher.rebuildFromStore();
    expect(registered).toBe(0);
    expect(watcher.activeCount).toBe(0);
  });

  // ------------------------------------------------------------------
  // close
  // ------------------------------------------------------------------

  test("close cancels all timers", () => {
    const h1 = makeHandoff({
      replyDueAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const h2 = makeHandoff({
      replyDueAt: new Date(Date.now() + 120_000).toISOString(),
    });
    watcher.watch(h1);
    watcher.watch(h2);
    expect(watcher.activeCount).toBe(2);

    watcher.close();
    expect(watcher.activeCount).toBe(0);
  });
});

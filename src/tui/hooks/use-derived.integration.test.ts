/**
 * Integration test for `useDerived`'s subscription contract (PR3 #389).
 *
 * Drives a real `InformerFactory` (local mode) + `WatchHub` and exercises
 * the same handler-attach + recompute path that `useDerived`'s React effect
 * uses. The hook itself can't be mounted under bun:test (no React renderer
 * in this repo), but its `stepDerived` reducer + the `Informer.addEvent` /
 * `Informer.addSync` subscriptions ARE the subscription contract — driving
 * them directly proves the same behavior the spec acceptance asks for:
 *
 *   "Aggregates re-render only when their underlying entities change."
 *   "Smoke tests verify recompute on event from any listed kind."
 */

import { describe, expect, test } from "bun:test";
import { InformerFactory } from "../../core/informer.js";
import type { WatchEntity, WatchKind } from "../../core/watch-events.js";
import { WatchHub } from "../../core/watch-hub.js";
import { stepDerived } from "./use-derived.js";

const NS = "default";

function mkContribution(id: string): WatchEntity {
  return {
    kind: "Contribution",
    namespace: NS,
    id,
    spec: {
      contributionKind: "code",
      mode: "direct",
      summary: id,
      artifacts: {},
      relations: [],
      tags: [],
      agent: { agentId: "a1" },
    },
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: "1",
    metadata: { generation: 1, creationTimestamp: "2026-01-01T00:00:00Z" },
  } as unknown as WatchEntity;
}

function mkClaim(id: string, phase: "active" | "expired" = "active"): WatchEntity {
  return {
    kind: "Claim",
    namespace: NS,
    id,
    spec: {
      targetRef: `t-${id}`,
      agent: { agentId: "a1" },
      intentSummary: "do",
    },
    status: {
      phase,
      persistedPhase: phase,
      heartbeatAt: "2026-01-01T00:00:00Z",
      leaseExpiresAt: "2026-01-01T01:00:00Z",
      attemptCount: 0,
    },
    conditions: [],
    observedGeneration: 0,
    resourceVersion: "1",
    metadata: { generation: 1, creationTimestamp: "2026-01-01T00:00:00Z" },
  } as unknown as WatchEntity;
}

/**
 * Drive a useDerived-style subscription manually: attach event + sync
 * handlers on each kind's Informer, run a `tick` that calls stepDerived
 * with the current snapshot, and return a controller that exposes the
 * latest committed state plus a teardown.
 */
function driveDerived<T>(
  factory: InformerFactory,
  kinds: readonly WatchKind[],
  compute: () => T,
  equals: (a: T, b: T) => boolean = Object.is,
): {
  current: () => { data: T | undefined; error: Error | null };
  commits: number;
  detach: () => void;
} {
  const informers = kinds.map((k) => factory.informerFor(k));
  let state: { data: T | undefined; error: Error | null } = stepDerived<T>(
    { data: undefined, error: null },
    compute,
    equals,
  );
  const ctrl = {
    current: () => state,
    commits: 1,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: replaced below once unsubs are populated.
    detach: () => {},
  };
  const tick = (): void => {
    const next = stepDerived<T>(state, compute, equals);
    if (next.committed) {
      state = { data: next.data, error: next.error };
      ctrl.commits++;
    }
  };
  const unsubs: Array<() => void> = [];
  for (const i of informers) {
    unsubs.push(i.addEventHandler(tick));
    unsubs.push(i.addSyncHandler(tick));
  }
  ctrl.detach = () => {
    for (const u of unsubs) u();
  };
  return ctrl;
}

async function awaitFirstSync(
  factory: InformerFactory,
  kinds: readonly WatchKind[],
): Promise<void> {
  await Promise.all(
    kinds.map(
      (k) =>
        new Promise<void>((resolve) => {
          const informer = factory.informerFor(k);
          if (informer.hasSynced()) {
            resolve();
            return;
          }
          const unsub = informer.addSyncHandler(() => {
            unsub();
            resolve();
          });
        }),
    ),
  );
}

describe("useDerived subscription contract (PR3 #389)", () => {
  test("recomputes on a Contribution event after first sync", async () => {
    const hub = new WatchHub();
    let snapshot: WatchEntity[] = [];
    const factory = new InformerFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => snapshot,
    });
    factory.startAll();
    await awaitFirstSync(factory, ["Contribution"]);

    type Out = { count: number };
    const ctrl = driveDerived<Out>(
      factory,
      ["Contribution"],
      () => ({ count: factory.informerFor("Contribution").list().length }),
      (a, b) => a.count === b.count,
    );

    expect(ctrl.current().data).toEqual({ count: 0 });
    const initialCommits = ctrl.commits;

    snapshot = [mkContribution("c1")];
    hub.recordWrite({
      op: "ADDED",
      kind: "Contribution",
      namespace: NS,
      entity: mkContribution("c1"),
    });
    // Yield a microtask so LocalWatchClient delivers the event to Informer.
    await new Promise((r) => setTimeout(r, 10));

    expect(ctrl.current().data).toEqual({ count: 1 });
    expect(ctrl.commits).toBe(initialCommits + 1);

    ctrl.detach();
    await factory.stopAll();
  });

  test("recomputes on a Claim event when watching multiple kinds", async () => {
    const hub = new WatchHub();
    let snapshot: WatchEntity[] = [];
    const factory = new InformerFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => snapshot,
    });
    factory.startAll();
    await awaitFirstSync(factory, ["Claim", "Contribution"]);

    type Out = { contribs: number; activeClaims: number };
    const ctrl = driveDerived<Out>(
      factory,
      ["Claim", "Contribution"],
      () => ({
        contribs: factory.informerFor("Contribution").list().length,
        activeClaims: factory
          .informerFor("Claim")
          .list()
          .filter((c) => (c.status as { phase: string }).phase === "active").length,
      }),
      (a, b) => a.contribs === b.contribs && a.activeClaims === b.activeClaims,
    );

    expect(ctrl.current().data).toEqual({ contribs: 0, activeClaims: 0 });

    // Publish a Claim — useDerived must recompute even though the changed
    // kind is the second one in the kinds list.
    snapshot = [mkClaim("k1")];
    hub.recordWrite({ op: "ADDED", kind: "Claim", namespace: NS, entity: mkClaim("k1") });
    await new Promise((r) => setTimeout(r, 10));

    expect(ctrl.current().data).toEqual({ contribs: 0, activeClaims: 1 });

    ctrl.detach();
    await factory.stopAll();
  });

  test("equals collapses no-op recomputes (commit count stable)", async () => {
    const hub = new WatchHub();
    let snapshot: WatchEntity[] = [mkContribution("c1")];
    const factory = new InformerFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => snapshot,
    });
    factory.startAll();
    await awaitFirstSync(factory, ["Contribution"]);

    type Out = { count: number };
    const ctrl = driveDerived<Out>(
      factory,
      ["Contribution"],
      () => ({ count: factory.informerFor("Contribution").list().length }),
      (a, b) => a.count === b.count,
    );

    const baseline = ctrl.commits;

    // Modify same id (count stays 1) — equals must collapse the recompute.
    snapshot = [mkContribution("c1")];
    hub.recordWrite({
      op: "MODIFIED",
      kind: "Contribution",
      namespace: NS,
      entity: mkContribution("c1"),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(ctrl.current().data).toEqual({ count: 1 });
    expect(ctrl.commits).toBe(baseline);

    ctrl.detach();
    await factory.stopAll();
  });

  test("compute throw → error captured, last data preserved", async () => {
    const hub = new WatchHub();
    let snapshot: WatchEntity[] = [];
    const factory = new InformerFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => snapshot,
    });
    factory.startAll();
    await awaitFirstSync(factory, ["Contribution"]);

    let shouldThrow = false;
    type Out = { count: number };
    const ctrl = driveDerived<Out>(factory, ["Contribution"], () => {
      if (shouldThrow) throw new Error("boom");
      return { count: factory.informerFor("Contribution").list().length };
    });

    expect(ctrl.current().data).toEqual({ count: 0 });

    shouldThrow = true;
    snapshot = [mkContribution("c1")];
    hub.recordWrite({
      op: "ADDED",
      kind: "Contribution",
      namespace: NS,
      entity: mkContribution("c1"),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(ctrl.current().error?.message).toBe("boom");
    // Last-good data preserved across the throwing recompute.
    expect(ctrl.current().data).toEqual({ count: 0 });

    // Recovery: next clean recompute clears the error.
    shouldThrow = false;
    snapshot = [mkContribution("c1"), mkContribution("c2")];
    hub.recordWrite({
      op: "ADDED",
      kind: "Contribution",
      namespace: NS,
      entity: mkContribution("c2"),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(ctrl.current().error).toBeNull();
    expect(ctrl.current().data).toEqual({ count: 2 });

    ctrl.detach();
    await factory.stopAll();
  });
});

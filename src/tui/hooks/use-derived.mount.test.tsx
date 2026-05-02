/**
 * React-mount smoke test for `useDerived` (PR3 #389).
 *
 * Verifies the actual React effect path — not just the underlying
 * subscription contract (covered by `use-derived.integration.test.ts`).
 * Mounts a minimal consumer component inside an `<InformerProvider>`,
 * publishes events to the WatchHub, and asserts the rendered output
 * advances through React's commit pipeline.
 *
 * Uses `react-test-renderer` because OpenTUI's custom hosts (`<box>`,
 * `<text>`) aren't DOM nodes — react-test-renderer ignores hosts and only
 * renders function/class components, which is exactly what we need to
 * exercise hook semantics.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import { useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { InformerFactory } from "../../core/informer.js";
import type { WatchEntity } from "../../core/watch-events.js";
import { WatchHub } from "../../core/watch-hub.js";
import { InformerProvider } from "./informer-context.js";
import { useDerived } from "./use-derived.js";

// Silences "The current testing environment is not configured to support
// act(...)" — React 19 needs this flag set in any environment that calls
// act() outside of a known framework like Jest. See React 19 RFC.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function mkClaim(id: string): WatchEntity {
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
      phase: "active",
      persistedPhase: "active",
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

interface ProbeProps {
  readonly factory: InformerFactory;
  readonly onState: (count: number, claims: number, hasSynced: boolean) => void;
}

function Probe({ factory: _factory, onState }: ProbeProps): React.ReactNode {
  const derived = useDerived(
    () => {
      const contribs = (_factory.informerFor("Contribution").list() as readonly WatchEntity[])
        .length;
      const claims = (_factory.informerFor("Claim").list() as readonly WatchEntity[]).filter(
        (c) => (c.status as { phase: string }).phase === "active",
      ).length;
      return { contribs, claims };
    },
    ["Claim", "Contribution"],
    (a, b) => a.contribs === b.contribs && a.claims === b.claims,
  );

  // React StrictMode + bun:test sometimes batches; report state via effect so
  // the assertion can observe each commit.
  useEffect(() => {
    onState(derived.data?.contribs ?? -1, derived.data?.claims ?? -1, derived.hasSynced);
  }, [derived.data, derived.hasSynced, onState]);

  return null;
}

async function flushMicrotasks(ms: number = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("useDerived mount + publish (PR3 #389)", () => {
  test("commits on Contribution event from any listed kind", async () => {
    const hub = new WatchHub();
    let snapshot: WatchEntity[] = [];
    const factory = new InformerFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => snapshot,
    });
    factory.startAll();

    const observed: Array<{ contribs: number; claims: number; hasSynced: boolean }> = [];
    const onState = (contribs: number, claims: number, hasSynced: boolean): void => {
      observed.push({ contribs, claims, hasSynced });
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <InformerProvider value={factory}>
            <Probe factory={factory} onState={onState} />
          </InformerProvider>
        ) as React.ReactElement,
      );
      await flushMicrotasks();
    });

    // Initial render observed (count=0).
    expect(observed.length).toBeGreaterThanOrEqual(1);
    const first = observed[0];
    expect(first?.contribs).toBe(0);
    expect(first?.claims).toBe(0);

    // Publish a contribution and let the watch loop deliver it.
    snapshot = [mkContribution("c1")];
    await act(async () => {
      hub.recordWrite({
        op: "ADDED",
        kind: "Contribution",
        namespace: NS,
        entity: mkContribution("c1"),
      });
      await flushMicrotasks(30);
    });

    const last = observed[observed.length - 1];
    expect(last?.contribs).toBe(1);
    expect(last?.claims).toBe(0);

    renderer?.unmount();
    await factory.stopAll();
  });

  test("commits on Claim event from second kind in list", async () => {
    const hub = new WatchHub();
    let snapshot: WatchEntity[] = [];
    const factory = new InformerFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => snapshot,
    });
    factory.startAll();

    const observed: Array<{ contribs: number; claims: number }> = [];
    const onState = (contribs: number, claims: number): void => {
      observed.push({ contribs, claims });
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <InformerProvider value={factory}>
            <Probe factory={factory} onState={onState} />
          </InformerProvider>
        ) as React.ReactElement,
      );
      await flushMicrotasks();
    });

    snapshot = [mkClaim("k1")];
    await act(async () => {
      hub.recordWrite({ op: "ADDED", kind: "Claim", namespace: NS, entity: mkClaim("k1") });
      await flushMicrotasks(30);
    });

    const last = observed[observed.length - 1];
    expect(last?.claims).toBe(1);
    expect(last?.contribs).toBe(0);

    renderer?.unmount();
    await factory.stopAll();
  });

  test("microtask coalescing — N synchronous events trigger ≤1 compute (regression for codex round-10)", async () => {
    // An initial relist dispatches one ADDED per cached entity. Without
    // coalescing, callers like Dashboard/DAG that sort/map the full
    // Contribution cache would perform N full-cache projections per
    // relist, freezing the TUI on large Groves.
    const hub = new WatchHub();
    const snapshot: WatchEntity[] = [];
    const factory = new InformerFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => snapshot,
    });
    factory.startAll();

    let computeCount = 0;
    function CountingProbe({ factory: f }: { factory: InformerFactory }): React.ReactNode {
      useDerived(
        () => {
          computeCount++;
          return (f.informerFor("Contribution").list() as readonly WatchEntity[]).length;
        },
        ["Contribution"],
        Object.is,
      );
      return null;
    }

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <InformerProvider value={factory}>
            <CountingProbe factory={factory} />
          </InformerProvider>
        ) as React.ReactElement,
      );
      await flushMicrotasks();
    });

    const baselineComputes = computeCount;

    // Burst: synchronously dispatch 50 ADDED events in the same stack.
    await act(async () => {
      for (let i = 0; i < 50; i++) {
        snapshot.push(mkContribution(`burst-${i}`));
        hub.recordWrite({
          op: "ADDED",
          kind: "Contribution",
          namespace: NS,
          entity: mkContribution(`burst-${i}`),
        });
      }
      await flushMicrotasks(50);
    });

    // Without coalescing: 50 events → 50 computes. With coalescing: synchronous
    // burst collapses to 1 microtask-deferred recompute. Allow up to a few
    // (test renderer / scheduler ticks may schedule extra microtasks).
    const burstComputes = computeCount - baselineComputes;
    expect(burstComputes).toBeLessThanOrEqual(3);
    expect(burstComputes).toBeGreaterThanOrEqual(1);

    renderer?.unmount();
    await factory.stopAll();
  });

  test("equals collapses no-op recomputes (no extra commit)", async () => {
    const hub = new WatchHub();
    let snapshot: WatchEntity[] = [mkContribution("c1")];
    const factory = new InformerFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => snapshot,
    });
    factory.startAll();

    let commitCount = 0;
    const onState = (): void => {
      commitCount++;
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <InformerProvider value={factory}>
            <Probe factory={factory} onState={onState} />
          </InformerProvider>
        ) as React.ReactElement,
      );
      await flushMicrotasks();
    });

    const baseline = commitCount;

    // Modify same id — count stays at 1, equals must collapse.
    snapshot = [mkContribution("c1")];
    await act(async () => {
      hub.recordWrite({
        op: "MODIFIED",
        kind: "Contribution",
        namespace: NS,
        entity: mkContribution("c1"),
      });
      await flushMicrotasks(30);
    });

    expect(commitCount).toBe(baseline);

    renderer?.unmount();
    await factory.stopAll();
  });
});

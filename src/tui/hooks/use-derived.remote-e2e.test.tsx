/**
 * Remote-mode end-to-end test for `useDerived` (PR3 #389).
 *
 * Stands up an in-process grove-server (Hono `createTestApp`), wires a
 * remote `InformerFactory` against it via a `fetch` shim that routes
 * through `app.fetch`, mounts a React consumer that reads `useDerived`,
 * publishes a real `entity.changed` envelope through the server's watch
 * pipeline, and asserts the projection commits.
 *
 * This is the strongest contract we can verify without a live tmux pty —
 * it exercises:
 *   server.recordWrite → SSE → WatchClient → Informer → useDerived
 *     → React commit
 *
 * which is the exact path PR3's aggregates use in production.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import { useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { contributionToEntity } from "../../core/entity.js";
import { InformerFactory } from "../../core/informer.js";
import { makeContribution } from "../../core/test-helpers.js";
import { createTestApp, TEST_NAMESPACE, TEST_NAMESPACE_KEY } from "../../server/test-helpers.js";
import { EntityStoreFactory } from "../data/entity-store.js";
import { EntityStoreProvider } from "./entity-store-context.js";
import { InformerProvider } from "./informer-context.js";
import { useDerived } from "./use-derived.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface ProbeProps {
  readonly factory: InformerFactory;
  readonly onState: (count: number, hasSynced: boolean) => void;
}

function CountProbe({ factory, onState }: ProbeProps): React.ReactNode {
  const result = useDerived(
    () => factory.informerFor("Contribution").list().length,
    ["Contribution"],
    Object.is,
  );
  useEffect(() => {
    onState(result.data ?? -1, result.hasSynced);
  }, [result.data, result.hasSynced, onState]);
  return null;
}

function makeAppFetch(app: {
  request: (path: string, init?: RequestInit) => Response | Promise<Response>;
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    return await app.request(path, init);
  }) as typeof fetch;
}

async function flush(ms: number = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("useDerived remote E2E (PR3 #389)", () => {
  test("React commit fires on a contribution write through the real server pipeline", async () => {
    const ctx = createTestApp();
    const factory = new InformerFactory({
      mode: "remote",
      baseUrl: "http://test",
      authHeader: `Bearer ${TEST_NAMESPACE_KEY}`,
      fetch: makeAppFetch(ctx.app),
      // Tighter backoff so the test doesn't have to wait the default
      // 100ms minimum between retries on transient errors.
      backoff: { minMs: 5, maxMs: 50, jitter: 0 },
    });
    factory.startAll();

    const observed: Array<{ count: number; hasSynced: boolean }> = [];
    const onState = (count: number, hasSynced: boolean): void => {
      observed.push({ count, hasSynced });
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <InformerProvider value={factory}>
            <EntityStoreProvider value={new EntityStoreFactory(factory)}>
              <CountProbe factory={factory} onState={onState} />
            </EntityStoreProvider>
          </InformerProvider>
        ) as React.ReactElement,
      );
    });
    // Poll OUTSIDE act() so the WatchClient's async fetch + SSE handshake
    // gets uninterrupted scheduler ticks. Inside act() the queued microtasks
    // can starve the network IO under bun's macOS scheduler.
    const syncDeadline = Date.now() + 8000;
    while (Date.now() < syncDeadline) {
      await flush(50);
      if (observed.some((o) => o.count === 0 && o.hasSynced)) break;
    }
    // Ensure any pending React commits flush before the assertion.
    await act(async () => {
      await flush(20);
    });

    // Initial commit reflects the empty server snapshot.
    expect(observed.length).toBeGreaterThanOrEqual(1);
    expect(observed[0]?.count).toBe(0);
    const baseline = observed.length;

    // Write a contribution to the server's store + bump the WatchHub.
    // This mirrors what NexusWatchSubscriber would do for an out-of-band
    // write — exactly what PR3 aggregates rely on for re-render.
    const contribution = makeContribution({ summary: "remote-e2e seed" });
    await ctx.contributionStore.put(contribution);
    ctx.watchHub.recordWrite({
      op: "ADDED",
      kind: "Contribution",
      namespace: TEST_NAMESPACE,
      entity: contributionToEntity(contribution, TEST_NAMESPACE),
    });
    // Same outside-act pattern: let the SSE delivery + Informer dispatch
    // run on the scheduler, then rinse-and-flush React commits.
    const writeDeadline = Date.now() + 8000;
    while (Date.now() < writeDeadline) {
      await flush(50);
      const last = observed[observed.length - 1];
      if (last?.count === 1) break;
    }
    await act(async () => {
      await flush(20);
    });

    const last = observed[observed.length - 1];
    expect(last?.count).toBe(1);
    expect(observed.length).toBeGreaterThan(baseline);

    renderer?.unmount();
    await factory.stopAll();
  });
});

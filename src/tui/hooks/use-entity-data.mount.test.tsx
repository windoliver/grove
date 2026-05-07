/**
 * Mount integration: useEntityData under InformerProvider + EntityStoreProvider.
 * Mirrors use-entities.store-backed.test.tsx setup.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { ContributionEntity } from "../../core/entity.js";
import { InformerFactory } from "../../core/informer.js";
import type { WatchEntity } from "../../core/watch-events.js";
import { WatchHub } from "../../core/watch-hub.js";
import { EntityStoreFactory } from "../data/entity-store.js";
import { EntityStoreProvider } from "./entity-store-context.js";
import { InformerProvider } from "./informer-context.js";
import { useEntityData } from "./use-entity-data.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NS = "default";

/**
 * Test-only subclass: wires the local hub (so hub.recordWrite drives events)
 * but reports mode "remote" so useEntityWatchEnabled gates true.
 * The actual WatchStream used is LocalWatchClient (via the "local" opts);
 * overriding `mode` only affects the hook-level gate, not the transport.
 */
class RemoteReportingLocalFactory extends InformerFactory {
  override get mode(): "remote" | "local" {
    return "remote";
  }
}

function entity(id: string, ts: string): WatchEntity {
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
    } as never,
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: "1",
    metadata: { generation: 1, creationTimestamp: ts },
  };
}

function Probe({ onResult, provider }: { onResult: (r: unknown) => void; provider: unknown }) {
  const r = useEntityData(provider, "Contribution", {
    sort: (a, b) =>
      (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""),
    limit: 2,
    active: true,
  });
  onResult(r);
  return null;
}

describe("useEntityData — mount integration", () => {
  test("informer path: returns sorted+sliced entity snapshot", async () => {
    const hub = new WatchHub();
    const informerFactory = new RemoteReportingLocalFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => [],
    });
    const storeFactory = new EntityStoreFactory(informerFactory);
    const provider = { hasSessionScope: () => false };

    let last: { data: readonly WatchEntity[]; loading: boolean } = {
      data: [],
      loading: true,
    };
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <InformerProvider value={informerFactory} eager>
            <EntityStoreProvider value={storeFactory}>
              <Probe
                provider={provider}
                onResult={(r) => {
                  last = r as typeof last;
                }}
              />
            </EntityStoreProvider>
          </InformerProvider>
        ) as React.ReactElement,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      hub.recordWrite({
        kind: "Contribution",
        namespace: NS,
        op: "ADDED",
        entity: entity("a", "2026-01-01T00:00:00Z"),
      });
      hub.recordWrite({
        kind: "Contribution",
        namespace: NS,
        op: "ADDED",
        entity: entity("b", "2026-01-02T00:00:00Z"),
      });
      hub.recordWrite({
        kind: "Contribution",
        namespace: NS,
        op: "ADDED",
        entity: entity("c", "2026-01-03T00:00:00Z"),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(last.data.map((e) => e.id)).toEqual(["c", "b"]); // sorted desc, limit 2

    renderer?.unmount();
    await informerFactory.stopAll();
    storeFactory.dispose();
  });

  test("polled fallback: when no InformerProvider, calls fetcher", async () => {
    let calls = 0;
    const provider = { hasSessionScope: () => false };

    function PolledProbe({ onResult }: { onResult: (r: unknown) => void }) {
      const r = useEntityData(provider, "Contribution", {
        active: true,
        fallbackFetcher: async () => {
          calls += 1;
          return [entity("p", "2026-01-01T00:00:00Z")] as readonly ContributionEntity[];
        },
      });
      onResult(r);
      return null;
    }

    let last: { data: readonly WatchEntity[]; loading: boolean } = {
      data: [],
      loading: true,
    };
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <PolledProbe
            onResult={(r) => {
              last = r as typeof last;
            }}
          />
        ) as React.ReactElement,
      );
    });
    // Allow the fetcher's microtask to settle.
    await act(async () => {
      await Promise.resolve();
    });

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(last.data.map((e) => e.id)).toEqual(["p"]);

    renderer?.unmount();
  });
});

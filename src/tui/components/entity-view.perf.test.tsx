/**
 * Skipped in CI; runnable locally for the #301 acceptance criterion
 * "500-row list scrolls at 60fps".
 *
 * Mounts EntityView with 500 synthetic entities, performs 100 cursor
 * moves, asserts p95 useMemo+render cost < 16ms.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { ContributionEntity } from "../../core/entity.js";
import { InformerFactory } from "../../core/informer.js";
import type { WatchEntity } from "../../core/watch-events.js";
import { WatchHub } from "../../core/watch-hub.js";
import { EntityStoreFactory } from "../data/entity-store.js";
import { EntityStoreProvider } from "../hooks/entity-store-context.js";
import { InformerProvider } from "../hooks/informer-context.js";
import { EntityView } from "./entity-view.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NS = "default";
const COLUMNS = [
  { header: "ID", key: "id", width: 8, render: (e: ContributionEntity) => e.id },
  {
    header: "SUM",
    key: "sum",
    width: 24,
    render: (e: ContributionEntity) => e.id.repeat(3),
  },
] as const;

function entity(i: number): WatchEntity {
  return {
    kind: "Contribution",
    namespace: NS,
    id: `c${i}`,
    spec: {
      contributionKind: "code",
      mode: "direct",
      summary: `s${i}`,
      artifacts: {},
      relations: [],
      tags: [],
    } as never,
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: String(i),
    metadata: {
      generation: 1,
      creationTimestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
    },
  };
}

const ENABLED = process.env.RUN_PERF === "1";

describe.skipIf(!ENABLED)("EntityView perf", () => {
  test("500 rows × 100 cursor moves: p95 render < 16ms", async () => {
    const hub = new WatchHub();
    // Reuse the RemoteReportingLocalFactory pattern from
    // use-entity-data.mount.test.tsx so useEntityWatchEnabled gates true.
    class RemoteReportingLocalFactory extends InformerFactory {
      override get mode(): "local" | "remote" {
        return "remote";
      }
    }
    const informerFactory = new RemoteReportingLocalFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => [],
    });
    const storeFactory = new EntityStoreFactory(informerFactory);
    const provider = { hasSessionScope: () => false };
    let cursor = 0;
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        (
          <InformerProvider value={informerFactory} eager>
            <EntityStoreProvider value={storeFactory}>
              <EntityView
                kind="Contribution"
                columns={[...COLUMNS]}
                provider={provider}
                active={true}
                cursor={cursor}
                title="Perf"
              />
            </EntityStoreProvider>
          </InformerProvider>
        ) as React.ReactElement,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    for (let i = 0; i < 500; i += 1) {
      TestRenderer.act(() => {
        hub.recordWrite({
          op: "ADDED",
          kind: "Contribution",
          namespace: NS,
          entity: entity(i),
        });
      });
    }

    const samples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      cursor = i;
      const t0 = performance.now();
      await act(async () => {
        renderer.update(
          (
            <InformerProvider value={informerFactory} eager>
              <EntityStoreProvider value={storeFactory}>
                <EntityView
                  kind="Contribution"
                  columns={[...COLUMNS]}
                  provider={provider}
                  active={true}
                  cursor={cursor}
                  title="Perf"
                />
              </EntityStoreProvider>
            </InformerProvider>
          ) as React.ReactElement,
        );
      });
      samples.push(performance.now() - t0);
    }

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    if (p95 === undefined) throw new Error("no samples");
    expect(p95).toBeLessThan(16);
  });
});

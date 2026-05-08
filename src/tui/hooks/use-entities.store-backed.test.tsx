/**
 * Mount-level smoke for useEntities migrated to EntityStore (B1 #296).
 *
 * Mounts a consumer inside both InformerProvider (eager) and
 * EntityStoreProvider, drives writes through a real WatchHub, and asserts
 * the component re-renders with the updated filtered list.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { InformerFactory } from "../../core/informer.js";
import type { WatchEntity } from "../../core/watch-events.js";
import { WatchHub } from "../../core/watch-hub.js";
import { EntityStoreFactory } from "../data/entity-store.js";
import { EntityStoreProvider } from "./entity-store-context.js";
import { InformerProvider } from "./informer-context.js";
import { useEntities } from "./use-entities.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NS = "default";

function entity(id: string): WatchEntity {
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
    metadata: { generation: 1 },
  };
}

function Probe({
  onResult,
}: {
  onResult: (data: readonly WatchEntity[]) => void;
}): React.ReactNode {
  const { data } = useEntities("Contribution");
  onResult(data);
  return null;
}

describe("useEntities — store-backed mount smoke", () => {
  test("re-renders with new entities as WatchHub events flow", async () => {
    const hub = new WatchHub();
    const informerFactory = new InformerFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => [],
    });
    const storeFactory = new EntityStoreFactory(informerFactory);

    let lastData: readonly WatchEntity[] = [];
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <InformerProvider value={informerFactory} eager>
            <EntityStoreProvider value={storeFactory}>
              <Probe
                onResult={(d) => {
                  lastData = d;
                }}
              />
            </EntityStoreProvider>
          </InformerProvider>
        ) as React.ReactElement,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(lastData.length).toBe(0);

    await act(async () => {
      hub.recordWrite({
        kind: "Contribution",
        namespace: NS,
        op: "ADDED",
        entity: entity("c1"),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(lastData.length).toBe(1);
    expect(lastData[0]?.id).toBe("c1");

    renderer?.unmount();
    await informerFactory.stopAll();
    storeFactory.dispose();
  });
});

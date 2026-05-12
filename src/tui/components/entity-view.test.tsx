/**
 * Mount tests for EntityView: header, empty state, row mapping, onSelect.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { InformerFactory } from "../../core/informer.js";
import type { WatchEntity } from "../../core/watch-events.js";
import { WatchHub } from "../../core/watch-hub.js";
import { EntityStoreFactory } from "../data/entity-store.js";
import { EntityStoreProvider } from "../hooks/entity-store-context.js";
import { InformerProvider } from "../hooks/informer-context.js";
import { EntityView } from "./entity-view.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NS = "default";

/**
 * Test-only subclass: wires the local hub (so hub.recordWrite drives events)
 * but reports mode "remote" so useEntityWatchEnabled gates true.
 */
class RemoteReportingLocalFactory extends InformerFactory {
  override get mode(): "remote" | "local" {
    return "remote";
  }
}

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
    metadata: { generation: 1, creationTimestamp: "2026-01-01T00:00:00Z" },
  };
}

const COLUMNS = [{ header: "ID", key: "id", width: 8, render: (e: WatchEntity) => e.id }] as const;

describe("EntityView", () => {
  test("renders empty state when no data", async () => {
    const hub = new WatchHub();
    const informerFactory = new RemoteReportingLocalFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => [],
    });
    const storeFactory = new EntityStoreFactory(informerFactory);
    const provider = { hasSessionScope: () => false };

    let renderer!: TestRenderer.ReactTestRenderer;
    // Use async act to allow the LocalWatchClient relist to complete (RELIST_BEGIN → RELIST_END).
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
                cursor={-1}
                title="TestView"
                emptyTitle="(none)"
              />
            </EntityStoreProvider>
          </InformerProvider>
        ) as React.ReactElement,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("(none)");

    renderer.unmount();
    await informerFactory.stopAll();
    storeFactory.dispose();
  });

  test("renders title and rows when data present", async () => {
    const hub = new WatchHub();
    const informerFactory = new RemoteReportingLocalFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => [],
    });
    const storeFactory = new EntityStoreFactory(informerFactory);
    const provider = { hasSessionScope: () => false };

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
                cursor={-1}
                title="TestView"
                emptyTitle="(none)"
              />
            </EntityStoreProvider>
          </InformerProvider>
        ) as React.ReactElement,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      hub.recordWrite({ kind: "Contribution", namespace: NS, op: "ADDED", entity: entity("a") });
      hub.recordWrite({ kind: "Contribution", namespace: NS, op: "ADDED", entity: entity("b") });
      await Promise.resolve();
      await Promise.resolve();
    });

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("TestView");
    expect(flat).toContain("a");
    expect(flat).toContain("b");

    renderer.unmount();
    await informerFactory.stopAll();
    storeFactory.dispose();
  });

  test("onSelect fires with entity at cursor", async () => {
    const hub = new WatchHub();
    const informerFactory = new RemoteReportingLocalFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => [],
    });
    const storeFactory = new EntityStoreFactory(informerFactory);
    const provider = { hasSessionScope: () => false };

    let selected: WatchEntity | undefined;

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
                cursor={1}
                onSelect={(e) => {
                  selected = e as WatchEntity | undefined;
                }}
                title="TestView"
                emptyTitle="(none)"
              />
            </EntityStoreProvider>
          </InformerProvider>
        ) as React.ReactElement,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      hub.recordWrite({ kind: "Contribution", namespace: NS, op: "ADDED", entity: entity("a") });
      hub.recordWrite({ kind: "Contribution", namespace: NS, op: "ADDED", entity: entity("b") });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(selected?.id).toBeDefined();

    renderer.unmount();
    await informerFactory.stopAll();
    storeFactory.dispose();
  });

  test("onDataChanged fires with current entity slice", async () => {
    const hub = new WatchHub();
    const factory = new RemoteReportingLocalFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: () => [],
    });
    const storeFactory = new EntityStoreFactory(factory);

    let received: readonly WatchEntity[] = [];

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <InformerProvider value={factory} eager>
            <EntityStoreProvider value={storeFactory}>
              <EntityView
                kind="Contribution"
                columns={[...COLUMNS]}
                provider={{ hasSessionScope: () => false }}
                active={true}
                cursor={-1}
                onDataChanged={(d) => {
                  received = d as readonly WatchEntity[];
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
      hub.recordWrite({ kind: "Contribution", namespace: NS, op: "ADDED", entity: entity("x") });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(received.map((e) => e.id)).toEqual(["x"]);

    renderer.unmount();
    await factory.stopAll();
    storeFactory.dispose();
  });
});

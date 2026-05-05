/**
 * EntityStoreProvider + useEntityStoreOptional unit tests (B1 #296).
 */

import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { InformerFactory } from "../../core/informer.js";
import { WatchHub } from "../../core/watch-hub.js";
import { EntityStoreFactory } from "../data/entity-store.js";
import { EntityStoreProvider, useEntityStoreOptional } from "./entity-store-context.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeFactory(): EntityStoreFactory {
  return new EntityStoreFactory(
    new InformerFactory({
      mode: "local",
      hub: new WatchHub(),
      namespace: "default",
      listFn: () => [],
    }),
  );
}

function Probe({
  onStore,
  kind,
}: {
  onStore: (s: unknown) => void;
  kind: "Contribution";
}): ReactNode {
  const store = useEntityStoreOptional(kind);
  onStore(store);
  return null;
}

describe("EntityStoreProvider", () => {
  test("supplies a factory-backed store to consumers", async () => {
    const factory = makeFactory();
    let store: unknown;
    await act(async () => {
      TestRenderer.create(
        (
          <EntityStoreProvider value={factory}>
            <Probe
              onStore={(s) => {
                store = s;
              }}
              kind="Contribution"
            />
          </EntityStoreProvider>
        ) as ReactElement,
      );
    });
    expect(store).toBeDefined();
    expect((store as { hasSynced: () => boolean }).hasSynced).toBeDefined();
  });

  test("no provider → returns a no-op store with empty list and hasSynced=false", async () => {
    let store: unknown;
    await act(async () => {
      TestRenderer.create(
        (
          <Probe
            onStore={(s) => {
              store = s;
            }}
            kind="Contribution"
          />
        ) as ReactElement,
      );
    });
    const s = store as {
      list: () => readonly unknown[];
      hasSynced: () => boolean;
      subscribe: (fn: () => void) => () => void;
    };
    expect(s.list()).toEqual([]);
    expect(s.hasSynced()).toBe(false);
    const unsub = s.subscribe(() => {
      throw new Error("should never fire");
    });
    expect(typeof unsub).toBe("function");
    unsub();
  });
});

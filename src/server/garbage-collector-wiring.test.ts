import { describe, expect, test } from "bun:test";
import { GarbageCollector } from "../core/garbage-collector.js";
import { InMemoryGcStore } from "../core/in-memory-gc-store.js";
import {
  createGarbageCollectorWiring,
  garbageCollectorEnabled,
} from "./garbage-collector-wiring.js";

describe("garbage-collector-wiring", () => {
  test("enabled by default, disabled by GROVE_GC=0", () => {
    expect(garbageCollectorEnabled({})).toBe(true);
    expect(garbageCollectorEnabled({ GROVE_GC: "0" })).toBe(false);
    expect(garbageCollectorEnabled({ GROVE_GC: "1" })).toBe(true);
  });

  test("constructs a GarbageCollector over the supplied store", () => {
    const wiring = createGarbageCollectorWiring({ store: new InMemoryGcStore(), workerCount: 2 });
    expect(wiring.collector).toBeInstanceOf(GarbageCollector);
  });

  test("accepts and forwards onAction to the GarbageCollector without throwing", () => {
    const onAction = () => {
      /* spy placeholder */
    };
    const wiring = createGarbageCollectorWiring({
      store: new InMemoryGcStore(),
      onAction,
    });
    expect(wiring.collector).toBeInstanceOf(GarbageCollector);
  });
});

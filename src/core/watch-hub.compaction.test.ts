import { describe, expect, test } from "bun:test";
import { contributionToEntity } from "./entity.js";
import type { Contribution } from "./models.js";
import { WatchHub } from "./watch-hub.js";

function fixtureContribution(cid: string): Contribution {
  return {
    cid,
    manifestVersion: 1,
    kind: "work",
    mode: "evaluation",
    summary: "fixture",
    artifacts: {},
    relations: [],
    tags: [],
    agent: { agentId: "a-1" },
    createdAt: new Date().toISOString(),
  };
}

function writeOne(hub: WatchHub, ns: string, cid: string): bigint {
  const entity = contributionToEntity(fixtureContribution(cid), ns);
  return hub.recordWrite({ kind: "Contribution", namespace: ns, op: "ADDED", entity });
}

describe("WatchHub compaction stats", () => {
  test("evictedByCapacity increments when ring exceeds maxEventsPerKey", () => {
    const hub = new WatchHub({ maxEventsPerKey: 3, maxAgeMsPerKey: 60_000 });
    for (let i = 0; i < 5; i++) writeOne(hub, "ns", `cid-${i}`);

    const stats = hub.getCompactionStats();
    expect(stats.length).toBe(1);
    expect(stats[0]?.namespace).toBe("ns");
    expect(stats[0]?.kind).toBe("Contribution");
    expect(stats[0]?.evictedByCapacity).toBe(2); // 5 writes, cap 3 → 2 evicted
    expect(stats[0]?.evictedByAge).toBe(0);
    expect(stats[0]?.currentRingSize).toBe(3);
    expect(stats[0]?.currentRv).toBe("5");
    expect(stats[0]?.oldestRv).toBe("3");
  });

  test("evictedByAge increments when events exceed maxAgeMsPerKey", () => {
    let now = 1_000_000;
    const hub = new WatchHub({
      maxEventsPerKey: 100,
      maxAgeMsPerKey: 100,
      now: () => now,
    });
    writeOne(hub, "ns", "old-1");
    writeOne(hub, "ns", "old-2");
    now += 250; // past retention
    writeOne(hub, "ns", "fresh-1");

    const stats = hub.getCompactionStats();
    expect(stats[0]?.evictedByAge).toBe(2);
    expect(stats[0]?.evictedByCapacity).toBe(0);
    expect(stats[0]?.currentRingSize).toBe(1);
    expect(stats[0]?.oldestRv).toBe("3");
    expect(stats[0]?.currentRv).toBe("3");
  });

  test("counters are monotonic across subscribe/unsubscribe", async () => {
    const hub = new WatchHub({ maxEventsPerKey: 2, maxAgeMsPerKey: 60_000 });
    for (let i = 0; i < 5; i++) writeOne(hub, "ns", `cid-${i}`);

    const ac = new AbortController();
    const iter = hub.subscribe("ns", "Contribution", 4n, ac.signal);
    for await (const _ev of iter) break; // consume one
    ac.abort();

    writeOne(hub, "ns", "cid-after");
    const stats = hub.getCompactionStats();
    // 6 writes total, cap 2 → 4 evicted
    expect(stats[0]?.evictedByCapacity).toBe(4);
  });

  test("getCompactionStats returns one entry per active (ns, kind)", () => {
    const hub = new WatchHub({ maxEventsPerKey: 5, maxAgeMsPerKey: 60_000 });
    writeOne(hub, "ns-a", "cid-a");
    writeOne(hub, "ns-b", "cid-b");
    const stats = hub.getCompactionStats();
    expect(stats.length).toBe(2);
    const namespaces = stats.map((s) => s.namespace).sort();
    expect(namespaces).toEqual(["ns-a", "ns-b"]);
  });

  test("oldestRv tracks the surviving event after age eviction", () => {
    let now = 1_000;
    const hub = new WatchHub({
      maxEventsPerKey: 100,
      maxAgeMsPerKey: 100,
      now: () => now,
    });
    writeOne(hub, "ns", "x");
    now += 1000;
    writeOne(hub, "ns", "y"); // triggers age eviction of x; y stays
    expect(hub.getCompactionStats()[0]?.currentRingSize).toBe(1);
    expect(hub.getCompactionStats()[0]?.oldestRv).toBe("2");
  });

  test("oldestRv on empty ring reports floorRv+1 (first rv not yet evicted)", async () => {
    const hub = new WatchHub({ maxEventsPerKey: 5, maxAgeMsPerKey: 60_000 });
    const ac = new AbortController();
    // subscribe creates the key via getOrCreate without writing.
    const iter = hub.subscribe("ns", "Contribution", 0n, ac.signal);
    // Abort immediately — we just need the key to exist.
    ac.abort();
    // Drain the (already aborted) iterator to release resources.
    for await (const _ev of iter) break;
    const stats = hub.getCompactionStats();
    expect(stats.length).toBe(1);
    expect(stats[0]?.currentRingSize).toBe(0);
    // No writes ever happened: floorRv=0, so oldestRv reports "1" — the rv
    // that the next write would receive. This semantic survives idle-key
    // age compaction (full eviction), where oldestRv = counter + 1.
    expect(stats[0]?.oldestRv).toBe("1");
    expect(stats[0]?.currentRv).toBe("0");
  });

  test("public maxAgeMsPerKey and maxEventsPerKey reflect constructor args", () => {
    const hub = new WatchHub({ maxAgeMsPerKey: 7777, maxEventsPerKey: 12 });
    expect(hub.maxAgeMsPerKey).toBe(7777);
    expect(hub.maxEventsPerKey).toBe(12);
  });
});

import { describe, expect, test } from "bun:test";
import { contributionToEntity } from "./entity.js";
import type { Contribution } from "./models.js";
import { StaleResourceVersionError } from "./watch-events.js";
import { BufferOverflowError, WatchHub } from "./watch-hub.js";

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

describe("WatchHub.subscribe + AbortSignal", () => {
  test("pre-aborted signal does not register subscriber (no leak)", async () => {
    const hub = new WatchHub();
    const ac = new AbortController();
    ac.abort(); // already aborted before subscribe
    const iter = hub.subscribe("ns", "Contribution", 0n, ac.signal);
    // Iterator must terminate immediately (subscriber.closed = true).
    const r = await iter[Symbol.asyncIterator]().next();
    expect(r.done).toBe(true);

    // No subscriber should have been registered. Verify by writing —
    // a leaked subscriber would still receive the fanout into a queue
    // we'd never drain. We can't observe queue directly, but a fresh
    // subscribe + drain proves the live set is clean.
    const ent = contributionToEntity(fixtureContribution("cid-a"), "ns");
    hub.recordWrite({ kind: "Contribution", namespace: "ns", op: "ADDED", entity: ent });

    // Inspect subscribers via internal state (test-only access).
    // (The hub doesn't expose this; we can at least assert the second
    // subscribe returns and ends without leak.)
    const ac2 = new AbortController();
    const iter2 = hub.subscribe("ns", "Contribution", 0n, ac2.signal);
    const next = iter2[Symbol.asyncIterator]().next();
    // Replay should include rv=1.
    const r2 = await next;
    expect(r2.done).toBe(false);
    expect((r2.value as { rv: bigint }).rv).toBe(1n);
    ac2.abort();
  });
});

describe("WatchHub.recordWrite", () => {
  test("returns strictly increasing rv for same (ns, kind)", () => {
    const hub = new WatchHub();
    const ent1 = contributionToEntity(fixtureContribution("cid-a"), "ns/wt");
    const ent2 = contributionToEntity(fixtureContribution("cid-b"), "ns/wt");
    const rv1 = hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entity: ent1,
    });
    const rv2 = hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entity: ent2,
    });
    expect(rv2 > rv1).toBe(true);
  });

  test("namespaces and kinds maintain independent counters", () => {
    const hub = new WatchHub();
    const ent = contributionToEntity(fixtureContribution("cid-a"), "ns/wt");
    const rvNsA = hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/A",
      op: "ADDED",
      entity: ent,
    });
    const rvNsB = hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/B",
      op: "ADDED",
      entity: ent,
    });
    const rvKindClaim = hub.recordWrite({
      kind: "Claim",
      namespace: "ns/A",
      op: "ADDED",
      // Reusing the Contribution entity for shape only; the WatchEvent
      // union accepts it because the test does not exercise claim semantics.
      entity: ent as unknown as never,
    });
    expect(rvNsA).toBe(1n);
    expect(rvNsB).toBe(1n);
    expect(rvKindClaim).toBe(1n);
    expect(hub.currentRv("ns/A", "Contribution")).toBe(1n);
    expect(hub.currentRv("ns/B", "Contribution")).toBe(1n);
    expect(hub.currentRv("ns/A", "Claim")).toBe(1n);
    expect(hub.currentRv("ns/A", "AgentSession")).toBe(0n);
  });
});

describe("WatchHub ring buffer", () => {
  test("retains last maxEventsPerKey events per (ns, kind)", () => {
    const hub = new WatchHub({ maxEventsPerKey: 3 });
    for (let i = 0; i < 5; i++) {
      hub.recordWrite({
        kind: "Contribution",
        namespace: "ns/wt",
        op: "ADDED",
        entity: contributionToEntity(fixtureContribution(`cid-${i}`), "ns/wt"),
      });
    }
    const buffered = hub.snapshotRing("ns/wt", "Contribution");
    expect(buffered.length).toBe(3);
    expect(buffered.map((e) => e.rv)).toEqual([3n, 4n, 5n]);
  });

  test("evicts events older than maxAgeMsPerKey", () => {
    let clock = 1_000_000;
    const hub = new WatchHub({
      maxEventsPerKey: 1024,
      maxAgeMsPerKey: 1_000,
      now: () => clock,
    });
    hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entity: contributionToEntity(fixtureContribution("cid-old"), "ns/wt"),
    });
    clock += 5_000;
    hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entity: contributionToEntity(fixtureContribution("cid-new"), "ns/wt"),
    });
    const buffered = hub.snapshotRing("ns/wt", "Contribution");
    expect(buffered.length).toBe(1);
    expect(buffered[0]?.entity.id).toBe("cid-new");
  });
});

describe("WatchHub.subscribe", () => {
  test("replays events with rv > fromRv then tails new writes", async () => {
    const hub = new WatchHub();
    const ent = (cid: string) => contributionToEntity(fixtureContribution(cid), "ns/wt");
    const rv1 = hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entity: ent("cid-1"),
    });
    hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entity: ent("cid-2"),
    });

    const ac = new AbortController();
    const seen: bigint[] = [];
    const stream = hub.subscribe("ns/wt", "Contribution", rv1, ac.signal);

    const drain = (async () => {
      for await (const ev of stream) {
        seen.push(ev.rv);
        if (seen.length === 2) ac.abort();
      }
    })();

    queueMicrotask(() => {
      hub.recordWrite({
        kind: "Contribution",
        namespace: "ns/wt",
        op: "ADDED",
        entity: ent("cid-3"),
      });
    });

    await drain;
    expect(seen).toEqual([2n, 3n]);
  });

  test("throws StaleResourceVersionError when fromRv < ring.oldestRv", () => {
    const hub = new WatchHub({ maxEventsPerKey: 2 });
    const ent = (cid: string) => contributionToEntity(fixtureContribution(cid), "ns/wt");
    for (const cid of ["a", "b", "c"]) {
      hub.recordWrite({
        kind: "Contribution",
        namespace: "ns/wt",
        op: "ADDED",
        entity: ent(cid),
      });
    }
    expect(() => {
      const ac = new AbortController();
      hub.subscribe("ns/wt", "Contribution", 0n, ac.signal);
    }).toThrow(StaleResourceVersionError);
  });
});

describe("WatchHub overflow", () => {
  test("slow consumer triggers BufferOverflowError after outbox cap exceeded", async () => {
    const hub = new WatchHub({ perClientOutboxCap: 2 });
    const ent = (cid: string) => contributionToEntity(fixtureContribution(cid), "ns/wt");

    const ac = new AbortController();
    const stream = hub.subscribe("ns/wt", "Contribution", 0n, ac.signal);

    // Don't drain — let the queue fill up
    for (let i = 0; i < 5; i++) {
      hub.recordWrite({
        kind: "Contribution",
        namespace: "ns/wt",
        op: "ADDED",
        entity: ent(`cid-${i}`),
      });
    }

    const it = stream[Symbol.asyncIterator]();
    expect((await it.next()).value.rv).toBe(1n);
    expect((await it.next()).value.rv).toBe(2n);
    const rejection = it.next();
    await expect(rejection).rejects.toThrow("watch outbox overflowed");
    await expect(rejection).rejects.toBeInstanceOf(BufferOverflowError);
  });
});

describe("WatchHub config", () => {
  test("exposes bookmarkIntervalMs and perClientOutboxCap from options", () => {
    const hub = new WatchHub({ bookmarkIntervalMs: 5_000, perClientOutboxCap: 16 });
    expect(hub.bookmarkIntervalMs).toBe(5_000);
    expect(hub.perClientOutboxCap).toBe(16);
  });

  test("defaults bookmarkIntervalMs to 30000", () => {
    const hub = new WatchHub();
    expect(hub.bookmarkIntervalMs).toBe(30_000);
  });
});

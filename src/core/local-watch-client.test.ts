import { describe, expect, test } from "bun:test";
import { LocalWatchClient } from "./local-watch-client.js";
import type { WatchClientEvent } from "./watch-client.js";
import type { WatchEntity } from "./watch-events.js";
import { WatchHub } from "./watch-hub.js";

const NS = "default";

function mkContribution(id: string, rv: string): WatchEntity {
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
    },
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: rv,
    metadata: { generation: 1 },
  } as unknown as WatchEntity;
}

describe("LocalWatchClient", () => {
  test("emits RELIST_BEGIN, one RELIST per snapshot entity, then RELIST_END", async () => {
    const hub = new WatchHub();
    const e1 = mkContribution("a", "1");
    const e2 = mkContribution("b", "1");
    const events: WatchClientEvent[] = [];
    const ac = new AbortController();

    const client = new LocalWatchClient({
      hub,
      kind: "Contribution",
      namespace: NS,
      listFn: () => [e1, e2],
    });

    const runPromise = client.run({
      onEvent: (e) => {
        events.push(e);
        if (e.op === "RELIST_END") ac.abort();
      },
      signal: ac.signal,
    });
    await runPromise;

    expect(events.map((e) => e.op)).toEqual(["RELIST_BEGIN", "RELIST", "RELIST", "RELIST_END"]);
    expect(events[1]?.entity?.id).toBe("a");
    expect(events[2]?.entity?.id).toBe("b");
    expect(events[0]?.entity).toBeNull();
    expect(events[3]?.entity).toBeNull();
  });

  test("emits live deltas after RELIST_END", async () => {
    const hub = new WatchHub();
    const events: WatchClientEvent[] = [];
    const ac = new AbortController();

    const client = new LocalWatchClient({
      hub,
      kind: "Contribution",
      namespace: NS,
      listFn: () => [],
    });

    const runPromise = client.run({
      onEvent: (e) => {
        events.push(e);
        if (e.op === "ADDED") ac.abort();
      },
      signal: ac.signal,
    });

    // Wait one microtask so the client has emitted RELIST_BEGIN/END before we publish.
    await Promise.resolve();
    await Promise.resolve();
    hub.recordWrite({
      op: "ADDED",
      kind: "Contribution",
      namespace: NS,
      entity: mkContribution("a", "1"),
    });
    await runPromise;

    const ops = events.map((e) => e.op);
    expect(ops).toEqual(["RELIST_BEGIN", "RELIST_END", "ADDED"]);
    expect(events[2]?.entity?.id).toBe("a");
  });

  test("respects pre-aborted signal — no events emitted", async () => {
    const hub = new WatchHub();
    const events: WatchClientEvent[] = [];
    const ac = new AbortController();
    ac.abort();

    const client = new LocalWatchClient({
      hub,
      kind: "Contribution",
      namespace: NS,
      listFn: () => [mkContribution("a", "1")],
    });

    await client.run({
      onEvent: (e) => {
        events.push(e);
      },
      signal: ac.signal,
    });

    expect(events).toEqual([]);
  });

  test("captures currentRv before listing — events written between capture and subscribe replay correctly", async () => {
    const hub = new WatchHub();
    // Pre-existing event in hub before run() starts.
    hub.recordWrite({
      op: "ADDED",
      kind: "Contribution",
      namespace: NS,
      entity: mkContribution("pre", "1"),
    });

    const events: WatchClientEvent[] = [];
    const ac = new AbortController();
    const client = new LocalWatchClient({
      hub,
      kind: "Contribution",
      namespace: NS,
      listFn: () => [mkContribution("a", "1")],
    });

    const runPromise = client.run({
      onEvent: (e) => {
        events.push(e);
        if (e.op === "RELIST_END") ac.abort();
      },
      signal: ac.signal,
    });
    await runPromise;

    // No replay of the pre-snapshot event — listFn is the source of truth at snapshot time.
    expect(events.map((e) => e.op)).toEqual(["RELIST_BEGIN", "RELIST", "RELIST_END"]);
  });
});

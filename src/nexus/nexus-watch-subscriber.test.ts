import { describe, expect, test } from "bun:test";
import type { ContributionEntity } from "../core/entity.js";
import { LocalEventBus } from "../core/local-event-bus.js";
import type { WatchEntity } from "../core/watch-events.js";
import { WatchHub } from "../core/watch-hub.js";
import { NexusWatchPublisher } from "./nexus-watch-publisher.js";
import { NexusWatchSubscriber } from "./nexus-watch-subscriber.js";

function fakeContributionEntity(id: string, namespace: string): ContributionEntity {
  return {
    kind: "Contribution",
    namespace,
    id,
    spec: {
      contributionKind: "work",
      mode: "evaluation",
      summary: "fixture",
      artifacts: {},
      relations: [],
      tags: [],
      agent: { agentId: "test-a" },
    },
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: "1",
    metadata: { generation: 1 },
  };
}

describe("NexusWatchSubscriber", () => {
  test("forwards entity.changed envelopes to WatchHub", async () => {
    const bus = new LocalEventBus();
    const hub = new WatchHub();
    let fetched = 0;
    const fetchEntity = async (kind: string, ns: string, id: string): Promise<WatchEntity> => {
      fetched += 1;
      void kind;
      return fakeContributionEntity(id, ns);
    };
    const sub = new NexusWatchSubscriber({ bus, hub, fetchEntity });
    sub.start();

    const pub = new NexusWatchPublisher(bus);
    await pub.publish({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entityId: "cid-1",
      generation: 1,
      emittedAt: new Date().toISOString(),
    });

    // Allow microtask flush for the void this.onEnvelope() inside handler
    await new Promise((r) => setImmediate(r));
    expect(hub.currentRv("ns/wt", "Contribution")).toBe(1n);
    expect(fetched).toBe(1);
    sub.stop();
  });

  test("dedupes within window when (kind, id, generation) already seen via fast-path", async () => {
    const bus = new LocalEventBus();
    const hub = new WatchHub();
    let fetched = 0;
    const fetchEntity = async (kind: string, ns: string, id: string): Promise<WatchEntity> => {
      fetched += 1;
      void kind;
      return fakeContributionEntity(id, ns);
    };
    const sub = new NexusWatchSubscriber({
      bus,
      hub,
      fetchEntity,
      dedupWindowMs: 1_000,
    });
    sub.start();

    sub.markSeen({ kind: "Contribution", entityId: "cid-1", generation: 1 });

    const pub = new NexusWatchPublisher(bus);
    await pub.publish({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entityId: "cid-1",
      generation: 1,
      emittedAt: new Date().toISOString(),
    });

    await new Promise((r) => setImmediate(r));
    expect(hub.currentRv("ns/wt", "Contribution")).toBe(0n);
    expect(fetched).toBe(0);
    sub.stop();
  });

  test("ignores non-entity.changed events on the same role", async () => {
    const bus = new LocalEventBus();
    const hub = new WatchHub();
    const fetchEntity = async (_kind: string, ns: string, id: string): Promise<WatchEntity> =>
      fakeContributionEntity(id, ns);
    const sub = new NexusWatchSubscriber({ bus, hub, fetchEntity });
    sub.start();

    await bus.publish({
      type: "some.other.topic",
      sourceRole: "x",
      targetRole: "*",
      payload: { ignored: true },
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setImmediate(r));
    expect(hub.currentRv("ns/wt", "Contribution")).toBe(0n);
    sub.stop();
  });
});

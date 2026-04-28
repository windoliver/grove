/**
 * Cross-process integration smoke test (#292).
 *
 * Simulates a write performed by a separate process: writes directly to the
 * contribution store (bypassing the HTTP route) and then publishes an
 * `entity.changed` envelope on the shared event-bus. The grove-server's
 * NexusWatchSubscriber picks it up, fetches the entity, bumps the WatchHub,
 * and the open SSE watch stream receives the ADDED event.
 */

import { describe, expect, test } from "bun:test";
import { NexusWatchPublisher } from "../nexus/nexus-watch-publisher.js";
import { readSseEvents } from "./sse-test-utils.js";
import { createTestApp, TEST_AUTH_HEADERS, TEST_NAMESPACE } from "./test-helpers.js";

describe("watch cross-process via event-bus", () => {
  test("an entity.changed envelope from another writer surfaces on the watch stream", async () => {
    const { app, contributionStore, watchEventBus } = createTestApp();

    const listRes = await app.request("/api/list?kind=Contribution", {
      headers: TEST_AUTH_HEADERS,
    });
    const list = (await listRes.json()) as { listResourceVersion: string };

    const watchRes = await app.request(
      `/api/watch?kind=Contribution&resumeFrom=${list.listResourceVersion}`,
      { headers: TEST_AUTH_HEADERS },
    );

    // Simulate an out-of-band write: write directly to the store. Build a
    // minimal Contribution that conforms to the Contribution interface.
    const cid = `blake3:${"ab".repeat(32)}`;
    await contributionStore.put({
      cid,
      manifestVersion: 1,
      kind: "work",
      mode: "evaluation",
      summary: "cross-proc",
      artifacts: {},
      relations: [],
      tags: [],
      agent: { agentId: "external-writer" },
      createdAt: new Date().toISOString(),
    });

    // Now publish the envelope as if a separate-process publisher had fired.
    const pub = new NexusWatchPublisher(watchEventBus);
    await pub.publish({
      kind: "Contribution",
      namespace: TEST_NAMESPACE,
      op: "ADDED",
      entityId: cid,
      generation: 1,
      emittedAt: new Date().toISOString(),
    });

    const events = await readSseEvents(watchRes, 1, 2_000);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.event).toBe("ADDED");
    const entity = (events[0]?.data as { entity: { id: string } }).entity;
    expect(entity.id).toBe(cid);
  }, 5_000);
});

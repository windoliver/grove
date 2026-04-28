/**
 * Acceptance test for issue #292 — criterion #2.
 * Writes that arrive between list-return and watch-open must all be replayed
 * once the watcher resumes from listResourceVersion.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readSseEvents } from "./sse-test-utils.js";
import { createTestApp, makeManifestBody, TEST_AUTH_HEADERS } from "./test-helpers.js";

describe("watch handshake-race (issue #292 acceptance #2)", () => {
  beforeEach(() => {
    process.env.GROVE_WATCH_LIST_DELAY_MS = "150";
  });
  afterEach(() => {
    delete process.env.GROVE_WATCH_LIST_DELAY_MS;
  });

  test("writes between list-return and watch-open are all replayed", async () => {
    const { app } = createTestApp();
    const N = 25;

    // Begin list (will block 150ms inside the handler)
    const listPromise: Promise<{ items: unknown[]; listResourceVersion: string }> = Promise.resolve(
      app.request("/api/list?kind=Contribution", { headers: TEST_AUTH_HEADERS }),
    ).then((r) => r.json() as Promise<{ items: unknown[]; listResourceVersion: string }>);

    // Inject N concurrent writes during the list delay window
    await new Promise((r) => setTimeout(r, 20)); // ensure list is mid-flight
    const writeResponses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        app.request("/api/contributions", {
          method: "POST",
          headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify(makeManifestBody({ summary: `race-${i}` })),
        }),
      ),
    );
    for (const res of writeResponses) {
      expect(res.status).toBe(201);
    }
    const writtenCids = await Promise.all(
      writeResponses.map(async (r) => (await r.json()) as { cid: string }),
    );
    const writtenIdSet = new Set(writtenCids.map((c) => c.cid));

    const list = await listPromise;

    // Open watch from the listResourceVersion. Race-correctness requires
    // that every event with rv > listResourceVersion is replayed.
    const watchRes = await app.request(
      `/api/watch?kind=Contribution&resumeFrom=${list.listResourceVersion}`,
      { headers: TEST_AUTH_HEADERS },
    );
    const events = await readSseEvents(watchRes, N, 5_000);
    const watchedIds = new Set(
      events
        .filter((e) => e.event === "ADDED")
        .map((e) => (e.data as { entity: { id: string } }).entity.id),
    );

    for (const id of writtenIdSet) {
      expect(watchedIds.has(id)).toBe(true);
    }
  }, 10_000);
});

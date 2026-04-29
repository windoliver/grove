/**
 * Acceptance test for issue #292 — criterion #1.
 * After abrupt disconnect (simulates kill -9), reconnect with the stored RV
 * must replay every event written during the disconnect window.
 */

import { describe, expect, test } from "bun:test";
import { readSseEvents } from "./sse-test-utils.js";
import { createTestApp, makeManifestBody, TEST_AUTH_HEADERS } from "./test-helpers.js";

describe("watch kill-9 resume (issue #292 acceptance #1)", () => {
  test("reconnect with stored RV → zero missed events", async () => {
    const { app } = createTestApp();

    // Initial list captures the RV checkpoint the client would store.
    const listRes = await app.request("/api/list?kind=Contribution", {
      headers: TEST_AUTH_HEADERS,
    });
    const list = (await listRes.json()) as { listResourceVersion: string };

    // First connection: open the watch, then immediately abort to simulate kill -9.
    const ac = new AbortController();
    try {
      await app.request(`/api/watch?kind=Contribution&resumeFrom=${list.listResourceVersion}`, {
        headers: TEST_AUTH_HEADERS,
        signal: ac.signal,
      });
    } catch {
      /* signal abort can throw on some Bun versions; ignore */
    }
    ac.abort();

    // Write M=20 events while disconnected.
    const M = 20;
    const writeResponses = await Promise.all(
      Array.from({ length: M }, (_, i) =>
        app.request("/api/contributions", {
          method: "POST",
          headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify(makeManifestBody({ summary: `kill-${i}` })),
        }),
      ),
    );
    for (const res of writeResponses) {
      expect(res.status).toBe(201);
    }
    const writtenIds = new Set(
      (await Promise.all(writeResponses.map((r) => r.json() as Promise<{ cid: string }>))).map(
        (c) => c.cid,
      ),
    );

    // Reconnect with the same resumeFrom.
    const secondRes = await app.request(
      `/api/watch?kind=Contribution&resumeFrom=${list.listResourceVersion}`,
      { headers: TEST_AUTH_HEADERS },
    );
    const events = await readSseEvents(secondRes, M, 5_000);
    const seenIds = new Set(
      events
        .filter((e) => e.event === "ADDED")
        .map((e) => (e.data as { entity: { id: string } }).entity.id),
    );

    for (const id of writtenIds) {
      expect(seenIds.has(id)).toBe(true);
    }

    // No duplicates: the count of ADDED events with our CIDs should equal M.
    const addedFromOurWrites = events.filter(
      (e) =>
        e.event === "ADDED" && writtenIds.has((e.data as { entity: { id: string } }).entity.id),
    );
    expect(addedFromOurWrites.length).toBe(M);
  }, 10_000);
});

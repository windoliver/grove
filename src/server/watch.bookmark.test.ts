/**
 * Acceptance test for issue #292 — criterion #3.
 * BOOKMARK events are emitted at minimum once per bookmarkIntervalMs per
 * active watch stream, even on a quiescent (ns, kind).
 */

import { describe, expect, test } from "bun:test";
import { readSseEvents } from "./sse-test-utils.js";
import { TEST_AUTH_HEADERS, createTestApp } from "./test-helpers.js";

describe("watch BOOKMARK cadence (issue #292 acceptance #3)", () => {
  test("emits BOOKMARK at least once within bookmarkIntervalMs on idle stream", async () => {
    const { app } = createTestApp({
      watchHubOptions: { bookmarkIntervalMs: 200 },
    });

    const listRes = await app.request("/api/list?kind=Contribution", {
      headers: TEST_AUTH_HEADERS,
    });
    const list = (await listRes.json()) as { listResourceVersion: string };

    const watchRes = await app.request(
      `/api/watch?kind=Contribution&resumeFrom=${list.listResourceVersion}`,
      { headers: TEST_AUTH_HEADERS },
    );

    const events = await readSseEvents(watchRes, 1, 1_000);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.event).toBe("BOOKMARK");
    const data = events[0]?.data as { rv: string };
    expect(typeof data.rv).toBe("string");
    expect(/^[0-9]+$/.test(data.rv)).toBe(true);
  }, 5_000);
});

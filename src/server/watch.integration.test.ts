/**
 * T13 — Integration tests for the GET /api/list watch snapshot endpoint
 * (#292).
 *
 * Verifies the contract documented in `src/server/routes/watch.ts`:
 *   - empty namespace returns `items: []` and `listResourceVersion: "0"`
 *   - the listResourceVersion advances after a write through the
 *     /api/contributions HTTP route (proves the watchHub captured
 *     in T12 is the same hub queried by /api/list)
 *   - missing `kind` query param → 400 (zod validator)
 *   - missing Authorization header → 400 NAMESPACE_MISSING (per
 *     `namespace-auth.ts`); 401 is accepted as well to keep the test
 *     resilient to future auth changes.
 */

import { describe, expect, test } from "bun:test";
import { readSseEvents } from "./sse-test-utils.js";
import { createTestApp, makeManifestBody, TEST_AUTH_HEADERS } from "./test-helpers.js";

describe("GET /api/list", () => {
  test("returns items: [] and listResourceVersion '0' for an empty namespace", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/list?kind=Contribution", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; listResourceVersion: string };
    expect(body.items).toEqual([]);
    expect(body.listResourceVersion).toBe("0");
  });

  test("listResourceVersion advances after a contribution write", async () => {
    const { app } = createTestApp();

    const postRes = await app.request("/api/contributions", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(makeManifestBody({ summary: "T13 list-after-write" })),
    });
    expect(postRes.status).toBe(201);

    const res = await app.request("/api/list?kind=Contribution", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; listResourceVersion: string };
    expect(body.items.length).toBe(1);
    expect(BigInt(body.listResourceVersion)).toBeGreaterThan(0n);
  });

  test("returns 400 when kind query param is missing", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/list", { headers: TEST_AUTH_HEADERS });
    expect(res.status).toBe(400);
  });

  test("returns 400 or 401 when Authorization header is missing", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/list?kind=Contribution");
    expect([400, 401]).toContain(res.status);
  });
});

describe("GET /api/watch", () => {
  test("streams ADDED events for writes after subscribe", async () => {
    const { app } = createTestApp();
    const listRes = await app.request("/api/list?kind=Contribution", {
      headers: TEST_AUTH_HEADERS,
    });
    const list = (await listRes.json()) as { listResourceVersion: string };

    const watchRes = await app.request(
      `/api/watch?kind=Contribution&resumeFrom=${list.listResourceVersion}`,
      { headers: TEST_AUTH_HEADERS },
    );
    expect(watchRes.status).toBe(200);
    expect(watchRes.headers.get("content-type")).toMatch(/text\/event-stream/);

    // POST a contribution AFTER opening the watch. Reuse the existing
    // contribution-POST pattern from watch-wiring.test.ts (T12 commit 8703e68)
    // / watch.integration.test.ts (T13 commit 2fb87ea).
    const writePromise = app.request("/api/contributions", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(makeManifestBody({ summary: "live-1" })),
    });

    const events = await readSseEvents(watchRes, 1, 2_000);
    await writePromise;

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.event).toBe("ADDED");
    // Verify the SSE event id equals the rv (a stringified bigint)
    expect(events[0]?.id).toMatch(/^[0-9]+$/);
  });

  test("ERROR 410 when resumeFrom is older than the ring's oldest rv", async () => {
    const { app } = createTestApp({ watchHubOptions: { maxEventsPerKey: 2 } });

    // Three writes evict the first one from the ring (cap=2).
    for (const summary of ["a", "b", "c"]) {
      const res = await app.request("/api/contributions", {
        method: "POST",
        headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify(makeManifestBody({ summary })),
      });
      expect(res.status).toBe(201);
    }

    const watchRes = await app.request(`/api/watch?kind=Contribution&resumeFrom=0`, {
      headers: TEST_AUTH_HEADERS,
    });
    const events = await readSseEvents(watchRes, 1, 2_000);
    expect(events[0]?.event).toBe("ERROR");
    expect((events[0]?.data as { code: number }).code).toBe(410);
    expect((events[0]?.data as { reason: string }).reason).toBe("expired");
  });

  test("removes request abort listener when a stream closes without request abort", async () => {
    const originalAdd = AbortSignal.prototype.addEventListener;
    const originalRemove = AbortSignal.prototype.removeEventListener;
    let activeAbortListeners = 0;

    AbortSignal.prototype.addEventListener = function (
      type,
      listener,
      options,
    ): ReturnType<typeof originalAdd> {
      if (type === "abort") activeAbortListeners++;
      return originalAdd.call(this, type, listener, options);
    };
    AbortSignal.prototype.removeEventListener = function (
      type,
      listener,
      options,
    ): ReturnType<typeof originalRemove> {
      if (type === "abort") activeAbortListeners--;
      return originalRemove.call(this, type, listener, options);
    };

    try {
      const { app } = createTestApp({ watchHubOptions: { maxEventsPerKey: 1 } });
      for (const summary of ["a", "b"]) {
        const res = await app.request("/api/contributions", {
          method: "POST",
          headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify(makeManifestBody({ summary })),
        });
        expect(res.status).toBe(201);
      }

      const watchRes = await app.request("/api/watch?kind=Contribution&resumeFrom=0", {
        headers: TEST_AUTH_HEADERS,
      });
      const events = await readSseEvents(watchRes, 1, 2_000);

      expect(events[0]?.event).toBe("ERROR");
      expect(activeAbortListeners).toBe(0);
    } finally {
      AbortSignal.prototype.addEventListener = originalAdd;
      AbortSignal.prototype.removeEventListener = originalRemove;
    }
  });
});

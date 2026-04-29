/**
 * Acceptance tests for issue #293 — server-side compaction surface.
 *   - GET /api/watch/metrics returns retention config and per-(ns,kind) counters
 *   - Namespace isolation: caller only sees their own keys
 */

import { describe, expect, test } from "bun:test";
import { readSseEvents } from "./sse-test-utils.js";
import { createTestApp, makeManifestBody, TEST_AUTH_HEADERS } from "./test-helpers.js";

interface MetricsResponse {
  retention: { maxAgeMs: number; maxEvents: number };
  keys: Array<{
    namespace: string;
    kind: string;
    evictedByAge: number;
    evictedByCapacity: number;
    currentRingSize: number;
    oldestRv: string;
    currentRv: string;
  }>;
}

describe("GET /api/watch/metrics", () => {
  test("returns retention config from WatchHub options", async () => {
    const { app } = createTestApp({
      watchHubOptions: { maxAgeMsPerKey: 1234, maxEventsPerKey: 56 },
    });
    const res = await app.request("/api/watch/metrics", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetricsResponse;
    expect(body.retention.maxAgeMs).toBe(1234);
    expect(body.retention.maxEvents).toBe(56);
    expect(body.keys).toEqual([]);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Vary")).toBe("Authorization");
  });

  test("reports counters after writes within capacity", async () => {
    const { app } = createTestApp({
      watchHubOptions: { maxAgeMsPerKey: 60_000, maxEventsPerKey: 100 },
    });
    const writeRes = await app.request("/api/contributions", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(makeManifestBody({ summary: "metrics-1" })),
    });
    expect(writeRes.status).toBe(201);

    const res = await app.request("/api/watch/metrics", {
      headers: TEST_AUTH_HEADERS,
    });
    const body = (await res.json()) as MetricsResponse;
    const key = body.keys.find((k) => k.kind === "Contribution");
    expect(key).toBeDefined();
    expect(key?.evictedByAge).toBe(0);
    expect(key?.evictedByCapacity).toBe(0);
    expect(key?.currentRingSize).toBe(1);
    expect(key?.currentRv).toBe("1");
  });

  test("requires authentication", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/watch/metrics");
    expect([400, 401]).toContain(res.status);
  });
});

describe("compaction triggers Expired (issue #293 acceptance #1)", () => {
  test("sleep past retention window → resume returns 410", async () => {
    let now = 1_000_000;
    const { app } = createTestApp({
      watchHubOptions: {
        maxAgeMsPerKey: 200,
        maxEventsPerKey: 100,
        now: () => now,
      },
    });

    // Capture rv before any writes so it falls strictly below the post-
    // eviction oldestRv. With earlyRv=0 and oldestRv=2 after eviction,
    // the 410 trigger `fromRv < oldestRv - 1n` (0 < 1) holds.
    const earlyRv = await listRv(app);
    expect(earlyRv).toBe("0");

    const writeRes1 = await app.request("/api/contributions", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(makeManifestBody({ summary: "early" })),
    });
    expect(writeRes1.status).toBe(201);

    // Advance clock past retention so the next write's trim evicts entry 1.
    now += 1_000;

    const writeRes2 = await app.request("/api/contributions", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(makeManifestBody({ summary: "late" })),
    });
    expect(writeRes2.status).toBe(201);

    // Resume from earlyRv=0. Ring oldestRv=2 → 410.
    const watchRes = await app.request(`/api/watch?kind=Contribution&resumeFrom=${earlyRv}`, {
      headers: TEST_AUTH_HEADERS,
    });
    const events = await readSseEvents(watchRes, 1, 1_000);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const errorEvent = events.find((e) => e.event === "ERROR");
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { code: number }).code).toBe(410);
    expect((errorEvent?.data as { reason: string }).reason).toBe("expired");
    expect(events[0]?.event).toBe("ERROR");

    // Metrics endpoint reflects the eviction.
    const metricsRes = await app.request("/api/watch/metrics", {
      headers: TEST_AUTH_HEADERS,
    });
    const metrics = (await metricsRes.json()) as MetricsResponse;
    const key = metrics.keys.find((k) => k.kind === "Contribution");
    expect(key?.evictedByAge).toBeGreaterThanOrEqual(1);
  });

  test("capacity-based eviction also returns 410", async () => {
    const { app } = createTestApp({
      watchHubOptions: { maxAgeMsPerKey: 60_000, maxEventsPerKey: 4 },
    });
    const earlyRv = await listRv(app);
    expect(earlyRv).toBe("0");
    for (let i = 0; i < 10; i++) {
      const r = await app.request("/api/contributions", {
        method: "POST",
        headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify(makeManifestBody({ summary: `cap-${i}` })),
      });
      expect(r.status).toBe(201);
    }
    const watchRes = await app.request(`/api/watch?kind=Contribution&resumeFrom=${earlyRv}`, {
      headers: TEST_AUTH_HEADERS,
    });
    const events = await readSseEvents(watchRes, 1, 1_000);
    const errorEvent = events.find((e) => e.event === "ERROR");
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { code: number }).code).toBe(410);
    expect(events[0]?.event).toBe("ERROR");

    const metricsRes = await app.request("/api/watch/metrics", {
      headers: TEST_AUTH_HEADERS,
    });
    const metrics = (await metricsRes.json()) as MetricsResponse;
    const key = metrics.keys.find((k) => k.kind === "Contribution");
    expect(key?.evictedByCapacity).toBeGreaterThanOrEqual(1);
  });
});

async function listRv(app: {
  request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<string> {
  const res = await app.request("/api/list?kind=Contribution", {
    headers: TEST_AUTH_HEADERS,
  });
  const json = (await res.json()) as { listResourceVersion: string };
  return json.listResourceVersion;
}

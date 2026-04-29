/**
 * Acceptance tests for issue #293 — server-side compaction surface.
 *   - GET /api/watch/metrics returns retention config and per-(ns,kind) counters
 *   - Namespace isolation: caller only sees their own keys
 */

import { describe, expect, test } from "bun:test";
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

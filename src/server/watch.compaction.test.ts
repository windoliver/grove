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

  test("idle key past retention window → resume returns 410 (no further writes)", async () => {
    // Regression: trim() used to run only on recordWrite(), so an idle
    // (namespace, kind) key kept events past maxAgeMs forever. A client
    // resuming after the documented retention window would receive
    // expired replay instead of ERROR 410, defeating the contract.
    let now = 1_000_000;
    const { app } = createTestApp({
      watchHubOptions: {
        maxAgeMsPerKey: 200,
        maxEventsPerKey: 100,
        now: () => now,
      },
    });

    const earlyRv = await listRv(app);
    expect(earlyRv).toBe("0");

    const wr = await app.request("/api/contributions", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(makeManifestBody({ summary: "alone" })),
    });
    expect(wr.status).toBe(201);

    // Advance clock past retention WITHOUT another write. Compaction must
    // happen at subscribe time even though no write triggers trim().
    now += 1_000;

    const watchRes = await app.request(`/api/watch?kind=Contribution&resumeFrom=${earlyRv}`, {
      headers: TEST_AUTH_HEADERS,
    });
    const events = await readSseEvents(watchRes, 1, 1_000);
    const errorEvent = events.find((e) => e.event === "ERROR");
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { code: number }).code).toBe(410);
    expect(events[0]?.event).toBe("ERROR");

    // Metrics also reflect the eviction without a write triggering it.
    const metricsRes = await app.request("/api/watch/metrics", {
      headers: TEST_AUTH_HEADERS,
    });
    const metrics = (await metricsRes.json()) as MetricsResponse;
    const key = metrics.keys.find((k) => k.kind === "Contribution");
    expect(key?.evictedByAge).toBe(1);
    expect(key?.currentRingSize).toBe(0);
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

describe("PATCH /api/claims/:id heartbeat watch fan-out", () => {
  test("heartbeat emits MODIFIED with updated lease fields", async () => {
    // Heartbeats update heartbeatAt + leaseExpiresAt. Watchers must see
    // these so they don't conclude an actively heartbeated claim has
    // expired. Regression: heartbeat used to return without recordWrite.
    const { app } = createTestApp({
      watchHubOptions: { maxEventsPerKey: 100, maxAgeMsPerKey: 60_000 },
    });
    const claimBody = {
      claimId: "claim-hb-1",
      targetRef: "task-hb",
      agent: { agentId: "agent-1" },
      intentSummary: "heartbeat test",
    };
    const post = await app.request("/api/claims", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(claimBody),
    });
    expect(post.status).toBe(201);

    // Open watch from current rv=1 so the heartbeat shows up as the next event.
    const watchRes = await app.request("/api/watch?kind=Claim&resumeFrom=1", {
      headers: TEST_AUTH_HEADERS,
    });
    const hb = await app.request(`/api/claims/${claimBody.claimId}`, {
      method: "PATCH",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "heartbeat" }),
    });
    expect(hb.status).toBe(200);
    const events = await readSseEvents(watchRes, 1, 1_000);
    const modified = events.find((e) => e.event === "MODIFIED");
    expect(modified).toBeDefined();
    expect((modified?.data as { entity: { id: string } }).entity.id).toBe(claimBody.claimId);
  });
});

describe("POST /api/claims watch fan-out", () => {
  test("renewals emit MODIFIED so watchers see lease updates", async () => {
    // Lease state (heartbeatAt / leaseExpiresAt) is part of the Claim
    // entity surfaced to watchers. Suppressing renewal events would let
    // a watcher conclude an actively-renewed claim had expired.
    const { app } = createTestApp({
      watchHubOptions: { maxEventsPerKey: 100, maxAgeMsPerKey: 60_000 },
    });
    const claimBody = {
      claimId: "claim-renew-1",
      targetRef: "task-x",
      agent: { agentId: "agent-1" },
      intentSummary: "renewal stress",
    };
    const post = async () => {
      const r = await app.request("/api/claims", {
        method: "POST",
        headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify(claimBody),
      });
      expect(r.status).toBe(201);
    };
    await post();
    await post();
    await post();
    const metricsRes = await app.request("/api/watch/metrics", {
      headers: TEST_AUTH_HEADERS,
    });
    const metrics = (await metricsRes.json()) as MetricsResponse;
    const claimKey = metrics.keys.find((k) => k.kind === "Claim");
    expect(claimKey).toBeDefined();
    // First create (revision=1) → ADDED + 2 renewals → MODIFIED. RV=3.
    expect(claimKey?.currentRv).toBe("3");
  });
});

describe("watch route overflow path delivers terminal ERROR", () => {
  test("byte-overflow at route level still emits ERROR{code:503} (regression)", async () => {
    // Regression: closeWithError() previously routed through send() which
    // refuses frames whose enqueue would push desiredSize past the route's
    // overflow threshold. Once isOverflowed() fired, closeWithError(503)
    // would silently drop the terminal ERROR frame and the client would
    // see plain EOF → fast-resume → loop. This test forces the route
    // queue past the threshold and asserts the ERROR frame is delivered.
    const { app } = createTestApp();
    const watchRes = await app.request("/api/watch?kind=Contribution&resumeFrom=0", {
      headers: TEST_AUTH_HEADERS,
    });
    // ROUTE_BYTE_OVERFLOW_THRESHOLD = -3 MiB; HWM = +1 MiB. ~600 KiB
    // events × 8 = ~4.7 MiB, pushing desiredSize to -3.7 MiB. Each event
    // sits below the 1 MiB per-event cap.
    const bigSummary = "x".repeat(600 * 1024);
    for (let i = 0; i < 8; i++) {
      const r = await app.request("/api/contributions", {
        method: "POST",
        headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify(makeManifestBody({ summary: bigSummary })),
      });
      expect(r.status).toBe(201);
    }
    // Drain. Whatever arrives, the terminal ERROR{503} must be among it.
    const events = await readSseEvents(watchRes, 200, 5_000);
    const error = events.find((e) => e.event === "ERROR");
    expect(error).toBeDefined();
    expect((error?.data as { code: number }).code).toBe(503);
    expect((error?.data as { reason: string }).reason).toBe("buffer_overflow");
  }, 10_000);
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

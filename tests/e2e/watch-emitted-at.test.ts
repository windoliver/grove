/**
 * E2E: server stamps emittedAt on live-delta SSE frames; client parses it.
 */

import { describe, expect, test } from "bun:test";
import { readSseEvents } from "../../src/server/sse-test-utils.js";
import {
  createTestApp,
  makeManifestBody,
  TEST_AUTH_HEADERS,
} from "../../src/server/test-helpers.js";

describe("/api/watch emittedAt", () => {
  test("server stamps emittedAt on each ADDED frame; finite parse, near-now", async () => {
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

    const writePromise = app.request("/api/contributions", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(makeManifestBody({ summary: "emitted-at" })),
    });

    const events = await readSseEvents(watchRes, 1, 2_000);
    await writePromise;

    expect(events.length).toBeGreaterThanOrEqual(1);
    const added = events.find((e) => e.event === "ADDED");
    expect(added).toBeDefined();
    const data = added?.data as { emittedAt?: string } | undefined;
    expect(data?.emittedAt).toBeDefined();
    const ts = Date.parse(data?.emittedAt ?? "");
    expect(Number.isFinite(ts)).toBe(true);
    expect(Math.abs(Date.now() - ts)).toBeLessThan(5_000);
  });
});

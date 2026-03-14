/**
 * Cross-cutting route integration tests for the grove HTTP server.
 *
 * Per-domain coverage lives in dedicated test files:
 *   - claims.test.ts        — POST/PATCH/GET /api/claims
 *   - contributions.test.ts — POST/GET /api/contributions, artifact downloads
 *   - frontier.test.ts      — GET /api/frontier (filters, pagination)
 *   - search.test.ts        — GET /api/search
 *   - outcomes.test.ts      — POST/GET /api/outcomes, stats
 *   - threads.test.ts       — GET /api/threads
 *   - dag.test.ts           — GET /api/dag children/ancestors
 *   - grove.test.ts         — GET /api/grove metadata
 *   - integration.test.ts   — multi-endpoint workflow tests
 *   - error-handling.test.ts — error-handler middleware unit tests
 *
 * This file covers scenarios that span multiple domains or test
 * frontier dimensions not covered by the per-domain frontier tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestContext } from "./helpers.js";
import { createTestContext, postContribution } from "./helpers.js";

// ===================================================================
// Frontier — byMetric dimension (not covered by frontier.test.ts)
// ===================================================================

describe("routes — /api/frontier byMetric", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("GET after adding contributions with scores returns populated byMetric", async () => {
    await postContribution(ctx, {
      summary: "Fast run",
      scores: {
        latency: { value: 42, direction: "minimize", unit: "ms" },
      },
    });
    await postContribution(ctx, {
      summary: "Slow run",
      scores: {
        latency: { value: 100, direction: "minimize", unit: "ms" },
      },
      createdAt: new Date(Date.now() + 1).toISOString(),
    });

    const res = await ctx.app.request("/api/frontier");
    expect(res.status).toBe(200);
    const data = await res.json();

    // byMetric should have a "latency" key with an array of frontier entries
    expect(data.byMetric).toBeTruthy();
    expect(Array.isArray(data.byMetric.latency)).toBe(true);
    expect(data.byMetric.latency.length).toBeGreaterThanOrEqual(1);
    // The frontier leader for "minimize" latency should be the lower value
    expect(data.byMetric.latency[0].value).toBe(42);
    expect(data.byMetric.latency[0].summary).toBe("Fast run");

    // byRecency should have both contributions
    expect(data.byRecency.length).toBeGreaterThanOrEqual(2);
  });
});

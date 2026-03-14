/**
 * Route-level integration tests for the grove HTTP server.
 *
 * Covers the four highest-risk route groups: claims, contributions,
 * frontier, and search. Each test exercises real stores wired through
 * createApp() — no mocks, no running server.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestContext } from "./helpers.js";
import { createTestContext, validManifestBody } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function claimBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    targetRef: "optimize-parser",
    agent: { agentId: "agent-1" },
    intentSummary: "Working on parser optimization",
    ...overrides,
  };
}

/** POST a JSON contribution and return the parsed response body. */
async function postContribution(
  ctx: TestContext,
  overrides?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await ctx.app.request("/api/contributions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validManifestBody(overrides)),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** POST a claim and return the parsed response body. */
async function postClaim(
  ctx: TestContext,
  overrides?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await ctx.app.request("/api/claims", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(claimBody(overrides)),
  });
  return (await res.json()) as Record<string, unknown>;
}

// ===================================================================
// 1. Claims route (/api/claims)
// ===================================================================

describe("routes — /api/claims", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  // --- POST ---

  test("POST with valid body returns 201 and an active claim", async () => {
    const res = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(claimBody()),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.claimId).toBeTruthy();
    expect(data.status).toBe("active");
    expect(data.targetRef).toBe("optimize-parser");
    expect(data.agent.agentId).toBe("agent-1");
  });

  test("POST with missing targetRef returns 400", async () => {
    const res = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: { agentId: "agent-1" },
        intentSummary: "Missing target",
      }),
    });

    expect(res.status).toBe(400);
  });

  test("POST with empty body returns 400", async () => {
    const res = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  // --- PATCH ---

  test("PATCH heartbeat on valid claim returns 200", async () => {
    const claim = await postClaim(ctx);

    const res = await ctx.app.request(`/api/claims/${claim.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "heartbeat" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("active");
    // heartbeatAt should be updated
    expect(data.heartbeatAt).toBeTruthy();
  });

  test("PATCH heartbeat on non-existent claim returns error (>= 400)", async () => {
    const res = await ctx.app.request("/api/claims/does-not-exist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "heartbeat" }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const data = await res.json();
    expect(data.error).toBeTruthy();
    expect(data.error.code).toBeTruthy();
  });

  test("PATCH release returns 200 and claim becomes released", async () => {
    const claim = await postClaim(ctx);

    const res = await ctx.app.request(`/api/claims/${claim.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("released");

    // Verify via GET that the claim is really released
    const listRes = await ctx.app.request("/api/claims?status=released");
    const listData = await listRes.json();
    expect(listData.claims).toHaveLength(1);
    expect(listData.claims[0].claimId).toBe(claim.claimId);
  });

  test("PATCH complete returns 200 and claim becomes completed", async () => {
    const claim = await postClaim(ctx);

    const res = await ctx.app.request(`/api/claims/${claim.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("completed");
  });

  test("PATCH with invalid action returns 400", async () => {
    const res = await ctx.app.request("/api/claims/any-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "destroy" }),
    });

    expect(res.status).toBe(400);
  });

  // --- GET ---

  test("GET with status filter returns only matching claims", async () => {
    // Create two claims on different targets
    await postClaim(ctx, { targetRef: "target-a", agent: { agentId: "a1" } });
    const claim2 = await postClaim(ctx, { targetRef: "target-b", agent: { agentId: "a2" } });

    // Release the second claim
    await ctx.app.request(`/api/claims/${claim2.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release" }),
    });

    // Filter by active — should get only the first
    const activeRes = await ctx.app.request("/api/claims?status=active");
    expect(activeRes.status).toBe(200);
    const activeData = await activeRes.json();
    expect(activeData.claims).toHaveLength(1);
    expect(activeData.claims[0].targetRef).toBe("target-a");
    expect(activeData.count).toBe(1);

    // Filter by released — should get only the second
    const releasedRes = await ctx.app.request("/api/claims?status=released");
    const releasedData = await releasedRes.json();
    expect(releasedData.claims).toHaveLength(1);
    expect(releasedData.claims[0].targetRef).toBe("target-b");
  });

  test("GET with agentId filter returns only matching claims", async () => {
    await postClaim(ctx, { agent: { agentId: "agent-alpha" }, targetRef: "t1" });
    await postClaim(ctx, { agent: { agentId: "agent-beta" }, targetRef: "t2" });

    const res = await ctx.app.request("/api/claims?agentId=agent-alpha");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.claims).toHaveLength(1);
    expect(data.claims[0].agent.agentId).toBe("agent-alpha");
  });
});

// ===================================================================
// 2. Contributions route (/api/contributions)
// ===================================================================

describe("routes — /api/contributions", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  // --- POST ---

  test("POST JSON manifest returns 201 with CID", async () => {
    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validManifestBody()),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
    expect(data.kind).toBe("work");
    expect(data.summary).toBe("Test contribution");
    expect(data.agent.agentId).toBe("test-agent");
  });

  test("POST multipart with artifact returns 201 and stores artifact hash", async () => {
    const manifest = validManifestBody();
    const formData = new FormData();
    formData.append("manifest", JSON.stringify(manifest));
    formData.append(
      "artifact:main.py",
      new File([new TextEncoder().encode("print('hello')")], "main.py", {
        type: "text/x-python",
      }),
    );

    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.artifacts["main.py"]).toMatch(/^blake3:[0-9a-f]{64}$/);
  });

  test("POST with invalid manifest (missing summary) returns 400", async () => {
    const body = { kind: "work", mode: "evaluation", agent: { agentId: "a1" } };

    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("POST with invalid JSON body returns 400 with VALIDATION_ERROR", async () => {
    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is not { valid json",
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
    expect(data.error.message).toBe("Invalid JSON body");
  });

  // --- GET list ---

  test("GET list returns 200 with array", async () => {
    await postContribution(ctx);
    await postContribution(ctx, {
      summary: "Second",
      createdAt: new Date(Date.now() + 1).toISOString(),
    });

    const res = await ctx.app.request("/api/contributions");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);
    expect(res.headers.get("X-Total-Count")).toBe("2");
  });

  test("GET list with kind filter returns only matching kind", async () => {
    await postContribution(ctx, { kind: "work", summary: "Work item" });
    await postContribution(ctx, {
      kind: "review",
      summary: "Review item",
      createdAt: new Date(Date.now() + 1).toISOString(),
    });

    const res = await ctx.app.request("/api/contributions?kind=review");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].kind).toBe("review");
  });

  // --- GET by CID ---

  test("GET /:cid returns 200 for existing contribution", async () => {
    const created = await postContribution(ctx);

    const res = await ctx.app.request(`/api/contributions/${created.cid}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cid).toBe(created.cid);
    expect(data.summary).toBe("Test contribution");
    expect(data.kind).toBe("work");
  });

  test("GET /:cid returns 404 for non-existing CID", async () => {
    const fakeCid = `blake3:${"0".repeat(64)}`;
    const res = await ctx.app.request(`/api/contributions/${fakeCid}`);

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain(fakeCid);
  });

  // --- GET artifacts ---

  test("GET /:cid/artifacts/:name returns 200 for existing artifact", async () => {
    // Pre-store artifact bytes with explicit media type
    const content = new TextEncoder().encode("print('hello')");
    const hash = await ctx.cas.put(content, { mediaType: "text/x-python" });

    const created = await postContribution(ctx, { artifacts: { "script.py": hash } });

    const res = await ctx.app.request(`/api/contributions/${created.cid}/artifacts/script.py`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-python");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe("print('hello')");
  });

  test("GET /:cid/artifacts/:name returns 404 for missing artifact", async () => {
    const created = await postContribution(ctx);

    const res = await ctx.app.request(`/api/contributions/${created.cid}/artifacts/nonexistent`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("nonexistent");
  });
});

// ===================================================================
// 3. Frontier route (/api/frontier)
// ===================================================================

describe("routes — /api/frontier", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("GET with no data returns 200 and empty frontier", async () => {
    const res = await ctx.app.request("/api/frontier");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.byMetric).toEqual({});
    expect(data.byRecency).toEqual([]);
    expect(data.byAdoption).toEqual([]);
    expect(data.byReviewScore).toEqual([]);
    expect(data.byReproduction).toEqual([]);
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

  test("GET with kind filter returns only that kind in results", async () => {
    await postContribution(ctx, { kind: "work", summary: "Work frontier" });
    await postContribution(ctx, {
      kind: "review",
      summary: "Review frontier",
      createdAt: new Date(Date.now() + 1).toISOString(),
    });

    const res = await ctx.app.request("/api/frontier?kind=work");
    expect(res.status).toBe(200);
    const data = await res.json();

    // All entries in byRecency should be kind=work
    for (const entry of data.byRecency) {
      expect(entry.kind).toBe("work");
    }
    // Should have at least one entry
    expect(data.byRecency.length).toBeGreaterThanOrEqual(1);
  });
});

// ===================================================================
// 4. Search route (/api/search)
// ===================================================================

describe("routes — /api/search", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("GET with matching query returns results", async () => {
    await postContribution(ctx, { summary: "Optimize the transformer model" });
    await postContribution(ctx, {
      summary: "Fix memory leak in allocator",
      createdAt: new Date(Date.now() + 1).toISOString(),
    });

    const res = await ctx.app.request("/api/search?q=transformer");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].summary).toBe("Optimize the transformer model");
    expect(typeof data.count).toBe("number");
    expect(data.count).toBe(1);
  });

  test("GET with no matches returns empty results array", async () => {
    await postContribution(ctx, { summary: "Something unrelated" });

    const res = await ctx.app.request("/api/search?q=zzzznonexistent");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
  });

  test("GET with empty/missing query returns 400", async () => {
    // The schema requires q with min(1), so omitting it should be 400
    const res = await ctx.app.request("/api/search");
    expect(res.status).toBe(400);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestContext } from "./helpers.js";
import { createTestContext, validManifestBody } from "./helpers.js";

describe("GET /api/frontier", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns empty frontier when no contributions exist", async () => {
    const res = await ctx.app.request("/api/frontier");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.byMetric).toEqual({});
    expect(data.byAdoption).toEqual([]);
    expect(data.byRecency).toEqual([]);
    expect(data.byReviewScore).toEqual([]);
    expect(data.byReproduction).toEqual([]);
  });

  test("returns frontier with recency dimension", async () => {
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validManifestBody({ summary: "First" })),
    });

    const res = await ctx.app.request("/api/frontier");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.byRecency).toHaveLength(1);
    expect(data.byRecency[0].summary).toBe("First");
  });

  test("accepts limit parameter", async () => {
    for (let i = 0; i < 3; i++) {
      await ctx.app.request("/api/contributions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          validManifestBody({
            summary: `Item ${i}`,
            createdAt: new Date(Date.now() + i).toISOString(),
          }),
        ),
      });
    }

    const res = await ctx.app.request("/api/frontier?limit=2");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.byRecency).toHaveLength(2);
  });

  test("filters by kind", async () => {
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validManifestBody({ kind: "work", summary: "Work item" })),
    });
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        validManifestBody({
          kind: "review",
          summary: "Review item",
          createdAt: new Date(Date.now() + 1).toISOString(),
        }),
      ),
    });

    const res = await ctx.app.request("/api/frontier?kind=work");
    expect(res.status).toBe(200);
    const data = await res.json();
    // Only work contributions in recency
    for (const entry of data.byRecency) {
      expect(entry.contribution.kind).toBe("work");
    }
  });

  test("filters by tags", async () => {
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validManifestBody({ summary: "Tagged item", tags: ["perf"] })),
    });

    const res = await ctx.app.request("/api/frontier?tags=perf");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.byRecency).toHaveLength(1);
  });
});

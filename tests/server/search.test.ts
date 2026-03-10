import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestContext } from "./helpers.js";
import { createTestContext, validManifestBody } from "./helpers.js";

describe("GET /api/search", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns empty results for query with no matches", async () => {
    const res = await ctx.app.request("/api/search?q=nonexistent");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  test("finds contributions by summary text", async () => {
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validManifestBody({ summary: "Optimize the parser" })),
    });
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        validManifestBody({
          summary: "Fix the renderer",
          createdAt: new Date(Date.now() + 1).toISOString(),
        }),
      ),
    });

    const res = await ctx.app.request("/api/search?q=parser");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].summary).toBe("Optimize the parser");
  });

  test("requires search query parameter", async () => {
    const res = await ctx.app.request("/api/search");
    expect(res.status).toBe(400);
  });

  test("respects pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.app.request("/api/contributions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          validManifestBody({
            summary: `Parser optimization ${i}`,
            createdAt: new Date(Date.now() + i).toISOString(),
          }),
        ),
      });
    }

    const res = await ctx.app.request("/api/search?q=parser&limit=2");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBeLessThanOrEqual(2);
  });

  test("filters by tags", async () => {
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        validManifestBody({ summary: "Parser with tag", tags: ["optimization"] }),
      ),
    });
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        validManifestBody({
          summary: "Parser no tag",
          createdAt: new Date(Date.now() + 1).toISOString(),
        }),
      ),
    });

    const res = await ctx.app.request("/api/search?q=parser&tags=optimization");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].summary).toBe("Parser with tag");
  });
});

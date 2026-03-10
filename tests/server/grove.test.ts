import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestContext } from "./helpers.js";
import { createTestContext, validManifestBody } from "./helpers.js";

describe("GET /api/grove", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns grove metadata", async () => {
    const res = await ctx.app.request("/api/grove");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.version).toBe("0.1.0");
    expect(data.protocol.manifestVersion).toBe(1);
    expect(data.stats.contributions).toBe(0);
    expect(data.stats.activeClaims).toBe(0);
  });

  test("stats reflect contributions count", async () => {
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validManifestBody()),
    });

    const res = await ctx.app.request("/api/grove");
    const data = await res.json();
    expect(data.stats.contributions).toBe(1);
  });

  test("stats reflect active claims count", async () => {
    await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetRef: "some-target",
        agent: { agentId: "agent-1" },
        intentSummary: "Working on it",
      }),
    });

    const res = await ctx.app.request("/api/grove");
    const data = await res.json();
    expect(data.stats.activeClaims).toBe(1);
  });
});

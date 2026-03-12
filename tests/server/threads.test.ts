import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestContext } from "./helpers.js";
import { createTestContext, validManifestBody } from "./helpers.js";

// ---------------------------------------------------------------------------
// GET /api/threads/:cid — View a discussion thread
// ---------------------------------------------------------------------------

describe("GET /api/threads/:cid", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns thread with root and replies", async () => {
    // Create root discussion
    const rootRes = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validManifestBody({ kind: "discussion", summary: "Root topic" })),
    });
    const root = (await rootRes.json()) as { cid: string };

    // Create reply
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        validManifestBody({
          kind: "discussion",
          summary: "Reply message",
          relations: [{ targetCid: root.cid, relationType: "responds_to" }],
          createdAt: new Date(Date.now() + 1000).toISOString(),
        }),
      ),
    });

    const res = await ctx.app.request(`/api/threads/${root.cid}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      nodes: Array<{ cid: string; depth: number }>;
      count: number;
    };
    expect(data.nodes).toHaveLength(2);
    expect(data.nodes[0]?.depth).toBe(0);
    expect(data.nodes[1]?.depth).toBe(1);
  });

  test("returns 404 for non-existent CID", async () => {
    const fakeCid = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
    const res = await ctx.app.request(`/api/threads/${fakeCid}`);
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("NOT_FOUND");
  });

  test("returns 400 for invalid CID format", async () => {
    const res = await ctx.app.request("/api/threads/invalid-cid");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/threads — List active threads
// ---------------------------------------------------------------------------

describe("GET /api/threads", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns empty array when no threads", async () => {
    const res = await ctx.app.request("/api/threads");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { threads: unknown[]; count: number };
    expect(data).toEqual({ threads: [], count: 0 });
  });

  test("returns threads sorted by reply count", async () => {
    // Thread A: 2 replies
    const rootARes = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validManifestBody({ kind: "discussion", summary: "Thread A" })),
    });
    const rootA = (await rootARes.json()) as { cid: string };

    for (let i = 0; i < 2; i++) {
      await ctx.app.request("/api/contributions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          validManifestBody({
            kind: "discussion",
            summary: `Reply to A ${i}`,
            relations: [{ targetCid: rootA.cid, relationType: "responds_to" }],
            createdAt: new Date(Date.now() + 1000 * (i + 1)).toISOString(),
          }),
        ),
      });
    }

    // Thread B: 1 reply
    const rootBRes = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        validManifestBody({
          kind: "discussion",
          summary: "Thread B",
          createdAt: new Date(Date.now() + 5000).toISOString(),
        }),
      ),
    });
    const rootB = (await rootBRes.json()) as { cid: string };

    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        validManifestBody({
          kind: "discussion",
          summary: "Reply to B",
          relations: [{ targetCid: rootB.cid, relationType: "responds_to" }],
          createdAt: new Date(Date.now() + 6000).toISOString(),
        }),
      ),
    });

    const res = await ctx.app.request("/api/threads");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      threads: Array<{ cid: string; replyCount: number }>;
      count: number;
    };
    expect(data.threads).toHaveLength(2);
    // Thread A has more replies, should come first
    expect(data.threads[0]?.replyCount).toBe(2);
    expect(data.threads[1]?.replyCount).toBe(1);
  });

  test("respects limit query parameter", async () => {
    // Create 3 threads with replies
    for (let i = 0; i < 3; i++) {
      const rootRes = await ctx.app.request("/api/contributions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          validManifestBody({
            kind: "discussion",
            summary: `Thread ${i}`,
            createdAt: new Date(Date.now() + i * 2000).toISOString(),
          }),
        ),
      });
      const root = (await rootRes.json()) as { cid: string };

      await ctx.app.request("/api/contributions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          validManifestBody({
            kind: "discussion",
            summary: `Reply ${i}`,
            relations: [{ targetCid: root.cid, relationType: "responds_to" }],
            createdAt: new Date(Date.now() + i * 2000 + 1000).toISOString(),
          }),
        ),
      });
    }

    const res = await ctx.app.request("/api/threads?limit=2");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { threads: unknown[]; count: number };
    expect(data.threads).toHaveLength(2);
  });
});

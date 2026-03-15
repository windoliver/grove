/**
 * Route-level integration tests for routes without dedicated per-domain files.
 *
 * Per-domain coverage lives in dedicated test files:
 *   - claims.test.ts        — POST/PATCH/GET /api/claims
 *   - contributions.test.ts — POST/GET /api/contributions, artifact downloads
 *   - frontier.test.ts      — GET /api/frontier (filters, pagination)
 *   - search.test.ts        — GET /api/search
 *   - outcomes.test.ts      — POST/GET /api/outcomes, stats
 *   - threads.test.ts       — GET /api/threads
 *   - dag.test.ts           — GET /api/dag children/ancestors
 *   - grove.test.ts         — GET /api/grove metadata, gossip status, stats
 *   - integration.test.ts   — multi-endpoint workflow tests
 *   - error-handling.test.ts — error-handler middleware unit tests
 *
 * This file covers routes that do NOT yet have their own per-domain file:
 *   - Diff   (/api/diff)
 *   - Gossip (/api/gossip) — not-configured 501 responses
 *   - Grove  (/api/grove/topology) — topology endpoint only
 *   - Bounties (/api/bounties) — not-configured 501 responses
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestContext } from "./helpers.js";
import { createTestContext, postContribution } from "./helpers.js";

const FAKE_CID = `blake3:${"0".repeat(64)}`;

// ===================================================================
// 1. Diff route (/api/diff)
// ===================================================================

describe("routes — /api/diff", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("GET /:parentCid/:childCid/:artifactName returns both artifact texts", async () => {
    // Pre-store artifact blobs in CAS
    const parentContent = new TextEncoder().encode("version 1");
    const childContent = new TextEncoder().encode("version 2");
    const parentHash = await ctx.cas.put(parentContent, { mediaType: "text/plain" });
    const childHash = await ctx.cas.put(childContent, { mediaType: "text/plain" });

    // Create parent and child contributions with the artifact
    const parent = await postContribution(ctx, {
      summary: "Parent diff",
      artifacts: { "file.txt": parentHash },
    });
    const child = await postContribution(ctx, {
      summary: "Child diff",
      artifacts: { "file.txt": childHash },
      relations: [{ targetCid: parent.cid, relationType: "derives_from" }],
      createdAt: new Date(Date.now() + 1).toISOString(),
    });

    const res = await ctx.app.request(`/api/diff/${parent.cid}/${child.cid}/file.txt`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { parent: string; child: string };
    expect(data.parent).toBe("version 1");
    expect(data.child).toBe("version 2");
  });

  test("GET /:parentCid/:childCid/:artifactName returns 404 for non-existent parent", async () => {
    const child = await postContribution(ctx, { summary: "Orphan child" });

    const res = await ctx.app.request(`/api/diff/${FAKE_CID}/${child.cid}/file.txt`);
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain(FAKE_CID);
  });

  test("GET /:parentCid/:childCid/:artifactName returns 404 for non-existent child", async () => {
    const parent = await postContribution(ctx, { summary: "Lonely parent" });

    const res = await ctx.app.request(`/api/diff/${parent.cid}/${FAKE_CID}/file.txt`);
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain(FAKE_CID);
  });

  test("GET /:parentCid/:childCid/:artifactName returns 404 when artifact missing in parent", async () => {
    const parent = await postContribution(ctx, { summary: "No artifact parent" });
    const child = await postContribution(ctx, {
      summary: "No artifact child",
      createdAt: new Date(Date.now() + 1).toISOString(),
    });

    const res = await ctx.app.request(`/api/diff/${parent.cid}/${child.cid}/missing.txt`);
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("missing.txt");
  });

  test("GET /:parentCid/:childCid/:artifactName returns 404 when artifact missing in child only", async () => {
    const content = new TextEncoder().encode("parent only");
    const hash = await ctx.cas.put(content, { mediaType: "text/plain" });

    const parent = await postContribution(ctx, {
      summary: "Has artifact",
      artifacts: { "file.txt": hash },
    });
    const child = await postContribution(ctx, {
      summary: "Missing artifact",
      createdAt: new Date(Date.now() + 1).toISOString(),
    });

    const res = await ctx.app.request(`/api/diff/${parent.cid}/${child.cid}/file.txt`);
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("file.txt");
  });
});

// ===================================================================
// 2. Gossip route (/api/gossip)
// ===================================================================

describe("routes — /api/gossip", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("GET /peers returns 501 when gossip is not configured", async () => {
    const res = await ctx.app.request("/api/gossip/peers");
    expect(res.status).toBe(501);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe("NOT_CONFIGURED");
    expect(data.error.message).toContain("Gossip");
  });

  test("GET /frontier returns 501 when gossip is not configured", async () => {
    const res = await ctx.app.request("/api/gossip/frontier");
    expect(res.status).toBe(501);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe("NOT_CONFIGURED");
  });

  test("POST /exchange returns 501 when gossip is not configured", async () => {
    const res = await ctx.app.request("/api/gossip/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peerId: "peer-x",
        frontier: [],
        load: { queueDepth: 0 },
        capabilities: {},
        timestamp: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(501);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("NOT_CONFIGURED");
  });

  test("POST /shuffle returns 501 when gossip is not configured", async () => {
    const res = await ctx.app.request("/api/gossip/shuffle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: {
          peerId: "peer-y",
          address: "http://localhost:9999",
          age: 0,
          lastSeen: new Date().toISOString(),
        },
        offered: [],
      }),
    });
    expect(res.status).toBe(501);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("NOT_CONFIGURED");
  });
});

// ===================================================================
// 3. Grove topology (/api/grove/topology)
// ===================================================================

describe("routes — /api/grove/topology", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("GET /topology returns 404 when topology is not configured", async () => {
    const res = await ctx.app.request("/api/grove/topology");
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("Topology");
  });
});

// ===================================================================
// 4. Bounties route (/api/bounties)
// ===================================================================

describe("routes — /api/bounties", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("GET / returns 501 when bountyStore is not configured", async () => {
    const res = await ctx.app.request("/api/bounties");
    expect(res.status).toBe(501);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe("NOT_CONFIGURED");
    expect(data.error.message).toContain("Bounty");
  });

  test("GET /:id returns 501 when bountyStore is not configured", async () => {
    const res = await ctx.app.request("/api/bounties/some-bounty-id");
    expect(res.status).toBe(501);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe("NOT_CONFIGURED");
    expect(data.error.message).toContain("Bounty");
  });

  test("GET / with query params still returns 501 when not configured", async () => {
    const res = await ctx.app.request("/api/bounties?status=open&creatorAgentId=agent-1&limit=10");
    expect(res.status).toBe(501);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("NOT_CONFIGURED");
  });
});

/**
 * Route-level integration tests for the remaining grove HTTP server routes.
 *
 * Covers: DAG, Diff, Gossip, Grove, Outcomes, Threads, Bounties.
 * Each test exercises real stores wired through createApp() — no mocks,
 * no running server.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestContext } from "./helpers.js";
import { createTestContext, validManifestBody } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const FAKE_CID = `blake3:${"0".repeat(64)}`;

// ===================================================================
// 1. DAG route (/api/dag)
// ===================================================================

describe("routes — /api/dag", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  // --- GET /:cid/children ---

  test("GET /:cid/children returns empty array for CID with no children", async () => {
    const parent = await postContribution(ctx, { summary: "Parent node" });

    const res = await ctx.app.request(`/api/dag/${parent.cid}/children`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  test("GET /:cid/children returns children that reference the CID", async () => {
    const parent = await postContribution(ctx, { summary: "Parent" });
    await postContribution(ctx, {
      summary: "Child",
      relations: [{ targetCid: parent.cid, relationType: "derives_from" }],
      createdAt: new Date(Date.now() + 1).toISOString(),
    });

    const res = await ctx.app.request(`/api/dag/${parent.cid}/children`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ summary: string }>;
    expect(data).toHaveLength(1);
    expect(data[0].summary).toBe("Child");
  });

  test("GET /:cid/children returns empty array for non-existent CID", async () => {
    const res = await ctx.app.request(`/api/dag/${FAKE_CID}/children`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  test("GET /:cid/children returns 400 for invalid CID format", async () => {
    const res = await ctx.app.request("/api/dag/invalid-cid/children");
    expect(res.status).toBe(400);
  });

  // --- GET /:cid/ancestors ---

  test("GET /:cid/ancestors returns ancestors that the CID references", async () => {
    const ancestor = await postContribution(ctx, { summary: "Ancestor" });
    const descendant = await postContribution(ctx, {
      summary: "Descendant",
      relations: [{ targetCid: ancestor.cid, relationType: "derives_from" }],
      createdAt: new Date(Date.now() + 1).toISOString(),
    });

    const res = await ctx.app.request(`/api/dag/${descendant.cid}/ancestors`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ summary: string }>;
    expect(data).toHaveLength(1);
    expect(data[0].summary).toBe("Ancestor");
  });

  test("GET /:cid/ancestors returns empty array for CID with no relations", async () => {
    const contribution = await postContribution(ctx);

    const res = await ctx.app.request(`/api/dag/${contribution.cid}/ancestors`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  test("GET /:cid/ancestors returns 400 for invalid CID format", async () => {
    const res = await ctx.app.request("/api/dag/not-valid/ancestors");
    expect(res.status).toBe(400);
  });
});

// ===================================================================
// 2. Diff route (/api/diff)
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
// 3. Gossip route (/api/gossip)
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
// 4. Grove route (/api/grove)
// ===================================================================

describe("routes — /api/grove", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("GET / returns grove metadata with version and stats", async () => {
    const res = await ctx.app.request("/api/grove");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      version: string;
      protocol: { manifestVersion: number };
      stats: { contributions: number; activeClaims: number };
      gossip: { enabled: boolean };
    };
    expect(data.version).toBe("0.1.0");
    expect(data.protocol.manifestVersion).toBe(1);
    expect(data.stats.contributions).toBe(0);
    expect(data.stats.activeClaims).toBe(0);
    expect(data.gossip.enabled).toBe(false);
  });

  test("GET / reflects contribution count after adding contributions", async () => {
    await postContribution(ctx, { summary: "First" });
    await postContribution(ctx, {
      summary: "Second",
      createdAt: new Date(Date.now() + 1).toISOString(),
    });

    const res = await ctx.app.request("/api/grove");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stats: { contributions: number } };
    expect(data.stats.contributions).toBe(2);
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
// 5. Outcomes route (/api/outcomes)
// ===================================================================

describe("routes — /api/outcomes", () => {
  let ctx: TestContext;

  const VALID_CID = `blake3:${"a".repeat(64)}`;
  const VALID_CID_2 = `blake3:${"b".repeat(64)}`;

  function outcomeBody(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
      status: "accepted",
      reason: "Meets all criteria",
      evaluatedBy: "reviewer-1",
      ...overrides,
    };
  }

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  // --- POST /:cid ---

  test("POST /:cid sets outcome and returns 201", async () => {
    const res = await ctx.app.request(`/api/outcomes/${VALID_CID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcomeBody()),
    });

    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      cid: string;
      status: string;
      reason: string;
      evaluatedBy: string;
      evaluatedAt: string;
    };
    expect(data.cid).toBe(VALID_CID);
    expect(data.status).toBe("accepted");
    expect(data.reason).toBe("Meets all criteria");
    expect(data.evaluatedBy).toBe("reviewer-1");
    expect(data.evaluatedAt).toBeTruthy();
  });

  test("POST /:cid returns 400 for invalid status value", async () => {
    const res = await ctx.app.request(`/api/outcomes/${VALID_CID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "bogus", evaluatedBy: "agent-1" }),
    });

    expect(res.status).toBe(400);
  });

  test("POST /:cid returns 400 for invalid CID format", async () => {
    const res = await ctx.app.request("/api/outcomes/not-a-cid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcomeBody()),
    });

    expect(res.status).toBe(400);
  });

  // --- GET /:cid ---

  test("GET /:cid returns the outcome after it is set", async () => {
    await ctx.app.request(`/api/outcomes/${VALID_CID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcomeBody()),
    });

    const res = await ctx.app.request(`/api/outcomes/${VALID_CID}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { cid: string; status: string };
    expect(data.cid).toBe(VALID_CID);
    expect(data.status).toBe("accepted");
  });

  test("GET /:cid returns 404 for CID with no outcome", async () => {
    const res = await ctx.app.request(`/api/outcomes/${VALID_CID}`);
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error).toBeTruthy();
  });

  // --- GET / ---

  test("GET / lists all outcomes", async () => {
    await ctx.app.request(`/api/outcomes/${VALID_CID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcomeBody({ status: "accepted" })),
    });
    await ctx.app.request(`/api/outcomes/${VALID_CID_2}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcomeBody({ status: "rejected" })),
    });

    const res = await ctx.app.request("/api/outcomes");
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ cid: string }>;
    expect(data).toHaveLength(2);
  });

  test("GET / filters outcomes by status", async () => {
    await ctx.app.request(`/api/outcomes/${VALID_CID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcomeBody({ status: "accepted" })),
    });
    await ctx.app.request(`/api/outcomes/${VALID_CID_2}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcomeBody({ status: "rejected" })),
    });

    const res = await ctx.app.request("/api/outcomes?status=rejected");
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ cid: string; status: string }>;
    expect(data).toHaveLength(1);
    expect(data[0].status).toBe("rejected");
    expect(data[0].cid).toBe(VALID_CID_2);
  });

  // --- GET /stats ---

  test("GET /stats returns zero stats when no outcomes exist", async () => {
    const res = await ctx.app.request("/api/outcomes/stats");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      total: number;
      accepted: number;
      rejected: number;
      crashed: number;
      invalidated: number;
      acceptanceRate: number;
    };
    expect(data.total).toBe(0);
    expect(data.accepted).toBe(0);
    expect(data.rejected).toBe(0);
    expect(data.crashed).toBe(0);
    expect(data.invalidated).toBe(0);
    expect(data.acceptanceRate).toBe(0);
  });

  test("GET /stats returns correct counts after setting outcomes", async () => {
    await ctx.app.request(`/api/outcomes/${VALID_CID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcomeBody({ status: "accepted" })),
    });
    await ctx.app.request(`/api/outcomes/${VALID_CID_2}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcomeBody({ status: "rejected" })),
    });

    const res = await ctx.app.request("/api/outcomes/stats");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { total: number; accepted: number; rejected: number };
    expect(data.total).toBe(2);
    expect(data.accepted).toBe(1);
    expect(data.rejected).toBe(1);
  });
});

// ===================================================================
// 6. Threads route (/api/threads)
// ===================================================================

describe("routes — /api/threads", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  // --- GET /:cid ---

  test("GET /:cid returns thread with root and replies", async () => {
    const root = await postContribution(ctx, { kind: "discussion", summary: "Root topic" });
    await postContribution(ctx, {
      kind: "discussion",
      summary: "Reply message",
      relations: [{ targetCid: root.cid, relationType: "responds_to" }],
      createdAt: new Date(Date.now() + 1000).toISOString(),
    });

    const res = await ctx.app.request(`/api/threads/${root.cid}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      nodes: Array<{ cid: string; depth: number }>;
      count: number;
    };
    expect(data.nodes).toHaveLength(2);
    expect(data.nodes[0].depth).toBe(0);
    expect(data.nodes[1].depth).toBe(1);
    expect(data.count).toBe(2);
  });

  test("GET /:cid returns 404 for non-existent CID", async () => {
    const res = await ctx.app.request(`/api/threads/${FAKE_CID}`);
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("NOT_FOUND");
  });

  test("GET /:cid returns 400 for invalid CID format", async () => {
    const res = await ctx.app.request("/api/threads/not-a-valid-cid");
    expect(res.status).toBe(400);
  });

  // --- GET / ---

  test("GET / returns empty threads list when no contributions exist", async () => {
    const res = await ctx.app.request("/api/threads");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { threads: unknown[]; count: number };
    expect(data.threads).toEqual([]);
    expect(data.count).toBe(0);
  });

  test("GET / returns threads sorted by reply count", async () => {
    // Thread A: root + 2 replies
    const rootA = await postContribution(ctx, { kind: "discussion", summary: "Thread A" });
    for (let i = 0; i < 2; i++) {
      await postContribution(ctx, {
        kind: "discussion",
        summary: `Reply A-${i}`,
        relations: [{ targetCid: rootA.cid, relationType: "responds_to" }],
        createdAt: new Date(Date.now() + 1000 * (i + 1)).toISOString(),
      });
    }

    // Thread B: root + 1 reply
    const rootB = await postContribution(ctx, {
      kind: "discussion",
      summary: "Thread B",
      createdAt: new Date(Date.now() + 5000).toISOString(),
    });
    await postContribution(ctx, {
      kind: "discussion",
      summary: "Reply B-0",
      relations: [{ targetCid: rootB.cid, relationType: "responds_to" }],
      createdAt: new Date(Date.now() + 6000).toISOString(),
    });

    const res = await ctx.app.request("/api/threads");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      threads: Array<{ cid: string; replyCount: number }>;
      count: number;
    };
    expect(data.threads).toHaveLength(2);
    // Thread A has more replies, should come first
    expect(data.threads[0].replyCount).toBe(2);
    expect(data.threads[1].replyCount).toBe(1);
  });

  test("GET / respects limit query parameter", async () => {
    // Create 3 threads with replies
    for (let i = 0; i < 3; i++) {
      const root = await postContribution(ctx, {
        kind: "discussion",
        summary: `Thread ${i}`,
        createdAt: new Date(Date.now() + i * 2000).toISOString(),
      });
      await postContribution(ctx, {
        kind: "discussion",
        summary: `Reply ${i}`,
        relations: [{ targetCid: root.cid, relationType: "responds_to" }],
        createdAt: new Date(Date.now() + i * 2000 + 1000).toISOString(),
      });
    }

    const res = await ctx.app.request("/api/threads?limit=2");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { threads: unknown[]; count: number };
    expect(data.threads).toHaveLength(2);
  });
});

// ===================================================================
// 7. Bounties route (/api/bounties)
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

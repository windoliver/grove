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
import { type Handoff, type HandoffInput, HandoffStatus } from "../../src/core/handoff.js";
import { InMemoryHandoffStore } from "../../src/core/in-memory-handoff-store.js";
import { createApp } from "../../src/server/app.js";
import type { TestContext } from "./helpers.js";
import {
  createTestContext,
  postContribution,
  TEST_AUTH_HEADERS,
  TEST_KEY,
  TEST_NAMESPACE,
} from "./helpers.js";

const FAKE_CID = `blake3:${"0".repeat(64)}`;

class CreateFailingHandoffStore extends InMemoryHandoffStore {
  private shouldFailCreate = false;

  failNextCreate(): void {
    this.shouldFailCreate = true;
  }

  override async create(input: HandoffInput): Promise<Handoff> {
    if (this.shouldFailCreate) {
      this.shouldFailCreate = false;
      throw new Error("simulated replacement create failure");
    }
    return super.create(input);
  }
}

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

    const res = await ctx.app.request(`/api/diff/${parent.cid}/${child.cid}/file.txt`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { parent: string; child: string };
    expect(data.parent).toBe("version 1");
    expect(data.child).toBe("version 2");
  });

  test("GET /:parentCid/:childCid/:artifactName returns 404 for non-existent parent", async () => {
    const child = await postContribution(ctx, { summary: "Orphan child" });

    const res = await ctx.app.request(`/api/diff/${FAKE_CID}/${child.cid}/file.txt`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain(FAKE_CID);
  });

  test("GET /:parentCid/:childCid/:artifactName returns 404 for non-existent child", async () => {
    const parent = await postContribution(ctx, { summary: "Lonely parent" });

    const res = await ctx.app.request(`/api/diff/${parent.cid}/${FAKE_CID}/file.txt`, {
      headers: TEST_AUTH_HEADERS,
    });
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

    const res = await ctx.app.request(`/api/diff/${parent.cid}/${child.cid}/missing.txt`, {
      headers: TEST_AUTH_HEADERS,
    });
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

    const res = await ctx.app.request(`/api/diff/${parent.cid}/${child.cid}/file.txt`, {
      headers: TEST_AUTH_HEADERS,
    });
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
    const res = await ctx.app.request("/api/gossip/peers", { headers: TEST_AUTH_HEADERS });
    expect(res.status).toBe(501);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe("NOT_CONFIGURED");
    expect(data.error.message).toContain("Gossip");
  });

  test("GET /frontier returns 501 when gossip is not configured", async () => {
    const res = await ctx.app.request("/api/gossip/frontier", { headers: TEST_AUTH_HEADERS });
    expect(res.status).toBe(501);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe("NOT_CONFIGURED");
  });

  test("POST /exchange returns 501 when gossip is not configured", async () => {
    const res = await ctx.app.request("/api/gossip/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
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
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
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
    const res = await ctx.app.request("/api/grove/topology", { headers: TEST_AUTH_HEADERS });
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
    const res = await ctx.app.request("/api/bounties", { headers: TEST_AUTH_HEADERS });
    expect(res.status).toBe(501);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe("NOT_CONFIGURED");
    expect(data.error.message).toContain("Bounty");
  });

  test("GET /:id returns 501 when bountyStore is not configured", async () => {
    const res = await ctx.app.request("/api/bounties/some-bounty-id", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(501);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe("NOT_CONFIGURED");
    expect(data.error.message).toContain("Bounty");
  });

  test("GET / with query params still returns 501 when not configured", async () => {
    const res = await ctx.app.request("/api/bounties?status=open&creatorAgentId=agent-1&limit=10", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(501);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("NOT_CONFIGURED");
  });

  test("GET / rejects invalid limit before hitting storage", async () => {
    const res = await ctx.app.request("/api/bounties?limit=-1", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(400);
  });
});

// ===================================================================
// 5. Handoffs route (/api/handoffs)
// ===================================================================

describe("routes — /api/handoffs", () => {
  let ctx: TestContext;
  let handoffStore: InMemoryHandoffStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    ctx = await createTestContext();
    handoffStore = new InMemoryHandoffStore();
    app = createApp({ ...ctx.deps, handoffStore }, new Map([[TEST_KEY, TEST_NAMESPACE]]));
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("GET / rejects negative limit", async () => {
    const res = await app.request("/api/handoffs?limit=-1", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(400);
  });

  test("GET / accepts operator terminal status filters", async () => {
    const cancelled = await handoffStore.create({
      sourceCid: FAKE_CID,
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
    });
    await handoffStore.markCancelled(cancelled.handoffId, {
      terminalReason: "operator cancelled",
    });

    const expired = await handoffStore.create({
      sourceCid: FAKE_CID,
      fromRole: "coder",
      toRole: "tester",
      requiresReply: true,
      replyDueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await handoffStore.expireStale();
    await handoffStore.markManuallyResolved(expired.handoffId, {
      terminalReason: "operator handled offline",
    });

    const cancelledRes = await app.request(
      `/api/handoffs?status=${HandoffStatus.Cancelled}&limit=10`,
      { headers: TEST_AUTH_HEADERS },
    );
    expect(cancelledRes.status).toBe(200);
    const cancelledData = (await cancelledRes.json()) as {
      handoffs: readonly { handoffId: string; status: string }[];
    };
    expect(cancelledData.handoffs.find((h) => h.handoffId === cancelled.handoffId)?.status).toBe(
      HandoffStatus.Cancelled,
    );

    const resolvedRes = await app.request(
      `/api/handoffs?status=${HandoffStatus.ManuallyResolved}&limit=10`,
      { headers: TEST_AUTH_HEADERS },
    );
    expect(resolvedRes.status).toBe(200);
    const resolvedData = (await resolvedRes.json()) as {
      handoffs: readonly { handoffId: string; status: string }[];
    };
    expect(resolvedData.handoffs.find((h) => h.handoffId === expired.handoffId)?.status).toBe(
      HandoffStatus.ManuallyResolved,
    );
  });

  test("POST /:id/cancel marks unresolved handoff cancelled", async () => {
    const handoff = await handoffStore.create({
      sourceCid: FAKE_CID,
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
    });

    const res = await app.request(`/api/handoffs/${handoff.handoffId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ reason: "operator stopped waiting" }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; terminalReason?: string };
    expect(data.status).toBe(HandoffStatus.Cancelled);
    expect(data.terminalReason).toBe("operator stopped waiting");
  });

  test("POST /:id/cancel rejects non-object JSON body", async () => {
    const handoff = await handoffStore.create({
      sourceCid: FAKE_CID,
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
    });

    const res = await app.request(`/api/handoffs/${handoff.handoffId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify([]),
    });

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("VALIDATION_ERROR");

    const stored = await handoffStore.get(handoff.handoffId);
    expect(stored?.status).toBe(HandoffStatus.PendingPickup);
    expect(stored?.terminalReason).toBeUndefined();
  });

  test("POST /:id/cancel rejects malformed non-empty JSON body", async () => {
    const handoff = await handoffStore.create({
      sourceCid: FAKE_CID,
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
    });

    const res = await app.request(`/api/handoffs/${handoff.handoffId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: "{",
    });

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("VALIDATION_ERROR");

    const stored = await handoffStore.get(handoff.handoffId);
    expect(stored?.status).toBe(HandoffStatus.PendingPickup);
    expect(stored?.terminalReason).toBeUndefined();
  });

  test("POST /:id/manual-resolve marks dead-lettered handoff manually resolved", async () => {
    const handoff = await handoffStore.create({
      sourceCid: FAKE_CID,
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
    });
    await handoffStore.markDeadLettered(handoff.handoffId);

    const res = await app.request(`/api/handoffs/${handoff.handoffId}/manual-resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ reason: "handled in terminal" }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; terminalReason?: string };
    expect(data.status).toBe(HandoffStatus.ManuallyResolved);
    expect(data.terminalReason).toBe("handled in terminal");
  });

  test("POST /:id/resend creates replacement handoff and cancels original", async () => {
    const handoff = await handoffStore.create({
      sourceCid: FAKE_CID,
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
    });
    await handoffStore.markDeadLettered(handoff.handoffId);

    const res = await app.request(`/api/handoffs/${handoff.handoffId}/resend`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ reason: "retry delivery" }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      original: {
        handoffId: string;
        status: string;
        replacementHandoffId?: string;
        terminalReason?: string;
      };
      replacement: { handoffId: string; toRole: string; status: string };
    };
    expect(data.original.status).toBe(HandoffStatus.Cancelled);
    expect(data.original.terminalReason).toBe("retry delivery");
    expect(data.original.replacementHandoffId).toBe(data.replacement.handoffId);
    expect(data.replacement.toRole).toBe(handoff.toRole);
    expect(data.replacement.status).toBe(HandoffStatus.PendingPickup);
  });

  test("POST /:id/resend on ineligible original returns 409 without creating replacement", async () => {
    const handoff = await handoffStore.create({
      sourceCid: FAKE_CID,
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
    });
    await handoffStore.markDelivered(handoff.handoffId);
    await handoffStore.markReplied(handoff.handoffId, FAKE_CID);
    const beforeCount = (await handoffStore.list()).length;

    const res = await app.request(`/api/handoffs/${handoff.handoffId}/resend`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ reason: "retry delivery" }),
    });

    expect(res.status).toBe(409);
    const after = await handoffStore.list();
    expect(after).toHaveLength(beforeCount);
    expect(after.find((h) => h.handoffId !== handoff.handoffId)).toBeUndefined();
  });

  test("POST /:id/resend leaves original unchanged when replacement create fails", async () => {
    const failingStore = new CreateFailingHandoffStore();
    const failingApp = createApp(
      { ...ctx.deps, handoffStore: failingStore },
      new Map([[TEST_KEY, TEST_NAMESPACE]]),
    );
    const handoff = await failingStore.create({
      sourceCid: FAKE_CID,
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
    });
    await failingStore.markDeadLettered(handoff.handoffId);
    failingStore.failNextCreate();

    const res = await failingApp.request(`/api/handoffs/${handoff.handoffId}/resend`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ reason: "retry delivery" }),
    });

    expect(res.status).toBe(500);
    const stored = await failingStore.get(handoff.handoffId);
    expect(stored?.status).toBe(HandoffStatus.DeadLettered);
    expect(stored?.replacementHandoffId).toBeUndefined();

    const handoffs = await failingStore.list();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.handoffId).toBe(handoff.handoffId);
  });

  test("POST /:id/reroute creates replacement handoff for selected role", async () => {
    const handoff = await handoffStore.create({
      sourceCid: FAKE_CID,
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
    });
    await handoffStore.markDeadLettered(handoff.handoffId);

    const res = await app.request(`/api/handoffs/${handoff.handoffId}/reroute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ toRole: "qa", reason: "reviewer unavailable" }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      original: { status: string; replacementHandoffId?: string };
      replacement: { handoffId: string; toRole: string; status: string };
    };
    expect(data.original.status).toBe(HandoffStatus.Cancelled);
    expect(data.original.replacementHandoffId).toBe(data.replacement.handoffId);
    expect(data.replacement.toRole).toBe("qa");
    expect(data.replacement.status).toBe(HandoffStatus.PendingPickup);
  });

  test("POST /:id/reroute on ineligible original returns 409 without creating replacement", async () => {
    const handoff = await handoffStore.create({
      sourceCid: FAKE_CID,
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
    });
    await handoffStore.markDelivered(handoff.handoffId);
    await handoffStore.markReplied(handoff.handoffId, FAKE_CID);
    const beforeCount = (await handoffStore.list()).length;

    const res = await app.request(`/api/handoffs/${handoff.handoffId}/reroute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ toRole: "qa", reason: "reviewer unavailable" }),
    });

    expect(res.status).toBe(409);
    const after = await handoffStore.list();
    expect(after).toHaveLength(beforeCount);
    expect(after.find((h) => h.handoffId !== handoff.handoffId)).toBeUndefined();
  });

  test("explicit session scope does not fall back to global handoff store", async () => {
    const global = await handoffStore.create({
      sourceCid: FAKE_CID,
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
    });
    const scopedApp = createApp(
      {
        ...ctx.deps,
        handoffStore,
        handoffStoreForSession: () => undefined,
      },
      new Map([[TEST_KEY, TEST_NAMESPACE]]),
    );

    const listRes = await scopedApp.request("/api/handoffs?sessionId=missing-session&limit=10", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { handoffs: readonly { handoffId: string }[] };
    expect(listBody.handoffs).toEqual([]);

    const cancelRes = await scopedApp.request(
      `/api/handoffs/${global.handoffId}/cancel?sessionId=missing-session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
        body: JSON.stringify({ reason: "should not touch global" }),
      },
    );
    expect(cancelRes.status).toBe(404);
    const stored = await handoffStore.get(global.handoffId);
    expect(stored?.status).toBe(HandoffStatus.PendingPickup);
    expect(stored?.terminalReason).toBeUndefined();
  });

  test("POST /:id/delivered returns 409 when the handoff cannot transition", async () => {
    const handoff = await handoffStore.create({
      sourceCid: FAKE_CID,
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
    });
    await handoffStore.markDelivered(handoff.handoffId);
    await handoffStore.markReplied(handoff.handoffId, FAKE_CID);

    const res = await app.request(`/api/handoffs/${handoff.handoffId}/delivered`, {
      method: "POST",
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe("STATE_CONFLICT");
    expect(data.error.message).toContain(HandoffStatus.Replied);
  });
});

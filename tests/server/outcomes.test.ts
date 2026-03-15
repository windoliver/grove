import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestContext } from "./helpers.js";
import { createTestContext, outcomeBody } from "./helpers.js";

const VALID_CID = `blake3:${"a".repeat(64)}`;
const VALID_CID_2 = `blake3:${"b".repeat(64)}`;
const VALID_CID_3 = `blake3:${"c".repeat(64)}`;

describe("GET /api/outcomes/stats", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns empty stats initially", async () => {
    const res = await ctx.app.request("/api/outcomes/stats");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      total: 0,
      accepted: 0,
      rejected: 0,
      crashed: 0,
      invalidated: 0,
      acceptanceRate: 0,
    });
  });

  test("returns correct counts after setting outcomes", async () => {
    // Set several outcomes with different statuses
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
    await ctx.app.request(`/api/outcomes/${VALID_CID_3}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcomeBody({ status: "crashed" })),
    });

    const res = await ctx.app.request("/api/outcomes/stats");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(3);
    expect(data.accepted).toBe(1);
    expect(data.rejected).toBe(1);
    expect(data.crashed).toBe(1);
    expect(data.invalidated).toBe(0);
    // acceptanceRate = 1/3
    expect(data.acceptanceRate).toBeCloseTo(1 / 3, 5);
  });
});

describe("POST /api/outcomes/:cid", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("sets outcome and returns 201", async () => {
    const res = await ctx.app.request(`/api/outcomes/${VALID_CID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcomeBody()),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.cid).toBe(VALID_CID);
    expect(data.status).toBe("accepted");
    expect(data.reason).toBe("Looks good");
    expect(data.evaluatedBy).toBe("reviewer-1");
    expect(data.evaluatedAt).toBeTruthy();
  });

  test("returns 400 for invalid body", async () => {
    const res = await ctx.app.request(`/api/outcomes/${VALID_CID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "not-a-valid-status" }),
    });

    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid CID format", async () => {
    const res = await ctx.app.request("/api/outcomes/not-a-valid-cid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcomeBody()),
    });

    expect(res.status).toBe(400);
  });

  test("overwrites existing outcome", async () => {
    // Create initial outcome
    await ctx.app.request(`/api/outcomes/${VALID_CID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcomeBody({ status: "accepted", reason: "First review" })),
    });

    // Overwrite with a different status
    const res = await ctx.app.request(`/api/outcomes/${VALID_CID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcomeBody({ status: "rejected", reason: "Second review" })),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.cid).toBe(VALID_CID);
    expect(data.status).toBe("rejected");
    expect(data.reason).toBe("Second review");

    // Verify via GET that the overwrite persisted
    const getRes = await ctx.app.request(`/api/outcomes/${VALID_CID}`);
    expect(getRes.status).toBe(200);
    const record = await getRes.json();
    expect(record.status).toBe("rejected");
    expect(record.reason).toBe("Second review");
  });
});

describe("GET /api/outcomes/:cid", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("gets the outcome", async () => {
    // Create an outcome first
    await ctx.app.request(`/api/outcomes/${VALID_CID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcomeBody()),
    });

    const res = await ctx.app.request(`/api/outcomes/${VALID_CID}`);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cid).toBe(VALID_CID);
    expect(data.status).toBe("accepted");
    expect(data.reason).toBe("Looks good");
    expect(data.evaluatedBy).toBe("reviewer-1");
    expect(data.evaluatedAt).toBeTruthy();
  });

  test("returns 404 for unknown CID", async () => {
    const res = await ctx.app.request(`/api/outcomes/${VALID_CID}`);

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBeTruthy();
  });
});

describe("GET /api/outcomes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("lists outcomes", async () => {
    // Create two outcomes
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
    const data = await res.json();
    expect(data).toHaveLength(2);
  });

  test("filters by status", async () => {
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

    const res = await ctx.app.request("/api/outcomes?status=accepted");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].status).toBe("accepted");
    expect(data[0].cid).toBe(VALID_CID);
  });

  test("GET /api/outcomes?cids=cid1,cid2 returns matching outcomes", async () => {
    // Create two outcomes
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

    const res = await ctx.app.request(
      `/api/outcomes?cids=${encodeURIComponent(`${VALID_CID},${VALID_CID_2}`)}`,
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
    const cids = data.map((d: { cid: string }) => d.cid).sort();
    expect(cids).toEqual([VALID_CID, VALID_CID_2].sort());
  });

  test("GET /api/outcomes?cids= (empty) returns empty array", async () => {
    const res = await ctx.app.request("/api/outcomes?cids=");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  test("GET /api/outcomes?cids=nonexistent returns empty for unknown CIDs", async () => {
    const res = await ctx.app.request(`/api/outcomes?cids=${VALID_CID_3}`);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(0);
  });

  test("GET /api/outcomes?cids=a,b&status=accepted returns 400", async () => {
    const res = await ctx.app.request(
      `/api/outcomes?cids=${VALID_CID},${VALID_CID_2}&status=accepted`,
    );

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });

  test("GET /api/outcomes?cids=a,b&evaluatedBy=x returns 400", async () => {
    const res = await ctx.app.request(
      `/api/outcomes?cids=${VALID_CID},${VALID_CID_2}&evaluatedBy=reviewer-1`,
    );

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });

  test("GET /api/outcomes?cids=a,b&limit=5 returns 400", async () => {
    const res = await ctx.app.request(`/api/outcomes?cids=${VALID_CID},${VALID_CID_2}&limit=5`);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });

  test("GET /api/outcomes?cids=a,b&offset=1 returns 400", async () => {
    const res = await ctx.app.request(`/api/outcomes?cids=${VALID_CID},${VALID_CID_2}&offset=1`);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });
});

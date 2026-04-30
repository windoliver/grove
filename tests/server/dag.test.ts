import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestContext } from "./helpers.js";
import { createTestContext, TEST_AUTH_HEADERS, validManifestBody } from "./helpers.js";

describe("GET /api/dag/:cid/children", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns empty array for CID with no children", async () => {
    const createRes = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(validManifestBody()),
    });
    const parent = await createRes.json();

    const res = await ctx.app.request(`/api/dag/${parent.cid}/children`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  test("returns children that reference the CID", async () => {
    // Create parent
    const parentInput = validManifestBody({ summary: "Parent" });
    const parentRes = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(parentInput),
    });
    const parent = await parentRes.json();

    // Create child that derives_from parent
    const childInput = validManifestBody({
      summary: "Child",
      relations: [{ targetCid: parent.cid, relationType: "derives_from" }],
      createdAt: new Date(Date.now() + 1).toISOString(),
    });
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(childInput),
    });

    const res = await ctx.app.request(`/api/dag/${parent.cid}/children`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].summary).toBe("Child");
  });

  test("returns empty array for non-existent CID", async () => {
    const fakeCid = `blake3:${"c".repeat(64)}`;
    const res = await ctx.app.request(`/api/dag/${fakeCid}/children`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  test("returns 400 for invalid CID format", async () => {
    const res = await ctx.app.request("/api/dag/invalid-cid/children", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/dag/:cid/ancestors", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns ancestors that the CID references", async () => {
    // Create ancestor
    const ancestorInput = validManifestBody({ summary: "Ancestor" });
    const ancestorRes = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(ancestorInput),
    });
    const ancestor = await ancestorRes.json();

    // Create descendant that derives_from ancestor
    const descendantInput = validManifestBody({
      summary: "Descendant",
      relations: [{ targetCid: ancestor.cid, relationType: "derives_from" }],
      createdAt: new Date(Date.now() + 1).toISOString(),
    });
    const descRes = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(descendantInput),
    });
    const descendant = await descRes.json();

    const res = await ctx.app.request(`/api/dag/${descendant.cid}/ancestors`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].summary).toBe("Ancestor");
  });

  test("returns empty array for CID with no relations", async () => {
    const createRes = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(validManifestBody()),
    });
    const contribution = await createRes.json();

    const res = await ctx.app.request(`/api/dag/${contribution.cid}/ancestors`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });
});

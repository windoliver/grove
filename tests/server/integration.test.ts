import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestContext } from "./helpers.js";
import { createTestContext, validManifestBody } from "./helpers.js";

describe("multi-endpoint integration", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("submit → query → download artifact flow", async () => {
    // 1. Submit a contribution with an artifact via multipart
    const manifest = validManifestBody({ summary: "ML model" });
    const formData = new FormData();
    formData.append("manifest", JSON.stringify(manifest));
    formData.append(
      "artifact:model.bin",
      new File([new Uint8Array([0xde, 0xad, 0xbe, 0xef])], "model.bin", {
        type: "application/octet-stream",
      }),
    );

    const submitRes = await ctx.app.request("/api/contributions", {
      method: "POST",
      body: formData,
    });
    expect(submitRes.status).toBe(201);
    const contribution = await submitRes.json();

    // 2. Query it back via GET
    const getRes = await ctx.app.request(`/api/contributions/${contribution.cid}`);
    expect(getRes.status).toBe(200);
    const queried = await getRes.json();
    expect(queried.cid).toBe(contribution.cid);
    expect(queried.artifacts["model.bin"]).toMatch(/^blake3:/);

    // 3. Download the artifact
    const dlRes = await ctx.app.request(
      `/api/contributions/${contribution.cid}/artifacts/model.bin`,
    );
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get("content-type")).toBe("application/octet-stream");
    const body = new Uint8Array(await dlRes.arrayBuffer());
    expect(body).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

    // 4. It appears in list
    const listRes = await ctx.app.request("/api/contributions");
    const list = await listRes.json();
    expect(list).toHaveLength(1);

    // 5. It appears in frontier
    const frontierRes = await ctx.app.request("/api/frontier");
    const frontier = await frontierRes.json();
    expect(frontier.byRecency).toHaveLength(1);

    // 6. Searchable
    const searchRes = await ctx.app.request("/api/search?q=ML+model");
    const searchResults = await searchRes.json();
    expect(searchResults.results).toHaveLength(1);
  });

  test("contribution DAG traversal: parent → child → grandchild", async () => {
    // Create parent
    const p = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validManifestBody({ summary: "Root" })),
    });
    const parent = await p.json();

    // Create child
    const c = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        validManifestBody({
          summary: "Child",
          relations: [{ targetCid: parent.cid, relationType: "derives_from" }],
          createdAt: new Date(Date.now() + 1).toISOString(),
        }),
      ),
    });
    const child = await c.json();

    // Create grandchild
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        validManifestBody({
          summary: "Grandchild",
          relations: [{ targetCid: child.cid, relationType: "derives_from" }],
          createdAt: new Date(Date.now() + 2).toISOString(),
        }),
      ),
    });

    // Parent's children = [child]
    const childrenRes = await ctx.app.request(`/api/dag/${parent.cid}/children`);
    const children = await childrenRes.json();
    expect(children).toHaveLength(1);
    expect(children[0].summary).toBe("Child");

    // Child's ancestors = [parent]
    const ancestorsRes = await ctx.app.request(`/api/dag/${child.cid}/ancestors`);
    const ancestors = await ancestorsRes.json();
    expect(ancestors).toHaveLength(1);
    expect(ancestors[0].summary).toBe("Root");
  });

  test("claim lifecycle through HTTP API", async () => {
    // Create claim
    const createRes = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetRef: "optimize-parser",
        agent: { agentId: "agent-1" },
        intentSummary: "Optimizing parser performance",
      }),
    });
    expect(createRes.status).toBe(201);
    const claim = await createRes.json();

    // Verify it shows in grove stats
    const groveRes = await ctx.app.request("/api/grove");
    const grove = await groveRes.json();
    expect(grove.stats.activeClaims).toBe(1);

    // Heartbeat
    const hbRes = await ctx.app.request(`/api/claims/${claim.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "heartbeat" }),
    });
    expect(hbRes.status).toBe(200);

    // Complete
    const completeRes = await ctx.app.request(`/api/claims/${claim.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete" }),
    });
    expect(completeRes.status).toBe(200);

    // Active claims now zero
    const groveRes2 = await ctx.app.request("/api/grove");
    const grove2 = await groveRes2.json();
    expect(grove2.stats.activeClaims).toBe(0);
  });
});

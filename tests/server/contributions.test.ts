import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ContributionQuery, ContributionStore } from "../../src/core/store.js";
import { createApp } from "../../src/server/app.js";
import type { TestContext } from "./helpers.js";
import {
  createTestContext,
  TEST_AUTH_HEADERS,
  TEST_KEY,
  TEST_NAMESPACE,
  validManifestBody,
} from "./helpers.js";

describe("POST /api/contributions", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("creates a contribution from JSON body", async () => {
    const body = validManifestBody();

    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
    expect(data.kind).toBe("work");
    expect(data.summary).toBe("Test contribution");
  });

  test("creates a contribution with no artifacts (metadata-only)", async () => {
    const body = validManifestBody({ artifacts: {} });

    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(Object.keys(data.artifacts)).toHaveLength(0);
  });

  test("creates a contribution via multipart with artifacts", async () => {
    const manifest = validManifestBody();
    const formData = new FormData();
    formData.append("manifest", JSON.stringify(manifest));
    formData.append(
      "artifact:main.py",
      new File([new TextEncoder().encode("print('hello')")], "main.py", {
        type: "text/x-python",
      }),
    );

    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: TEST_AUTH_HEADERS,
      body: formData,
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.artifacts["main.py"]).toMatch(/^blake3:[0-9a-f]{64}$/);
  });

  test("creates a contribution via multipart with multiple artifacts", async () => {
    const manifest = validManifestBody();
    const formData = new FormData();
    formData.append("manifest", JSON.stringify(manifest));
    formData.append(
      "artifact:main.py",
      new File([new TextEncoder().encode("print('hello')")], "main.py"),
    );
    formData.append(
      "artifact:README.md",
      new File([new TextEncoder().encode("# Hello")], "README.md"),
    );

    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: TEST_AUTH_HEADERS,
      body: formData,
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(Object.keys(data.artifacts)).toHaveLength(2);
    expect(data.artifacts["main.py"]).toMatch(/^blake3:/);
    expect(data.artifacts["README.md"]).toMatch(/^blake3:/);
  });

  test("rejects multipart without manifest part", async () => {
    const formData = new FormData();
    formData.append("artifact:main.py", new File([new Uint8Array(0)], "main.py"));

    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: TEST_AUTH_HEADERS,
      body: formData,
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });

  test("rejects invalid manifest JSON", async () => {
    const formData = new FormData();
    formData.append("manifest", "not valid json{{{");

    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: TEST_AUTH_HEADERS,
      body: formData,
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });

  test("rejects malformed JSON body with 400", async () => {
    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: "not valid json{{{",
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
    expect(data.error.message).toBe("Invalid JSON body");
  });

  test("rejects manifest with unknown fields (strict mode)", async () => {
    const body = {
      ...validManifestBody(),
      unknownField: "should be rejected",
    };

    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("rejects pre-computed artifact hash that does not exist in CAS", async () => {
    const fakeHash = `blake3:${"f".repeat(64)}`;
    const body = validManifestBody({ artifacts: { "ghost.py": fakeHash } });

    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
    expect(data.error.message).toContain("non-existent hash");
  });

  test("rejects manifest missing required fields", async () => {
    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ kind: "work" }),
    });

    expect(res.status).toBe(400);
  });

  test("handles duplicate CID submission idempotently", async () => {
    const body = validManifestBody();

    const res1 = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });
    expect(res1.status).toBe(201);

    // Same body → same CID → idempotent put
    const res2 = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });
    expect(res2.status).toBe(201);
  });

  test("accepts zero-byte artifact", async () => {
    const manifest = validManifestBody();
    const formData = new FormData();
    formData.append("manifest", JSON.stringify(manifest));
    formData.append("artifact:empty", new File([new Uint8Array(0)], "empty"));

    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: TEST_AUTH_HEADERS,
      body: formData,
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.artifacts.empty).toMatch(/^blake3:/);
  });

  test("rejects manifest with invalid kind value", async () => {
    const body = validManifestBody({ kind: "invalid-kind" });
    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("rejects manifest with empty summary", async () => {
    const body = validManifestBody({ summary: "" });
    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("rejects manifest with empty agentId", async () => {
    const body = validManifestBody({ agent: { agentId: "" } });
    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("rejects manifest with invalid mode value", async () => {
    const body = validManifestBody({ mode: "invalid-mode" });
    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("rejects manifest with malformed artifact hash", async () => {
    const body = validManifestBody({ artifacts: { "file.txt": "not-a-hash" } });
    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("accepts contribution with pre-computed artifact hashes", async () => {
    // First, store an artifact to get a valid hash
    const hash = await ctx.cas.put(new TextEncoder().encode("hello"));
    const body = validManifestBody({ artifacts: { "main.py": hash } });

    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.artifacts["main.py"]).toBe(hash);
  });

  test("accepts commitHash and agent role on JSON body", async () => {
    const body = validManifestBody({
      commitHash: "955da4e077c08e281a01eed942efc0a2f0837a34",
      agent: { agentId: "test-agent", role: "coder" },
    });

    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.commitHash).toBe("955da4e077c08e281a01eed942efc0a2f0837a34");
    expect(data.agent.role).toBe("coder");
  });
});

describe("GET /api/contributions", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns empty array when no contributions exist", async () => {
    const res = await ctx.app.request("/api/contributions", { headers: TEST_AUTH_HEADERS });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
    expect(res.headers.get("X-Total-Count")).toBe("0");
  });

  test("lists contributions with pagination", async () => {
    // Submit 3 contributions
    for (let i = 0; i < 3; i++) {
      await ctx.app.request("/api/contributions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
        body: JSON.stringify(
          validManifestBody({
            summary: `Contribution ${i}`,
            createdAt: new Date(Date.now() + i).toISOString(),
          }),
        ),
      });
    }

    const res = await ctx.app.request("/api/contributions?limit=2&offset=0", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(res.headers.get("X-Total-Count")).toBe("3");
  });

  test("filters by kind", async () => {
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(validManifestBody({ kind: "work" })),
    });
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(
        validManifestBody({
          kind: "review",
          summary: "A review",
          createdAt: new Date(Date.now() + 1).toISOString(),
        }),
      ),
    });

    const res = await ctx.app.request("/api/contributions?kind=review", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].kind).toBe("review");
  });

  test("returns empty array when offset exceeds total", async () => {
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(validManifestBody()),
    });

    const res = await ctx.app.request("/api/contributions?offset=100", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  test("rejects invalid pagination params", async () => {
    const res = await ctx.app.request("/api/contributions?limit=-1", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(400);
  });

  test("rejects limit=0", async () => {
    const res = await ctx.app.request("/api/contributions?limit=0", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(400);
  });

  test("rejects negative offset", async () => {
    const res = await ctx.app.request("/api/contributions?offset=-5", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(400);
  });

  test("rejects limit exceeding maximum", async () => {
    const res = await ctx.app.request("/api/contributions?limit=101", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(400);
  });

  test("rejects non-numeric limit", async () => {
    const res = await ctx.app.request("/api/contributions?limit=abc", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(400);
  });

  test("outcome filter does not issue an unbounded contribution list", async () => {
    const created: { cid: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await ctx.app.request("/api/contributions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
        body: JSON.stringify(
          validManifestBody({
            summary: `Outcome-filtered ${i}`,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
          }),
        ),
      });
      expect(res.status).toBe(201);
      created.push((await res.json()) as { cid: string });
    }

    await ctx.outcomeStore.set(created[0].cid, { status: "accepted", evaluatedBy: "reviewer" });
    await ctx.outcomeStore.set(created[1].cid, { status: "accepted", evaluatedBy: "reviewer" });
    await ctx.outcomeStore.set(created[2].cid, { status: "rejected", evaluatedBy: "reviewer" });

    let unboundedListCalls = 0;
    const guardedStore = new Proxy(ctx.contributionStore, {
      get(target, prop, receiver) {
        if (prop === "list") {
          return (query?: ContributionQuery) => {
            if (query?.limit === undefined) unboundedListCalls++;
            return target.list(query);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value === "function") return value.bind(target);
        return value;
      },
    }) as ContributionStore;

    const app = createApp(
      { ...ctx.deps, contributionStore: guardedStore },
      new Map([[TEST_KEY, TEST_NAMESPACE]]),
    );

    const res = await app.request("/api/contributions?outcome=accepted&limit=1", {
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    const data = (await res.json()) as readonly unknown[];
    expect(data).toHaveLength(1);
    expect(unboundedListCalls).toBe(0);
  });
});

describe("GET /api/contributions/:cid", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns contribution by CID", async () => {
    const createRes = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(validManifestBody()),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/contributions/${created.cid}`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cid).toBe(created.cid);
  });

  test("returns 404 for non-existent CID", async () => {
    const fakeCid = `blake3:${"a".repeat(64)}`;
    const res = await ctx.app.request(`/api/contributions/${fakeCid}`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  test("returns 400 for invalid CID format", async () => {
    const res = await ctx.app.request("/api/contributions/not-a-valid-cid", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/contributions/:cid/artifacts/:name", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("downloads artifact bytes with correct content-type", async () => {
    // Pre-store artifact via CAS with explicit media type
    const content = new TextEncoder().encode("print('hello')");
    const hash = await ctx.cas.put(content, { mediaType: "text/x-python" });

    const body = validManifestBody({ artifacts: { "main.py": hash } });
    const createRes = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/contributions/${created.cid}/artifacts/main.py`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-python");

    const downloaded = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(downloaded)).toBe("print('hello')");
  });

  test("downloads multipart-uploaded artifact bytes", async () => {
    // Bun doesn't preserve File.type through FormData round-trip,
    // so multipart-uploaded artifacts get application/octet-stream
    const manifest = validManifestBody();
    const formData = new FormData();
    formData.append("manifest", JSON.stringify(manifest));
    formData.append(
      "artifact:script.py",
      new File([new TextEncoder().encode("print('hello')")], "script.py"),
    );

    const createRes = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: TEST_AUTH_HEADERS,
      body: formData,
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/contributions/${created.cid}/artifacts/script.py`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);

    const downloaded = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(downloaded)).toBe("print('hello')");
  });

  test("downloads nested artifact paths and metadata", async () => {
    const content = new TextEncoder().encode("export const answer = 42;\n");
    const hash = await ctx.cas.put(content, { mediaType: "text/typescript" });

    const createRes = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(validManifestBody({ artifacts: { "src/main.ts": hash } })),
    });
    const created = (await createRes.json()) as { cid: string };

    const downloadRes = await ctx.app.request(
      `/api/contributions/${created.cid}/artifacts/src/main.ts`,
      { headers: TEST_AUTH_HEADERS },
    );
    expect(downloadRes.status).toBe(200);
    expect(new TextDecoder().decode(await downloadRes.arrayBuffer())).toBe(
      "export const answer = 42;\n",
    );

    const metaRes = await ctx.app.request(
      `/api/contributions/${created.cid}/artifacts/src/main.ts/meta`,
      { headers: TEST_AUTH_HEADERS },
    );
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as { sizeBytes: number; mediaType?: string };
    expect(meta.sizeBytes).toBe(content.byteLength);
    expect(meta.mediaType).toBe("text/typescript");
  });

  test("returns 404 for non-existent artifact name", async () => {
    const createRes = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(validManifestBody()),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/contributions/${created.cid}/artifacts/nonexistent`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  test("returns 404 for non-existent contribution CID", async () => {
    const fakeCid = `blake3:${"b".repeat(64)}`;
    const res = await ctx.app.request(`/api/contributions/${fakeCid}/artifacts/main.py`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  test("returns application/octet-stream when no media type is set", async () => {
    const manifest = validManifestBody();
    const formData = new FormData();
    formData.append("manifest", JSON.stringify(manifest));
    // File with no explicit type
    formData.append("artifact:data.bin", new File([new Uint8Array([1, 2, 3])], "data.bin"));

    const createRes = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: TEST_AUTH_HEADERS,
      body: formData,
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/contributions/${created.cid}/artifacts/data.bin`, {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });
});

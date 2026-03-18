import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestContext } from "./helpers.js";
import { createTestContext, validManifestBody } from "./helpers.js";

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
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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
      body: formData,
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });

  test("rejects malformed JSON body with 400", async () => {
    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("rejects pre-computed artifact hash that does not exist in CAS", async () => {
    const fakeHash = `blake3:${"f".repeat(64)}`;
    const body = validManifestBody({ artifacts: { "ghost.py": fakeHash } });

    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "work" }),
    });

    expect(res.status).toBe(400);
  });

  test("handles duplicate CID submission idempotently", async () => {
    const body = validManifestBody();

    const res1 = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res1.status).toBe(201);

    // Same body → same CID → idempotent put
    const res2 = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("rejects manifest with empty summary", async () => {
    const body = validManifestBody({ summary: "" });
    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("rejects manifest with empty agentId", async () => {
    const body = validManifestBody({ agent: { agentId: "" } });
    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("rejects manifest with invalid mode value", async () => {
    const body = validManifestBody({ mode: "invalid-mode" });
    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("rejects manifest with malformed artifact hash", async () => {
    const body = validManifestBody({ artifacts: { "file.txt": "not-a-hash" } });
    const res = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.artifacts["main.py"]).toBe(hash);
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
    const res = await ctx.app.request("/api/contributions");

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          validManifestBody({
            summary: `Contribution ${i}`,
            createdAt: new Date(Date.now() + i).toISOString(),
          }),
        ),
      });
    }

    const res = await ctx.app.request("/api/contributions?limit=2&offset=0");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(res.headers.get("X-Total-Count")).toBe("3");
  });

  test("filters by kind", async () => {
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validManifestBody({ kind: "work" })),
    });
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        validManifestBody({
          kind: "review",
          summary: "A review",
          createdAt: new Date(Date.now() + 1).toISOString(),
        }),
      ),
    });

    const res = await ctx.app.request("/api/contributions?kind=review");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].kind).toBe("review");
  });

  test("returns empty array when offset exceeds total", async () => {
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validManifestBody()),
    });

    const res = await ctx.app.request("/api/contributions?offset=100");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  test("rejects invalid pagination params", async () => {
    const res = await ctx.app.request("/api/contributions?limit=-1");
    expect(res.status).toBe(400);
  });

  test("rejects limit=0", async () => {
    const res = await ctx.app.request("/api/contributions?limit=0");
    expect(res.status).toBe(400);
  });

  test("rejects negative offset", async () => {
    const res = await ctx.app.request("/api/contributions?offset=-5");
    expect(res.status).toBe(400);
  });

  test("rejects limit exceeding maximum", async () => {
    const res = await ctx.app.request("/api/contributions?limit=101");
    expect(res.status).toBe(400);
  });

  test("rejects non-numeric limit", async () => {
    const res = await ctx.app.request("/api/contributions?limit=abc");
    expect(res.status).toBe(400);
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validManifestBody()),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/contributions/${created.cid}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cid).toBe(created.cid);
  });

  test("returns 404 for non-existent CID", async () => {
    const fakeCid = `blake3:${"a".repeat(64)}`;
    const res = await ctx.app.request(`/api/contributions/${fakeCid}`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  test("returns 400 for invalid CID format", async () => {
    const res = await ctx.app.request("/api/contributions/not-a-valid-cid");
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/contributions/${created.cid}/artifacts/main.py`);
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
      body: formData,
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/contributions/${created.cid}/artifacts/script.py`);
    expect(res.status).toBe(200);

    const downloaded = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(downloaded)).toBe("print('hello')");
  });

  test("returns 404 for non-existent artifact name", async () => {
    const createRes = await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validManifestBody()),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/contributions/${created.cid}/artifacts/nonexistent`);
    expect(res.status).toBe(404);
  });

  test("returns 404 for non-existent contribution CID", async () => {
    const fakeCid = `blake3:${"b".repeat(64)}`;
    const res = await ctx.app.request(`/api/contributions/${fakeCid}/artifacts/main.py`);
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
      body: formData,
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/contributions/${created.cid}/artifacts/data.bin`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });
});

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { handleError } from "./error-handler.js";
import { loadKeyRegistry, namespaceAuth } from "./namespace-auth.js";

// biome-ignore lint/suspicious/noExplicitAny: test file
type Json = Record<string, any>;

function makeApp(registry: Map<string, string>): Hono<{ Variables: { namespace: string } }> {
  const app = new Hono<{ Variables: { namespace: string } }>();
  app.use("/api/*", namespaceAuth(registry));
  app.get("/api/ping", (c) => c.json({ namespace: c.get("namespace") }));
  app.get("/health", (c) => c.json({ ok: true }));
  app.onError(handleError);
  return app;
}

describe("loadKeyRegistry", () => {
  it("returns empty Map when file is absent", async () => {
    const registry = loadKeyRegistry("/nonexistent/path/server-keys.yaml");
    expect(registry.size).toBe(0);
  });
});

describe("namespaceAuth middleware", () => {
  const registry = new Map([
    [`grv_${"a".repeat(64)}`, "uuid-a/worktree-a"],
    [`grv_${"b".repeat(64)}`, "uuid-b/worktree-b"],
  ]);

  it("returns 400 when Authorization header is absent", async () => {
    const app = makeApp(registry);
    const res = await app.request("/api/ping");
    expect(res.status).toBe(400);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("NAMESPACE_MISSING");
  });

  it("returns 400 when Authorization header has wrong scheme", async () => {
    const app = makeApp(registry);
    const res = await app.request("/api/ping", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("NAMESPACE_MISSING");
  });

  it("returns 401 when key is not in registry", async () => {
    const app = makeApp(registry);
    const res = await app.request("/api/ping", {
      headers: { Authorization: "Bearer grv_unknown_key" },
    });
    expect(res.status).toBe(401);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("NAMESPACE_UNAUTHORIZED");
  });

  it("sets namespace in context for a valid key", async () => {
    const app = makeApp(registry);
    const res = await app.request("/api/ping", {
      headers: { Authorization: `Bearer grv_${"a".repeat(64)}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Json;
    expect(data.namespace).toBe("uuid-a/worktree-a");
  });

  it("resolves different namespaces for different keys", async () => {
    const app = makeApp(registry);
    const resA = await app.request("/api/ping", {
      headers: { Authorization: `Bearer grv_${"a".repeat(64)}` },
    });
    const resB = await app.request("/api/ping", {
      headers: { Authorization: `Bearer grv_${"b".repeat(64)}` },
    });
    expect(((await resA.json()) as Json).namespace).toBe("uuid-a/worktree-a");
    expect(((await resB.json()) as Json).namespace).toBe("uuid-b/worktree-b");
  });

  it("does not enforce auth on routes outside /api/*", async () => {
    const app = makeApp(registry);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});

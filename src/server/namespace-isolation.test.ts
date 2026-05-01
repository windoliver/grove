import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { handleError } from "./middleware/error-handler.js";
import { namespaceAuth } from "./middleware/namespace-auth.js";

// biome-ignore lint/suspicious/noExplicitAny: test file
type Json = Record<string, any>;

const KEY_A = `grv_${"a".repeat(64)}`;
const KEY_B = `grv_${"b".repeat(64)}`;
const NS_A = "550e8400-0000-4000-8000-000000000001/worktree-a";
const NS_B = "550e8400-0000-4000-8000-000000000002/worktree-b";

const registry = new Map([
  [KEY_A, NS_A],
  [KEY_B, NS_B],
]);

describe("A3 namespace isolation", () => {
  it("key A resolves to namespace A, key B resolves to namespace B", async () => {
    const app = new Hono<{ Variables: { namespace: string } }>();
    app.use("/api/*", namespaceAuth(registry));
    app.get("/api/ns", (c) => c.json({ namespace: c.get("namespace") }));
    app.onError(handleError);

    const resA = await app.request("/api/ns", {
      headers: { Authorization: `Bearer ${KEY_A}` },
    });
    expect(resA.status).toBe(200);
    expect(((await resA.json()) as Json).namespace).toBe(NS_A);

    const resB = await app.request("/api/ns", {
      headers: { Authorization: `Bearer ${KEY_B}` },
    });
    expect(resB.status).toBe(200);
    expect(((await resB.json()) as Json).namespace).toBe(NS_B);
  });

  it("request without Authorization → 400 NAMESPACE_MISSING", async () => {
    const app = new Hono<{ Variables: { namespace: string } }>();
    app.use("/api/*", namespaceAuth(registry));
    app.get("/api/ns", (c) => c.json({ ok: true }));
    app.onError(handleError);

    const res = await app.request("/api/ns");
    expect(res.status).toBe(400);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("NAMESPACE_MISSING");
  });

  it("request with unknown key → 401 NAMESPACE_UNAUTHORIZED", async () => {
    const app = new Hono<{ Variables: { namespace: string } }>();
    app.use("/api/*", namespaceAuth(registry));
    app.get("/api/ns", (c) => c.json({ ok: true }));
    app.onError(handleError);

    const res = await app.request("/api/ns", {
      headers: { Authorization: `Bearer grv_${"z".repeat(64)}` },
    });
    expect(res.status).toBe(401);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("NAMESPACE_UNAUTHORIZED");
  });

  it("/health is exempt from namespace auth", async () => {
    const app = new Hono<{ Variables: { namespace: string } }>();
    app.use("/api/*", namespaceAuth(registry));
    app.get("/health", (c) => c.json({ ok: true }));

    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});

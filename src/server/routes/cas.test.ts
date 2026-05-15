import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { cas as casRoute } from "./cas.js";
import type { ServerDeps, ServerEnv } from "../deps.js";
import type { ContentStore } from "../../core/cas.js";

function makeApp(cas: ContentStore) {
  const app = new Hono<ServerEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", { cas } as unknown as ServerDeps);
    c.set("namespace", "default");
    await next();
  });
  app.route("/api/cas", casRoute);
  return app;
}

describe("GET /api/cas/:hash", () => {
  const hash = "blake3:" + "a".repeat(64);
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);

  it("returns the blob with correct content-type when present", async () => {
    const stubCas = {
      get: async (h: string) => (h === hash ? bytes : undefined),
      stat: async (h: string) =>
        h === hash ? { contentHash: h, sizeBytes: bytes.byteLength, mediaType: "application/x-thing" } : undefined,
    } as unknown as ContentStore;
    const res = await makeApp(stubCas).request(`/api/cas/${encodeURIComponent(hash)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-thing");
    const body = new Uint8Array(await res.arrayBuffer());
    expect([...body]).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns 404 when the blob is missing", async () => {
    const stubCas = {
      get: async () => undefined,
      stat: async () => undefined,
    } as unknown as ContentStore;
    const res = await makeApp(stubCas).request(`/api/cas/${encodeURIComponent(hash)}`);
    expect(res.status).toBe(404);
  });

  it("rejects malformed hashes with 400", async () => {
    const stubCas = { get: async () => undefined, stat: async () => undefined } as unknown as ContentStore;
    const res = await makeApp(stubCas).request(`/api/cas/notahash`);
    expect(res.status).toBe(400);
  });

  it("exposes /meta for size/mediaType", async () => {
    const stubCas = {
      get: async () => bytes,
      stat: async (h: string) =>
        h === hash ? { contentHash: h, sizeBytes: 5, mediaType: "application/json" } : undefined,
    } as unknown as ContentStore;
    const res = await makeApp(stubCas).request(`/api/cas/${encodeURIComponent(hash)}/meta`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sizeBytes: 5, mediaType: "application/json" });
  });
});

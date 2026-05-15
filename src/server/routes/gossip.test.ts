import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { gossip as gossipRoute } from "./gossip.js";
import type { GossipService } from "../../core/gossip/types.js";
import type { ServerDeps, ServerEnv } from "../deps.js";

function makeApp(svc: GossipService | undefined) {
  const app = new Hono<ServerEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", { gossip: svc } as unknown as ServerDeps);
    c.set("namespace", "default");
    await next();
  });
  app.route("/api/gossip", gossipRoute);
  return app;
}

describe("POST /api/gossip/fetch/:cid", () => {
  const cid = "blake3:" + "a".repeat(64);

  it("returns 200 with the fetched contribution on success", async () => {
    const stub = {
      fetchRemoteContribution: async () => ({ kind: "ok", cid }),
    } as unknown as GossipService;
    const res = await makeApp(stub).request(`/api/gossip/fetch/${encodeURIComponent(cid)}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "ok", cid });
  });

  it("returns 404 when no peer has advertised the cid", async () => {
    const stub = {
      fetchRemoteContribution: async () => ({ kind: "no-source", cid }),
    } as unknown as GossipService;
    const res = await makeApp(stub).request(`/api/gossip/fetch/${encodeURIComponent(cid)}`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("returns 502 when peers errored", async () => {
    const stub = {
      fetchRemoteContribution: async () => ({ kind: "failed", cid, reason: "boom" }),
    } as unknown as GossipService;
    const res = await makeApp(stub).request(`/api/gossip/fetch/${encodeURIComponent(cid)}`, {
      method: "POST",
    });
    expect(res.status).toBe(502);
  });

  it("returns 501 when gossip is disabled", async () => {
    const res = await makeApp(undefined).request(`/api/gossip/fetch/${encodeURIComponent(cid)}`, {
      method: "POST",
    });
    expect(res.status).toBe(501);
  });

  it("rejects malformed cids with 400", async () => {
    const stub = { fetchRemoteContribution: async () => ({ kind: "ok", cid }) } as unknown as GossipService;
    const res = await makeApp(stub).request(`/api/gossip/fetch/notacid`, { method: "POST" });
    expect(res.status).toBe(400);
  });
});

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { dangerous } from "./dangerous.js";

describe("dangerous middleware", () => {
  function app() {
    const a = new Hono();
    a.put(
      "/widget/:id",
      dangerous(async (c) => {
        const ifMatch = c.get("ifMatch") as string;
        return c.json({ ok: true, ifMatch });
      }),
    );
    return a;
  }

  test("missing If-Match → 428", async () => {
    const res = await app().request("/widget/1", { method: "PUT" });
    expect(res.status).toBe(428);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("PRECONDITION_REQUIRED");
    expect(body.error.message).toBeDefined();
  });

  test("empty If-Match → 428", async () => {
    const res = await app().request("/widget/1", {
      method: "PUT",
      headers: { "if-match": "" },
    });
    expect(res.status).toBe(428);
  });

  test("present If-Match → handler invoked, ifMatch in context", async () => {
    const res = await app().request("/widget/1", {
      method: "PUT",
      headers: { "if-match": "v3" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ifMatch: "v3" });
  });

  test("case-insensitive header name", async () => {
    // HTTP headers are case-insensitive; Hono normalizes them
    const res = await app().request("/widget/1", {
      method: "PUT",
      headers: { "If-Match": "v7" },
    });
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    expect(((await res.json()) as any).ifMatch).toBe("v7");
  });
});

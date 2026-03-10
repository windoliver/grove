import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ConcurrencyLimitError, RateLimitError } from "../../src/core/errors.js";
import { handleError } from "../../src/server/middleware/error-handler.js";

describe("error handler middleware", () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.onError(handleError);
  });

  test("maps ConcurrencyLimitError to 409", async () => {
    app.get("/test", () => {
      throw new ConcurrencyLimitError({
        limitType: "global",
        current: 5,
        limit: 5,
      });
    });

    const res = await app.request("/test");
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error.code).toBe("CONCURRENCY_LIMIT");
  });

  test("maps RateLimitError to 429 with Retry-After header", async () => {
    app.get("/test", () => {
      throw new RateLimitError({
        limitType: "per_agent",
        current: 10,
        limit: 10,
        windowSeconds: 60,
        retryAfterMs: 30_000,
      });
    });

    const res = await app.request("/test");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    const data = await res.json();
    expect(data.error.code).toBe("RATE_LIMIT");
  });

  test("maps 'not found' errors to 404", async () => {
    app.get("/test", () => {
      throw new Error("Claim xyz not found");
    });

    const res = await app.request("/test");
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  test("maps 'not active' errors to 409", async () => {
    app.get("/test", () => {
      throw new Error("Claim is not active");
    });

    const res = await app.request("/test");
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error.code).toBe("CONFLICT");
  });

  test("maps unknown errors to 500 without leaking details", async () => {
    app.get("/test", () => {
      throw new Error("some internal detail");
    });

    // "some internal detail" doesn't match known patterns → 500
    const res = await app.request("/test");
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error.code).toBe("INTERNAL_ERROR");
    expect(data.error.message).toBe("Internal server error");
  });
});

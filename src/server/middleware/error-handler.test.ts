import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import {
  ArtifactLimitError,
  ConcurrencyLimitError,
  GroveError,
  LeaseViolationError,
  NotFoundError,
  RateLimitError,
  RetryExhaustedError,
  StateConflictError,
} from "../../core/errors.js";
import { handleError } from "./error-handler.js";

// biome-ignore lint/suspicious/noExplicitAny: test file — JSON responses are dynamically shaped
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Create a test app that throws the given error on GET /test. */
function appThatThrows(error: Error): Hono {
  const app = new Hono();
  app.get("/test", () => {
    throw error;
  });
  app.onError(handleError);
  return app;
}

describe("error handler", () => {
  it("maps ZodError to 400", async () => {
    const { z } = await import("zod");
    // Trigger a real ZodError by parsing invalid data against a strict schema
    let zodError: Error;
    try {
      z.object({ name: z.string() }).parse({ name: 123 });
      throw new Error("unreachable");
    } catch (e) {
      zodError = e as Error;
    }
    const app = appThatThrows(zodError);

    const res = await app.request("/test");
    expect(res.status).toBe(400);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });

  it("maps ConcurrencyLimitError to 409", async () => {
    const app = appThatThrows(
      new ConcurrencyLimitError({ limitType: "global", current: 5, limit: 3 }),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(409);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("CONCURRENCY_LIMIT");
  });

  it("maps RateLimitError to 429 with Retry-After header", async () => {
    const app = appThatThrows(
      new RateLimitError({
        limitType: "per_agent",
        current: 10,
        limit: 5,
        windowSeconds: 60,
        retryAfterMs: 30000,
      }),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("RATE_LIMIT");
  });

  it("maps LeaseViolationError to 422", async () => {
    const app = appThatThrows(
      new LeaseViolationError({ requestedSeconds: 7200, maxSeconds: 3600 }),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(422);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("LEASE_VIOLATION");
  });

  it("maps ArtifactLimitError to 422", async () => {
    const app = appThatThrows(
      new ArtifactLimitError({ limitType: "count", current: 20, limit: 10 }),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(422);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("ARTIFACT_LIMIT");
  });

  it("maps RetryExhaustedError to 503", async () => {
    const app = appThatThrows(new RetryExhaustedError({ attempts: 5, maxAttempts: 3 }));

    const res = await app.request("/test");
    expect(res.status).toBe(503);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("RETRY_EXHAUSTED");
  });

  it("maps unknown GroveError subclass to 500", async () => {
    const err = new GroveError("unknown grove error");

    const app = appThatThrows(err);

    const res = await app.request("/test");
    expect(res.status).toBe(500);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("GROVE_ERROR");
  });

  it("maps NotFoundError to 404", async () => {
    const app = appThatThrows(
      new NotFoundError({
        resource: "Claim",
        identifier: "xyz",
        message: "Claim xyz does not exist",
      }),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(404);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("maps StateConflictError to 409", async () => {
    const app = appThatThrows(
      new StateConflictError({
        resource: "Claim",
        reason: "not active",
        message: "Claim is not active",
      }),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(409);
    const data = (await res.json()) as Json;
    expect(data.error.code).toBe("STATE_CONFLICT");
  });

  it("maps unknown errors to 500 without leaking details", async () => {
    // Suppress console.error to prevent Bun test runner exit code 1
    const origError = console.error;
    console.error = () => {};
    try {
      const app = appThatThrows(new Error("secret internal detail"));

      const res = await app.request("/test");
      expect(res.status).toBe(500);
      const data = (await res.json()) as Json;
      expect(data.error.code).toBe("INTERNAL_ERROR");
      expect(data.error.message).toBe("Internal server error");
      expect(data.error.message).not.toContain("secret");
    } finally {
      console.error = origError;
    }
  });
});

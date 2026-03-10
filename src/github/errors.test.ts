/**
 * Tests for GitHub error hierarchy and classification.
 */

import { describe, expect, test } from "bun:test";
import { GroveError } from "../core/errors.js";
import {
  classifyGhError,
  GhCliNotFoundError,
  GitHubAdapterError,
  GitHubAuthError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubValidationError,
} from "./errors.js";

describe("error hierarchy", () => {
  test("GitHubAdapterError extends GroveError", () => {
    const err = new GitHubAdapterError("test");
    expect(err).toBeInstanceOf(GroveError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GitHubAdapterError");
  });

  test("GitHubAuthError has status 401", () => {
    const err = new GitHubAuthError();
    expect(err).toBeInstanceOf(GitHubAdapterError);
    expect(err.statusCode).toBe(401);
    expect(err.name).toBe("GitHubAuthError");
    expect(err.message).toContain("gh auth login");
  });

  test("GitHubAuthError accepts custom message", () => {
    const err = new GitHubAuthError("token expired");
    expect(err.message).toBe("token expired");
  });

  test("GitHubNotFoundError has status 404", () => {
    const err = new GitHubNotFoundError("owner/repo#44");
    expect(err).toBeInstanceOf(GitHubAdapterError);
    expect(err.statusCode).toBe(404);
    expect(err.resource).toBe("owner/repo#44");
    expect(err.message).toContain("owner/repo#44");
  });

  test("GitHubRateLimitError has status 429", () => {
    const err = new GitHubRateLimitError(60_000);
    expect(err).toBeInstanceOf(GitHubAdapterError);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBe(60_000);
    expect(err.message).toContain("60s");
  });

  test("GitHubValidationError has status 422", () => {
    const err = new GitHubValidationError("bad input");
    expect(err).toBeInstanceOf(GitHubAdapterError);
    expect(err.statusCode).toBe(422);
    expect(err.message).toContain("bad input");
  });

  test("GhCliNotFoundError has descriptive message", () => {
    const err = new GhCliNotFoundError();
    expect(err).toBeInstanceOf(GitHubAdapterError);
    expect(err.message).toContain("cli.github.com");
  });
});

describe("classifyGhError", () => {
  test("classifies auth errors", () => {
    const err = classifyGhError(1, "not logged in to any GitHub hosts", "test");
    expect(err).toBeInstanceOf(GitHubAuthError);
  });

  test("classifies authentication keyword", () => {
    const err = classifyGhError(1, "authentication required", "test");
    expect(err).toBeInstanceOf(GitHubAuthError);
  });

  test("classifies 401 status in stderr", () => {
    const err = classifyGhError(1, "HTTP 401: Unauthorized", "test");
    expect(err).toBeInstanceOf(GitHubAuthError);
  });

  test("classifies not found errors", () => {
    const err = classifyGhError(1, "HTTP 404: Not Found", "owner/repo");
    expect(err).toBeInstanceOf(GitHubNotFoundError);
    expect((err as GitHubNotFoundError).resource).toBe("owner/repo");
  });

  test("classifies could not resolve errors", () => {
    const err = classifyGhError(1, "Could not resolve to a Repository", "owner/repo");
    expect(err).toBeInstanceOf(GitHubNotFoundError);
  });

  test("classifies rate limit errors", () => {
    const err = classifyGhError(1, "API rate limit exceeded", "test");
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubRateLimitError).retryAfterMs).toBe(60_000);
  });

  test("classifies 429 status", () => {
    const err = classifyGhError(1, "HTTP 429: Too Many Requests", "test");
    expect(err).toBeInstanceOf(GitHubRateLimitError);
  });

  test("classifies abuse rate limit", () => {
    const err = classifyGhError(1, "abuse detection mechanism triggered", "test");
    expect(err).toBeInstanceOf(GitHubRateLimitError);
  });

  test("classifies validation errors", () => {
    const err = classifyGhError(1, "HTTP 422: Unprocessable Entity", "test");
    expect(err).toBeInstanceOf(GitHubValidationError);
  });

  test("falls back to generic error for unknown stderr", () => {
    const err = classifyGhError(1, "something unexpected", "test-context");
    expect(err).toBeInstanceOf(GitHubAdapterError);
    expect(err.message).toContain("test-context");
    expect(err.message).toContain("something unexpected");
  });

  test("classification is case-insensitive", () => {
    const err = classifyGhError(1, "NOT LOGGED IN", "test");
    expect(err).toBeInstanceOf(GitHubAuthError);
  });
});

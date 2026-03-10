/**
 * GitHub-specific error hierarchy.
 *
 * All errors extend GroveError for consistent handling across
 * CLI, server, and MCP surfaces.
 */

import { GroveError } from "../core/errors.js";

/** Base error for all GitHub adapter operations. */
export class GitHubAdapterError extends GroveError {
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "GitHubAdapterError";
    this.statusCode = statusCode;
  }
}

/** Thrown when GitHub authentication fails or gh CLI is not authenticated. */
export class GitHubAuthError extends GitHubAdapterError {
  constructor(message?: string) {
    super(message ?? "GitHub authentication failed. Run 'gh auth login' to authenticate.", 401);
    this.name = "GitHubAuthError";
  }
}

/** Thrown when a GitHub resource (repo, PR, Discussion) is not found. */
export class GitHubNotFoundError extends GitHubAdapterError {
  readonly resource: string;

  constructor(resource: string) {
    super(`GitHub resource not found: ${resource}`, 404);
    this.name = "GitHubNotFoundError";
    this.resource = resource;
  }
}

/** Thrown when the GitHub API rate limit is exceeded. */
export class GitHubRateLimitError extends GitHubAdapterError {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    const seconds = Math.ceil(retryAfterMs / 1000);
    super(`GitHub rate limit exceeded. Retry after ${seconds}s.`, 429);
    this.name = "GitHubRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Thrown when the GitHub API returns a validation error (422). */
export class GitHubValidationError extends GitHubAdapterError {
  constructor(message: string) {
    super(`GitHub validation error: ${message}`, 422);
    this.name = "GitHubValidationError";
  }
}

/** Thrown when gh CLI is not installed or not found on PATH. */
export class GhCliNotFoundError extends GitHubAdapterError {
  constructor() {
    super("gh CLI not found. Install it from https://cli.github.com/", undefined);
    this.name = "GhCliNotFoundError";
  }
}

/**
 * Classify a GitHub API error based on exit code and stderr.
 *
 * Used by GhCliClient to convert gh CLI failures into typed errors.
 */
export function classifyGhError(
  exitCode: number,
  stderr: string,
  context: string,
): GitHubAdapterError {
  const lower = stderr.toLowerCase();

  if (
    lower.includes("not logged in") ||
    lower.includes("authentication") ||
    lower.includes("401")
  ) {
    return new GitHubAuthError();
  }

  if (lower.includes("not found") || lower.includes("404") || lower.includes("could not resolve")) {
    return new GitHubNotFoundError(context);
  }

  if (lower.includes("rate limit") || lower.includes("429") || lower.includes("abuse")) {
    // Default retry-after of 60s when we can't parse the header
    return new GitHubRateLimitError(60_000);
  }

  if (lower.includes("422") || lower.includes("validation")) {
    return new GitHubValidationError(stderr.trim());
  }

  return new GitHubAdapterError(
    `GitHub API error for ${context} (exit ${exitCode}): ${stderr.trim()}`,
    undefined,
  );
}

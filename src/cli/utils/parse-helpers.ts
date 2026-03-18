/**
 * Shared CLI argument-parsing helpers.
 *
 * Extracts the most common validation patterns found across CLI commands
 * (limit parsing, offset parsing, required-positional checks) into
 * reusable, well-tested functions.
 */

import { UsageError } from "../errors.js";

/** Parse a positive integer limit from a CLI flag value. */
export function parseLimit(raw: string | undefined, defaultLimit: number): number {
  if (raw === undefined) return defaultLimit;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new UsageError(`Invalid limit: '${raw}'. Must be a positive integer.`);
  }
  return n;
}

/** Parse a non-negative integer offset from a CLI flag value. */
export function parseOffset(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new UsageError(`Invalid offset: '${raw}'. Must be a non-negative integer.`);
  }
  return n;
}

/** Require a positional argument or throw with a usage message. */
export function requirePositional(positionals: string[], index: number, name: string): string {
  const value = positionals[index];
  if (!value) {
    throw new UsageError(`Missing required argument: <${name}>`);
  }
  return value;
}

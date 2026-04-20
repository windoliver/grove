/**
 * Shared CLI argument-parsing helpers.
 *
 * Extracts the most common validation patterns found across CLI commands
 * (limit parsing, offset parsing, required-positional checks) into
 * reusable, well-tested functions.
 */

import { UsageError } from "../errors.js";

function parseStrictInteger(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return undefined;
  return n;
}

/** Parse a positive integer limit from a CLI flag value. */
export function parseLimit(raw: string | undefined, defaultLimit: number): number {
  if (raw === undefined) return defaultLimit;
  const n = parseStrictInteger(raw);
  if (n === undefined || n <= 0) {
    throw new UsageError(`Invalid limit: '${raw}'. Must be a positive integer.`);
  }
  return n;
}

/** Parse a non-negative integer offset from a CLI flag value. */
export function parseOffset(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = parseStrictInteger(raw);
  if (n === undefined || n < 0) {
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

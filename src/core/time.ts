/**
 * Shared timestamp utilities for Grove stores.
 *
 * All timestamps in Grove are ISO 8601 UTC with Z suffix.
 * These helpers normalize arbitrary ISO 8601 inputs (including
 * timezone offsets) to this canonical format.
 */

/**
 * Normalize an ISO 8601 timestamp to UTC Z-format.
 *
 * SQL text comparison of timestamps only works reliably when
 * all values use the same format (no timezone offsets like +05:00).
 */
export function toUtcIso(iso: string): string {
  return new Date(iso).toISOString();
}

/**
 * Duration string parsing and formatting for CLI lease arguments.
 *
 * Supports: ms, s, m, h, d units (e.g., "30m", "1h", "2d").
 */

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;

/** Parse a human-readable duration string into milliseconds. */
export function parseDuration(input: string): number {
  const match = DURATION_RE.exec(input);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error(
      `Invalid duration '${input}'. Expected format: <number><unit> where unit is ms, s, m, h, or d (e.g., 30m, 1h, 2d).`,
    );
  }
  const value = Number(match[1]);
  const unit = match[2];
  if (value <= 0) {
    throw new Error(`Duration must be positive, got '${input}'.`);
  }
  const multiplier = UNITS[unit];
  if (multiplier === undefined) {
    throw new Error(`Invalid duration unit '${unit}'.`);
  }
  return value * multiplier;
}

/** Format milliseconds into a human-readable duration string. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "expired";

  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) return `${minutes}m`;

  const seconds = Math.floor(ms / 1_000);
  return seconds > 0 ? `${seconds}s` : "<1s";
}

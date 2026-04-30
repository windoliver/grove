/**
 * Parse an integer env var with bounds. Used at server boot so a stray
 * `GROVE_WATCH_RETENTION_MS=-5` falls back to the documented default
 * instead of silently disabling retention.
 */

export interface ClampIntArgs {
  readonly raw: string | undefined;
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
  readonly name: string;
  readonly warn?: (msg: string) => void;
}

export function clampInt({
  raw,
  fallback,
  min,
  max,
  name,
  warn = (msg) => console.warn(msg),
}: ClampIntArgs): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^-?[0-9]+$/.test(raw)) {
    warn(`${name}=${raw} is not an integer; using fallback ${fallback}`);
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  if (n < min || n > max) {
    warn(`${name}=${n} is outside [${min}, ${max}]; using fallback ${fallback}`);
    return fallback;
  }
  return n;
}

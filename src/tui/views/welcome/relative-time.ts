/**
 * Pure relative-time formatter for session rows.
 *
 * Takes `now` explicitly so callers can pin a reference time for testing
 * and so animation-free UI doesn't need clock access during render.
 *
 * Buckets:
 *   < 60 s        → "just now"
 *   < 60 m        → "Nm"
 *   < 24 h        → "Nh"
 *   = 24 h ± 1h   → "yesterday"
 *   < 7 d         → "Nd ago"
 *   ≥ 7 d         → "MMM D" (absolute short date, en-US)
 *
 * Returns empty string for unparseable input.
 */
export function formatRelativeTime(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";

  const diff = Math.max(0, now - t);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  // 24h window → "yesterday"
  if (diff < day + hour) return "yesterday";
  if (diff < week) return `${Math.floor(diff / day)}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Pure projection: Frontier → ordered FrontierSlice[].
 *
 * Each FrontierSlice represents one ranking signal. The orchestrator
 * (frontier-view.tsx) renders one slice per tab. formatBadge() produces
 * the per-row "why winning" text shown in the SIGNAL column.
 */

import type { Frontier, FrontierEntry } from "../../core/frontier.js";

/** A single ranking dimension grouped for display. */
export interface FrontierSlice {
  /** Stable key used as tab id and cursor map key. Unique across all slices. */
  readonly key: string;
  /** Human-facing tab label. */
  readonly label: string;
  /** One-line description shown in the slice header. */
  readonly signalDescription: string;
  /** Ranked entries (already ordered by the calculator). */
  readonly entries: readonly FrontierEntry[];
  /** Per-row badge formatter for the SIGNAL column. */
  readonly formatBadge: (entry: FrontierEntry) => string;
}

const SCALAR_DESCRIPTIONS: Record<string, string> = {
  adoption: "Adoption — unique downstream uses (derives_from + adopts)",
  recency: "Recency — most recent contributions",
  review: "Review — highest average review scores",
  reproduction: "Reproduction — most-reproduced contributions",
};

function formatRelativeMs(ms: number): string {
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function adoptionBadge(entry: FrontierEntry): string {
  return `×${String(entry.value)} adopters`;
}

function reproductionBadge(entry: FrontierEntry): string {
  return `▲${String(entry.value)} confirmed`;
}

function reviewBadge(entry: FrontierEntry): string {
  return `${entry.value.toFixed(1)}⋆`;
}

function recencyBadge(entry: FrontierEntry): string {
  return formatRelativeMs(entry.value);
}

function metricBadge(name: string): (entry: FrontierEntry) => string {
  return (entry) => `${entry.value.toFixed(3)} ${name}`;
}

const SCALAR_BADGES: Record<string, (entry: FrontierEntry) => string> = {
  adoption: adoptionBadge,
  recency: recencyBadge,
  review: reviewBadge,
  reproduction: reproductionBadge,
};

/**
 * Structural equality across slice arrays. Compares slice key + entry count
 * + (cid, value, summary) tuples in order.
 *
 * summary is included because it flows into the spawned-agent's adopt
 * context: a server-side summary refresh that changes only the summary
 * (cid + value unchanged) must trigger a re-render so onFrontierEntriesChanged
 * fires with the fresh text — otherwise pressing 'a' on a row would inject
 * a stale summary into the new agent's CLAUDE.md.
 */
export function slicesEqual(a: readonly FrontierSlice[], b: readonly FrontierSlice[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const sa = a[i] as FrontierSlice;
    const sb = b[i] as FrontierSlice;
    if (sa.key !== sb.key) return false;
    if (sa.entries.length !== sb.entries.length) return false;
    for (let j = 0; j < sa.entries.length; j++) {
      const ea = sa.entries[j] as FrontierEntry;
      const eb = sb.entries[j] as FrontierEntry;
      if (ea.cid !== eb.cid || ea.value !== eb.value || ea.summary !== eb.summary) return false;
    }
  }
  return true;
}

/** Project a Frontier into ordered, non-empty slices. */
export function toSlices(frontier: Frontier): readonly FrontierSlice[] {
  const slices: FrontierSlice[] = [];
  const scalarOrder: ReadonlyArray<readonly [string, readonly FrontierEntry[] | undefined]> = [
    ["adoption", frontier.byAdoption],
    ["recency", frontier.byRecency],
    ["review", frontier.byReviewScore],
    ["reproduction", frontier.byReproduction],
  ];
  for (const [key, entries] of scalarOrder) {
    if (!entries || entries.length === 0) continue;
    slices.push({
      key,
      label: key,
      signalDescription: SCALAR_DESCRIPTIONS[key] ?? key,
      entries,
      formatBadge: SCALAR_BADGES[key] ?? ((): string => ""),
    });
  }
  // Metric names come from agent-supplied score keys. The contribution schema
  // accepts arbitrary record keys, so a malicious or buggy agent can publish
  // thousands of metric names, names with control characters, or two names
  // that collide after sanitization. Process in this order:
  //   1. Sort raw names for stable order across renders.
  //   2. Sanitize + drop names that have no entries OR sanitize to empty —
  //      otherwise leading control-only names eat the cap and hide valid
  //      slices that come after.
  //   3. De-duplicate sanitized labels with an ordinal suffix so two raw
  //      names that sanitize to the same string both render rather than
  //      one shadowing the other (`indexOf`/`find` collision).
  //   4. Cap.
  const seenLabels = new Set<string>();
  const metricCandidates: { rawName: string; safeName: string }[] = [];
  // Truly bounded enumeration. Object.keys() materializes the full key
  // array up-front — for a 100k-key byMetric that's 100k allocated strings
  // BEFORE any break can trigger. Use for...in + Object.hasOwn so we walk
  // own properties one at a time and bail at the scan budget without
  // touching the rest of the keyspace.
  // Two-stage selection:
  //   1. Iterate own keys up to MAX_RAW_METRIC_KEYS, collecting valid
  //      sanitized candidates until MAX_METRIC_SLICES are gathered. Junk
  //      early keys don't consume the display cap.
  //   2. Sort the collected candidates alphabetically for stable display.
  const byMetric = frontier.byMetric ?? {};
  let scanned = 0;
  for (const rawName in byMetric) {
    if (!Object.hasOwn(byMetric, rawName)) continue;
    if (scanned >= MAX_RAW_METRIC_KEYS) break;
    if (metricCandidates.length >= MAX_METRIC_SLICES) break;
    scanned++;
    const entries = byMetric[rawName];
    if (!entries || entries.length === 0) continue;
    const base = sanitizeMetricName(rawName);
    if (base.length === 0) continue;
    let safeName = base;
    let suffix = 2;
    while (seenLabels.has(safeName)) {
      safeName = `${base}#${String(suffix++)}`;
    }
    seenLabels.add(safeName);
    metricCandidates.push({ rawName, safeName });
  }
  metricCandidates.sort((a, b) => (a.safeName < b.safeName ? -1 : a.safeName > b.safeName ? 1 : 0));
  for (const { rawName, safeName } of metricCandidates) {
    const entries = byMetric[rawName] ?? [];
    slices.push({
      key: `metric:${safeName}`,
      label: safeName,
      signalDescription: `${safeName} — per-contribution score`,
      entries,
      formatBadge: metricBadge(safeName),
    });
  }
  return slices;
}

/** Cap on metric:* slices rendered. The flat-table predecessor was bounded
 *  by row count; the tabbed view is bounded by metric count. */
const MAX_METRIC_SLICES = 16;
const MAX_METRIC_LABEL_LEN = 32;
/** Hard ceiling on raw metric keys we'll even consider per projection.
 *  Bounds the sort cost when an agent publishes huge score keysets. */
const MAX_RAW_METRIC_KEYS = 1024;

/** Strip control characters and trim to MAX_METRIC_LABEL_LEN. */
function sanitizeMetricName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
  const stripped = name.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return stripped.length > MAX_METRIC_LABEL_LEN
    ? stripped.slice(0, MAX_METRIC_LABEL_LEN - 1) + "…"
    : stripped;
}

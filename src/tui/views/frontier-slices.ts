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
  const metricNames = Object.keys(frontier.byMetric ?? {}).sort();
  for (const name of metricNames) {
    const entries = frontier.byMetric[name];
    if (!entries || entries.length === 0) continue;
    slices.push({
      key: `metric:${name}`,
      label: name,
      signalDescription: `${name} — per-contribution score`,
      entries,
      formatBadge: metricBadge(name),
    });
  }
  return slices;
}

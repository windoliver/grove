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

function placeholderBadge(_entry: FrontierEntry): string {
  return "";
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
      formatBadge: placeholderBadge,
    });
  }
  return slices;
}

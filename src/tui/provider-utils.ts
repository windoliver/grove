/**
 * Shared utilities for TUI data providers.
 *
 * Extracted from LocalDataProvider and RemoteDataProvider to avoid
 * duplication of dashboard summary logic.
 */

import type { Frontier } from "../core/frontier.js";
import type { FrontierSummary } from "./provider.js";

/** Build a compact frontier summary from full frontier data. */
export function buildFrontierSummary(frontier: Frontier): FrontierSummary {
  const topByMetric: FrontierSummary["topByMetric"][number][] = [];
  for (const [metric, entries] of Object.entries(frontier.byMetric)) {
    const top = entries[0];
    if (top) {
      topByMetric.push({
        metric,
        cid: top.cid,
        summary: top.summary,
        value: top.value,
      });
    }
  }

  const topByAdoption = frontier.byAdoption.slice(0, 3).map((e) => ({
    cid: e.cid,
    summary: e.summary,
    count: e.value,
  }));

  return { topByMetric, topByAdoption };
}

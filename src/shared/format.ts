/**
 * Pure formatting utilities shared across CLI, TUI, and other surfaces.
 *
 * These functions are display-agnostic — they transform data into strings
 * but do not write to stdout or depend on any rendering framework.
 */

import type { FrontierEntry } from "../core/frontier.js";
import type { Contribution, Score } from "../core/models.js";

/** Truncate a CID to a short display form: "blake3:abc123...". */
export function truncateCid(cid: string, length = 12): string {
  const prefix = "blake3:";
  if (!cid.startsWith(prefix)) return cid.slice(0, length);
  return `${prefix}${cid.slice(prefix.length, prefix.length + length)}..`;
}

/** Format an ISO timestamp as a short relative or absolute string. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (diffMs < 0) return date.toISOString().slice(0, 16).replace("T", " ");

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return date.toISOString().slice(0, 10);
}

/** Format a score value with optional unit. */
export function formatScore(score: Score): string {
  const val = Number.isInteger(score.value) ? score.value.toString() : score.value.toFixed(4);
  return score.unit ? `${val} ${score.unit}` : val;
}

/** Options for row conversion. */
export interface RowOptions {
  /** When true, show full CIDs without truncation. */
  readonly wide?: boolean | undefined;
}

/** Convert a Contribution to a display row record. */
export function contributionToRow(c: Contribution, options?: RowOptions): Record<string, string> {
  return {
    cid: options?.wide ? c.cid : truncateCid(c.cid),
    kind: c.kind,
    summary: c.summary,
    agent: c.agent.agentName ?? c.agent.agentId,
    created: formatTimestamp(c.createdAt),
  };
}

/** Convert a FrontierEntry to a display row record. */
export function frontierEntryToRow(
  entry: FrontierEntry,
  options?: RowOptions,
): Record<string, string> {
  return {
    cid: options?.wide ? entry.cid : truncateCid(entry.cid),
    summary: entry.summary,
    value: entry.value.toFixed(2),
    agent: entry.contribution.agent.agentName ?? entry.contribution.agent.agentId,
    created: formatTimestamp(entry.contribution.createdAt),
  };
}

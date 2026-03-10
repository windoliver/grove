/**
 * Shared CLI output formatting utilities.
 *
 * Zero-dependency table formatter, CID truncation, and common display helpers.
 */

import type { FrontierEntry } from "../core/frontier.js";
import type { Contribution, Score } from "../core/models.js";
import type { ThreadNode, ThreadSummary } from "../core/store.js";

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

// ---------------------------------------------------------------------------
// Table formatter
// ---------------------------------------------------------------------------

/** Column definition for the table formatter. */
export interface Column {
  readonly header: string;
  readonly key: string;
  readonly align?: "left" | "right";
  readonly maxWidth?: number;
}

/** Format rows as an aligned text table. */
export function formatTable(
  columns: readonly Column[],
  rows: readonly Record<string, string>[],
): string {
  if (rows.length === 0) return "(no results)";

  // Compute widths
  const widths: number[] = columns.map((col) => {
    const dataMax = rows.reduce((max, row) => Math.max(max, (row[col.key] ?? "").length), 0);
    const natural = Math.max(col.header.length, dataMax);
    return col.maxWidth !== undefined ? Math.min(natural, col.maxWidth) : natural;
  });

  const pad = (s: string, w: number, align: "left" | "right" = "left"): string => {
    const truncated = s.length > w ? `${s.slice(0, w - 2)}..` : s;
    return align === "right" ? truncated.padStart(w) : truncated.padEnd(w);
  };

  const header = columns.map((col, i) => pad(col.header, widths[i] ?? 0, col.align)).join("  ");
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows.map((row) =>
    columns.map((col, i) => pad(row[col.key] ?? "", widths[i] ?? 0, col.align)).join("  "),
  );

  return [header, separator, ...body].join("\n");
}

// ---------------------------------------------------------------------------
// Contribution formatters
// ---------------------------------------------------------------------------

/** Standard columns for contribution listing. */
const CONTRIBUTION_COLUMNS: readonly Column[] = [
  { header: "CID", key: "cid", maxWidth: 22 },
  { header: "KIND", key: "kind", maxWidth: 14 },
  { header: "SUMMARY", key: "summary", maxWidth: 50 },
  { header: "AGENT", key: "agent", maxWidth: 16 },
  { header: "CREATED", key: "created", maxWidth: 16 },
];

/** Convert a Contribution to a display row. */
export function contributionToRow(c: Contribution): Record<string, string> {
  return {
    cid: truncateCid(c.cid),
    kind: c.kind,
    summary: c.summary,
    agent: c.agent.agentName ?? c.agent.agentId,
    created: formatTimestamp(c.createdAt),
  };
}

/** Format a list of contributions as a table. */
export function formatContributions(contributions: readonly Contribution[]): string {
  return formatTable(CONTRIBUTION_COLUMNS, contributions.map(contributionToRow));
}

// ---------------------------------------------------------------------------
// Frontier formatters
// ---------------------------------------------------------------------------

/** Standard columns for frontier display. */
const FRONTIER_COLUMNS: readonly Column[] = [
  { header: "CID", key: "cid", maxWidth: 22 },
  { header: "SUMMARY", key: "summary", maxWidth: 40 },
  { header: "VALUE", key: "value", align: "right", maxWidth: 14 },
  { header: "AGENT", key: "agent", maxWidth: 16 },
  { header: "CREATED", key: "created", maxWidth: 16 },
];

/** Convert a FrontierEntry to a display row. */
export function frontierEntryToRow(entry: FrontierEntry): Record<string, string> {
  return {
    cid: truncateCid(entry.cid),
    summary: entry.summary,
    value: entry.value.toFixed(2),
    agent: entry.contribution.agent.agentName ?? entry.contribution.agent.agentId,
    created: formatTimestamp(entry.contribution.createdAt),
  };
}

/** Format frontier entries as a table with a heading. */
export function formatFrontierSection(heading: string, entries: readonly FrontierEntry[]): string {
  if (entries.length === 0) return "";
  const table = formatTable(FRONTIER_COLUMNS, entries.map(frontierEntryToRow));
  return `${heading}\n${table}`;
}

// ---------------------------------------------------------------------------
// Thread formatters
// ---------------------------------------------------------------------------

/**
 * Format a discussion thread with indentation showing reply depth.
 *
 * Output:
 *   blake3:abc123..  "Topic question"  alice  2m ago
 *     blake3:def456..  "Reply message"  bob  1m ago
 *       blake3:ghi789..  "Nested reply"  carol  30s ago
 */
export function formatThread(nodes: readonly ThreadNode[]): string {
  if (nodes.length === 0) return "(empty thread)";

  const lines: string[] = [];
  for (const node of nodes) {
    const indent = "  ".repeat(node.depth);
    const cid = truncateCid(node.contribution.cid);
    const summary = node.contribution.summary;
    const agent = node.contribution.agent.agentName ?? node.contribution.agent.agentId;
    const time = formatTimestamp(node.contribution.createdAt);

    // Truncate summary for readability
    const maxSummary = 60 - node.depth * 2;
    const trimmedSummary =
      summary.length > maxSummary ? `${summary.slice(0, maxSummary - 2)}..` : summary;

    lines.push(`${indent}${cid}  ${trimmedSummary}  [${agent}]  ${time}`);
  }

  return lines.join("\n");
}

/** Standard columns for hot threads display. */
const HOT_THREADS_COLUMNS: readonly Column[] = [
  { header: "CID", key: "cid", maxWidth: 22 },
  { header: "REPLIES", key: "replies", align: "right", maxWidth: 8 },
  { header: "SUMMARY", key: "summary", maxWidth: 40 },
  { header: "LAST REPLY", key: "lastReply", maxWidth: 16 },
  { header: "AGENT", key: "agent", maxWidth: 16 },
];

/** Format hot threads as a table. */
export function formatHotThreads(summaries: readonly ThreadSummary[]): string {
  const rows = summaries.map((s) => ({
    cid: truncateCid(s.contribution.cid),
    replies: String(s.replyCount),
    summary: s.contribution.summary,
    lastReply: formatTimestamp(s.lastReplyAt),
    agent: s.contribution.agent.agentName ?? s.contribution.agent.agentId,
  }));
  return formatTable(HOT_THREADS_COLUMNS, rows);
}

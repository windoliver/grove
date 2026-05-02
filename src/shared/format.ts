/**
 * Pure formatting utilities shared across CLI, TUI, and other surfaces.
 *
 * These functions are display-agnostic — they transform data into strings
 * but do not write to stdout or depend on any rendering framework.
 */

import type { FrontierEntry } from "../core/frontier.js";
import type { Contribution, Score } from "../core/models.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape stripping
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape stripping
const ANSI_OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

/** Strip ANSI escape codes (CSI sequences and OSC sequences) from a string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_OSC_RE, "").replace(ANSI_CSI_RE, "");
}

/** Truncate a CID to a short display form: "blake3:abc123...". */
export function truncateCid(cid: string, length = 12): string {
  const prefix = "blake3:";
  if (!cid.startsWith(prefix)) return cid.slice(0, length);
  return `${prefix}${cid.slice(prefix.length, prefix.length + length)}..`;
}

/** Compare two ISO timestamps chronologically (parses to ms epoch).
 *
 *  Lexicographic comparison only works for normalized UTC strings; manifest
 *  entries can carry timezone offsets like `+05:00` that would otherwise
 *  sort wrong (e.g. `2026-01-02T00:00:00+05:00` is chronologically
 *  EARLIER than `2026-01-01T20:00:00Z` despite sorting after as a string).
 *  Returns negative when `a` is older, positive when `a` is newer, 0 when
 *  equal (or both unparseable). Invalid/missing inputs sort LAST in
 *  ascending order so bad timestamps don't displace real data from a
 *  "newest" or "oldest" cap.
 */
export function compareTimestamps(a: string | undefined, b: string | undefined): number {
  const ta = a ? Date.parse(a) : Number.NaN;
  const tb = b ? Date.parse(b) : Number.NaN;
  const aBad = Number.isNaN(ta);
  const bBad = Number.isNaN(tb);
  if (aBad && bBad) return 0;
  if (aBad) return 1;
  if (bBad) return -1;
  return ta - tb;
}

/** Descending chronological compare (newest first). Critically, invalid /
 *  missing timestamps still sort LAST — naively passing args reversed to
 *  `compareTimestamps` would invert the NaN policy and let bad-timestamp
 *  rows displace real recent contributions in a slice(0, N) cap.
 */
export function compareTimestampsDesc(a: string | undefined, b: string | undefined): number {
  const ta = a ? Date.parse(a) : Number.NaN;
  const tb = b ? Date.parse(b) : Number.NaN;
  const aBad = Number.isNaN(ta);
  const bBad = Number.isNaN(tb);
  if (aBad && bBad) return 0;
  if (aBad) return 1;
  if (bBad) return -1;
  return tb - ta;
}

/** Ascending chronological compare with invalid-FIRST semantics — for
 *  callers like the running feed where the TAIL has special meaning
 *  (auto-follow targets `arr.length - 1` as "newest"). The default
 *  `compareTimestamps` puts invalids last in ASC, which would let a
 *  malformed-timestamp row steal the cursor's "newest" focus.
 */
export function compareTimestampsAscNewestLast(
  a: string | undefined,
  b: string | undefined,
): number {
  const ta = a ? Date.parse(a) : Number.NaN;
  const tb = b ? Date.parse(b) : Number.NaN;
  const aBad = Number.isNaN(ta);
  const bBad = Number.isNaN(tb);
  if (aBad && bBad) return 0;
  if (aBad) return -1;
  if (bBad) return 1;
  return ta - tb;
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
    agent: entry.contribution?.agent.agentName ?? entry.contribution?.agent.agentId ?? "—",
    created: entry.contribution ? formatTimestamp(entry.contribution.createdAt) : "—",
  };
}

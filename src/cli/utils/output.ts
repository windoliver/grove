/**
 * CLI output formatting utilities.
 *
 * Simple table formatting using padEnd — no external dependencies.
 */

import type { Claim } from "../../core/models.js";
import { formatDuration } from "./duration.js";

/** Column definition for table formatting. */
interface Column {
  readonly header: string;
  readonly width: number;
  readonly getValue: (claim: Claim) => string;
}

const COLUMNS: readonly Column[] = [
  { header: "CLAIM_ID", width: 36, getValue: (c) => c.claimId },
  { header: "TARGET", width: 20, getValue: (c) => truncate(c.targetRef, 20) },
  { header: "AGENT", width: 18, getValue: (c) => truncate(c.agent.agentId, 18) },
  { header: "STATUS", width: 10, getValue: (c) => claimStatusDisplay(c) },
  { header: "LEASE", width: 16, getValue: (c) => leaseDisplay(c) },
  { header: "INTENT", width: 30, getValue: (c) => truncate(c.intentSummary, 30) },
];

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

function claimStatusDisplay(claim: Claim): string {
  if (claim.status === "active") {
    const remaining = new Date(claim.leaseExpiresAt).getTime() - Date.now();
    return remaining > 0 ? "active" : "expired";
  }
  return claim.status;
}

function leaseDisplay(claim: Claim): string {
  const expiresAt = new Date(claim.leaseExpiresAt).getTime();
  const now = Date.now();
  const remaining = expiresAt - now;

  if (claim.status !== "active") return "-";
  if (remaining <= 0) return "expired";
  return `${formatDuration(remaining)} left`;
}

/** Format a list of claims as a table string. */
export function formatClaimsTable(claims: readonly Claim[]): string {
  if (claims.length === 0) return "No claims found.";

  const header = COLUMNS.map((col) => col.header.padEnd(col.width)).join("  ");
  const separator = COLUMNS.map((col) => "─".repeat(col.width)).join("  ");
  const rows = claims.map((claim) =>
    COLUMNS.map((col) => col.getValue(claim).padEnd(col.width)).join("  "),
  );

  return [header, separator, ...rows].join("\n");
}

/** Format a single claim for display after create/release/complete. */
export function formatClaimSummary(claim: Claim, action: string): string {
  const lines = [
    `${action}: ${claim.claimId}`,
    `  target:  ${claim.targetRef}`,
    `  agent:   ${claim.agent.agentId}`,
    `  status:  ${claim.status}`,
    `  intent:  ${claim.intentSummary}`,
  ];

  if (claim.status === "active") {
    const remaining = new Date(claim.leaseExpiresAt).getTime() - Date.now();
    lines.push(`  expires: ${formatDuration(remaining)} (${claim.leaseExpiresAt})`);
  }

  return lines.join("\n");
}

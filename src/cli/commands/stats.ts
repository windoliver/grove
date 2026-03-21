/**
 * `grove stats` — show contribution statistics for the grove.
 *
 * Displays total contributions, breakdown by kind, and per-agent counts.
 * Uses the `withCliDeps` pattern for store access.
 */

import { parseArgs } from "node:util";

import { ContributionKind } from "../../core/models.js";
import type { CliDeps } from "../context.js";
import { outputJson } from "../format.js";

export function parseStatsArgs(args: readonly string[]): { json: boolean } {
  const { values } = parseArgs({
    args: args as string[],
    options: {
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  return { json: values.json ?? false };
}

export async function runStats(opts: { json: boolean }, deps: CliDeps): Promise<void> {
  const all = await deps.store.list({});

  // Count by kind
  const byKind: Record<string, number> = {};
  for (const kind of Object.values(ContributionKind)) {
    byKind[kind] = 0;
  }
  // Count by agent
  const byAgent: Record<string, number> = {};

  for (const c of all) {
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    const agentLabel = c.agent.agentName || c.agent.agentId;
    byAgent[agentLabel] = (byAgent[agentLabel] ?? 0) + 1;
  }

  // Active claims
  const claims = await deps.claimStore.activeClaims();

  if (opts.json) {
    outputJson({ total: all.length, byKind, byAgent, activeClaims: claims.length });
    return;
  }

  console.log(`Contributions: ${all.length}`);
  console.log();

  // By kind
  console.log("By kind:");
  for (const [kind, count] of Object.entries(byKind)) {
    if (count > 0) {
      console.log(`  ${kind.padEnd(14)} ${count}`);
    }
  }
  console.log();

  // By agent
  const agentEntries = Object.entries(byAgent).sort((a, b) => b[1] - a[1]);
  if (agentEntries.length > 0) {
    console.log("By agent:");
    for (const [agent, count] of agentEntries) {
      const label = agent.length > 30 ? `${agent.slice(0, 28)}..` : agent;
      console.log(`  ${label.padEnd(30)} ${count}`);
    }
    console.log();
  }

  console.log(`Active claims: ${claims.length}`);
}

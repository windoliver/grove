/**
 * grove claim — claim work to prevent duplication.
 *
 * Uses claimOrRenew() so re-running the same claim from the same agent
 * renews the lease instead of failing. Only fails when a different agent
 * holds the target.
 *
 * Usage:
 *   grove claim "optimize the parser module" --lease 30m
 *   grove claim blake3:abc123 --intent "extend with caching" --lease 1h
 *   grove claim <target> --agent-id my-agent --lease 15m
 */

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

import type { ClaimStore } from "../../core/store.js";
import { parseDuration } from "../utils/duration.js";
import { resolveAgentId } from "../utils/grove-dir.js";
import { formatClaimSummary } from "../utils/output.js";

const DEFAULT_LEASE = "5m";

export interface ClaimDeps {
  readonly claimStore: ClaimStore;
  readonly stdout: (msg: string) => void;
  readonly stderr: (msg: string) => void;
}

export async function runClaim(args: readonly string[], deps: ClaimDeps): Promise<void> {
  const { values, positionals } = parseArgs({
    args: args as string[],
    options: {
      lease: { type: "string", short: "l", default: DEFAULT_LEASE },
      intent: { type: "string", short: "i" },
      "agent-id": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const target = positionals[0];
  if (!target) {
    deps.stderr(
      "Error: target is required.\n\nUsage: grove claim <target> [--lease 30m] [--intent '...']",
    );
    process.exitCode = 2;
    return;
  }

  const leaseMs = parseDuration(values.lease ?? DEFAULT_LEASE);
  const agentId = resolveAgentId(values["agent-id"]);
  const intent = values.intent ?? target;

  // Warn about existing active claims by other agents on this target
  const existing = await deps.claimStore.activeClaims(target);
  for (const c of existing) {
    if (c.agent.agentId !== agentId) {
      deps.stderr(
        `Warning: target '${target}' has active claim '${c.claimId}' by '${c.agent.agentId}'`,
      );
    }
  }

  const now = new Date();
  const claim = await deps.claimStore.claimOrRenew({
    claimId: randomUUID(),
    targetRef: target,
    agent: { agentId },
    status: "active" as const,
    intentSummary: intent,
    createdAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
  });

  // Distinguish new claim from renewal
  const isRenewal = existing.some((c) => c.agent.agentId === agentId);
  deps.stdout(formatClaimSummary(claim, isRenewal ? "Renewed" : "Claimed"));
}

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

import { parseArgs } from "node:util";
import type { OperationDeps } from "../../core/operations/index.js";
import { claimOperation, ErrorCode } from "../../core/operations/index.js";
import type { ClaimStore } from "../../core/store.js";
import { outputJson, outputJsonError } from "../format.js";
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
      json: { type: "boolean", default: false },
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

  // Build minimal OperationDeps with only what claimOperation needs
  const opDeps: OperationDeps = {
    claimStore: deps.claimStore,
  };

  const result = await claimOperation(
    {
      targetRef: target,
      intentSummary: intent,
      leaseDurationMs: leaseMs,
      agent: { agentId },
    },
    opDeps,
  );

  if (!result.ok) {
    if (values.json) {
      outputJsonError(result.error);
      return;
    }
    // For claim conflicts, produce an error message compatible with the original
    // ClaimConflictError format that includes "active claim".
    if (result.error.code === ErrorCode.ClaimConflict) {
      const details = result.error.details as
        | { targetRef?: string; heldByAgentId?: string; heldByClaimId?: string }
        | undefined;
      const heldBy = details?.heldByAgentId ?? "unknown";
      const claimId = details?.heldByClaimId ?? "unknown";
      throw new Error(
        `Target '${target}' already has an active claim '${claimId}' by agent '${heldBy}'`,
      );
    }
    throw new Error(result.error.message);
  }

  if (values.json) {
    outputJson(result.value);
    return;
  }

  // Fetch the claim object for formatting (formatClaimSummary expects a Claim)
  const claim = await deps.claimStore.getClaim(result.value.claimId);
  if (claim === undefined) {
    // Should not happen after a successful operation
    deps.stdout(
      `${result.value.renewed ? "Renewed" : "Claimed"}: ${result.value.claimId}\n` +
        `  target:  ${result.value.targetRef}\n` +
        `  agent:   ${result.value.agentId}\n` +
        `  status:  ${result.value.status}`,
    );
    return;
  }

  deps.stdout(formatClaimSummary(claim, result.value.renewed ? "Renewed" : "Claimed"));
}

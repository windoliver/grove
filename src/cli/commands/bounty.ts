/**
 * grove bounty — bounty subcommands.
 *
 * Usage:
 *   grove bounty create <title> --amount 100 --deadline 7d [--criteria '...']
 *   grove bounty list [--status open] [--mine]
 *   grove bounty claim <bounty-id>
 */

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

import type { BountyStore } from "../../core/bounty-store.js";
import type { Bounty } from "../../core/bounty.js";
import { BountyStatus } from "../../core/bounty.js";
import type { CreditsService } from "../../core/credits.js";
import type { ClaimStore } from "../../core/store.js";
import { parseDuration } from "../utils/duration.js";
import { resolveAgentId } from "../utils/grove-dir.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BountyDeps {
  readonly bountyStore: BountyStore;
  /** Optional — when absent, bounties work without credit enforcement (local dev). */
  readonly creditsService?: CreditsService | undefined;
  readonly claimStore: ClaimStore;
  readonly stdout: (msg: string) => void;
  readonly stderr: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Subcommand dispatch
// ---------------------------------------------------------------------------

export async function runBounty(args: readonly string[], deps: BountyDeps): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "create":
      return runBountyCreate(subArgs, deps);
    case "list":
      return runBountyList(subArgs, deps);
    case "claim":
      return runBountyClaim(subArgs, deps);
    default:
      deps.stderr(
        `grove bounty: ${subcommand ? `unknown subcommand '${subcommand}'` : "subcommand required"}\n\n` +
          "Usage:\n" +
          "  grove bounty create <title> --amount <credits> --deadline <duration>\n" +
          "  grove bounty list [--status <status>] [--mine]\n" +
          "  grove bounty claim <bounty-id>",
      );
      process.exitCode = 2;
  }
}

// ---------------------------------------------------------------------------
// grove bounty create
// ---------------------------------------------------------------------------

async function runBountyCreate(args: readonly string[], deps: BountyDeps): Promise<void> {
  const { values, positionals } = parseArgs({
    args: args as string[],
    options: {
      amount: { type: "string", short: "a" },
      deadline: { type: "string", short: "d" },
      description: { type: "string" },
      criteria: { type: "string" },
      "metric-name": { type: "string" },
      "metric-threshold": { type: "string" },
      "metric-direction": { type: "string" },
      tags: { type: "string" },
      "agent-id": { type: "string" },
      "zone-id": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const title = positionals.join(" ");
  if (!title) {
    deps.stderr("Error: title is required.\n\nUsage: grove bounty create <title> --amount <credits> --deadline <duration>");
    process.exitCode = 2;
    return;
  }

  if (!values.amount) {
    deps.stderr("Error: --amount is required.");
    process.exitCode = 2;
    return;
  }

  if (!values.deadline) {
    deps.stderr("Error: --deadline is required.");
    process.exitCode = 2;
    return;
  }

  const amount = parseInt(values.amount, 10);
  if (Number.isNaN(amount) || amount <= 0) {
    deps.stderr(`Error: --amount must be a positive integer, got '${values.amount}'`);
    process.exitCode = 2;
    return;
  }

  const deadlineMs = parseDuration(values.deadline);
  const deadline = new Date(Date.now() + deadlineMs).toISOString();
  const agentId = resolveAgentId(values["agent-id"]);

  const criteria = {
    description: values.criteria ?? title,
    metricName: values["metric-name"],
    metricThreshold: values["metric-threshold"] !== undefined
      ? parseFloat(values["metric-threshold"])
      : undefined,
    metricDirection: values["metric-direction"] as "minimize" | "maximize" | undefined,
    requiredTags: values.tags?.split(",").map((t) => t.trim()),
  };

  const bountyId = randomUUID();
  const now = new Date().toISOString();

  // Reserve credits (skip when no credits service — local dev mode)
  let reservationId: string | undefined;
  if (deps.creditsService) {
    reservationId = randomUUID();
    await deps.creditsService.reserve({
      reservationId,
      agentId,
      amount,
      timeoutMs: deadlineMs + 24 * 60 * 60 * 1000, // deadline + 1 day safety margin
    });
  }

  const bounty: Bounty = {
    bountyId,
    title,
    description: values.description ?? title,
    status: BountyStatus.Open,
    creator: { agentId },
    amount,
    criteria,
    zoneId: values["zone-id"],
    deadline,
    reservationId,
    createdAt: now,
    updatedAt: now,
  };

  await deps.bountyStore.createBounty(bounty);
  deps.stdout(formatBountySummary(bounty, "Created"));
}

// ---------------------------------------------------------------------------
// grove bounty list
// ---------------------------------------------------------------------------

async function runBountyList(args: readonly string[], deps: BountyDeps): Promise<void> {
  const { values } = parseArgs({
    args: args as string[],
    options: {
      status: { type: "string", short: "s" },
      mine: { type: "boolean" },
      "agent-id": { type: "string" },
      limit: { type: "string", short: "n", default: "20" },
    },
    strict: true,
  });

  const agentId = values.mine ? resolveAgentId(values["agent-id"]) : undefined;
  const statusFilter = values.status as BountyStatus | undefined;

  const bounties = await deps.bountyStore.listBounties({
    status: statusFilter,
    creatorAgentId: agentId,
    limit: parseInt(values.limit ?? "20", 10),
  });

  if (bounties.length === 0) {
    deps.stdout("No bounties found.");
    return;
  }

  for (const b of bounties) {
    deps.stdout(formatBountyLine(b));
  }
}

// ---------------------------------------------------------------------------
// grove bounty claim
// ---------------------------------------------------------------------------

async function runBountyClaim(args: readonly string[], deps: BountyDeps): Promise<void> {
  const { values, positionals } = parseArgs({
    args: args as string[],
    options: {
      "agent-id": { type: "string" },
      lease: { type: "string", short: "l", default: "30m" },
    },
    allowPositionals: true,
    strict: true,
  });

  const bountyId = positionals[0];
  if (!bountyId) {
    deps.stderr("Error: bounty-id is required.\n\nUsage: grove bounty claim <bounty-id>");
    process.exitCode = 2;
    return;
  }

  const bounty = await deps.bountyStore.getBounty(bountyId);
  if (!bounty) {
    deps.stderr(`Error: bounty '${bountyId}' not found.`);
    process.exitCode = 1;
    return;
  }

  if (bounty.status !== BountyStatus.Open) {
    deps.stderr(`Error: bounty '${bountyId}' is not open (status: ${bounty.status}).`);
    process.exitCode = 1;
    return;
  }

  const agentId = resolveAgentId(values["agent-id"]);
  const leaseMs = parseDuration(values.lease ?? "30m");

  // Create a claim via the existing claim system
  const now = new Date();
  const claimId = randomUUID();
  const claim = await deps.claimStore.claimOrRenew({
    claimId,
    targetRef: `bounty:${bountyId}`,
    agent: { agentId },
    status: "active" as const,
    intentSummary: `Claiming bounty: ${bounty.title}`,
    createdAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
  });

  // Update bounty status
  const claimed = await deps.bountyStore.claimBounty(bountyId, { agentId }, claim.claimId);
  deps.stdout(formatBountySummary(claimed, "Claimed"));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatBountySummary(bounty: Bounty, action: string): string {
  const lines = [
    `${action} bounty ${bounty.bountyId}`,
    `  Title:    ${bounty.title}`,
    `  Amount:   ${bounty.amount} credits`,
    `  Status:   ${bounty.status}`,
    `  Deadline: ${bounty.deadline}`,
  ];
  if (bounty.claimedBy) {
    lines.push(`  Claimed by: ${bounty.claimedBy.agentId}`);
  }
  return lines.join("\n");
}

function formatBountyLine(bounty: Bounty): string {
  const deadline = new Date(bounty.deadline);
  const remaining = deadline.getTime() - Date.now();
  const remainingStr = remaining > 0
    ? `${Math.ceil(remaining / (1000 * 60 * 60))}h remaining`
    : "expired";

  return `[${bounty.status.padEnd(9)}] ${bounty.bountyId.slice(0, 8)}… ${bounty.amount} credits — ${bounty.title} (${remainingStr})`;
}

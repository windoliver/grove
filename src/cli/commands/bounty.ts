/**
 * grove bounty — bounty subcommands.
 *
 * Usage:
 *   grove bounty create <title> --amount 100 --deadline 7d [--criteria '...']
 *   grove bounty list [--status open] [--mine]
 *   grove bounty claim <bounty-id>
 */

import { parseArgs } from "node:util";
import type { BountyStatus } from "../../core/bounty.js";
import type { BountyStore } from "../../core/bounty-store.js";
import type { CreditsService } from "../../core/credits.js";
import type { OperationDeps } from "../../core/operations/index.js";
import {
  claimBountyOperation,
  createBountyOperation,
  listBountiesOperation,
} from "../../core/operations/index.js";
import type { ClaimStore } from "../../core/store.js";
import { outputJson, outputJsonError } from "../format.js";
import { parseDuration } from "../utils/duration.js";
import { resolveAgentId } from "../utils/grove-dir.js";
import { collectErrors, formatValidationErrors } from "../utils/validate.js";

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

/** Build OperationDeps from BountyDeps (only bounty-relevant fields). */
function toOpDeps(deps: BountyDeps): OperationDeps {
  return {
    claimStore: deps.claimStore,
    contributionStore: undefined as never,
    cas: undefined as never,
    frontier: undefined as never,
    bountyStore: deps.bountyStore,
    ...(deps.creditsService !== undefined ? { creditsService: deps.creditsService } : {}),
  };
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
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const title = positionals.join(" ");

  const amountRaw = values.amount ? parseInt(values.amount, 10) : NaN;
  const errors = collectErrors([
    [!title, { field: "title", message: "title is required" }],
    [!values.amount, { field: "--amount", message: "--amount is required" }],
    [!values.deadline, { field: "--deadline", message: "--deadline is required" }],
    [
      !!values.amount && (Number.isNaN(amountRaw) || amountRaw <= 0),
      { field: "--amount", message: `--amount must be a positive integer, got '${values.amount}'` },
    ],
  ]);

  const errMsg = formatValidationErrors(
    errors,
    "Usage: grove bounty create <title> --amount <credits> --deadline <duration>",
  );
  if (errMsg) {
    deps.stderr(errMsg);
    process.exitCode = 2;
    return;
  }

  const amount = amountRaw;

  const deadlineMs = parseDuration(values.deadline as string);
  const agentId = resolveAgentId(values["agent-id"]);

  const criteria = {
    description: values.criteria ?? title,
    metricName: values["metric-name"],
    metricThreshold:
      values["metric-threshold"] !== undefined ? parseFloat(values["metric-threshold"]) : undefined,
    metricDirection: values["metric-direction"] as "minimize" | "maximize" | undefined,
    requiredTags: values.tags?.split(",").map((t) => t.trim()),
  };

  const result = await createBountyOperation(
    {
      title,
      ...(values.description !== undefined ? { description: values.description } : {}),
      amount,
      criteria,
      deadlineMs,
      agent: { agentId },
      ...(values["zone-id"] !== undefined ? { zoneId: values["zone-id"] } : {}),
    },
    toOpDeps(deps),
  );

  if (!result.ok) {
    if (values.json) {
      outputJsonError(result.error);
      return;
    }
    deps.stderr(`Error: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }

  if (values.json) {
    outputJson(result.value);
    return;
  }

  deps.stdout(formatBountySummaryFromResult(result.value, title, "Created"));
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
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  const agentId = values.mine ? resolveAgentId(values["agent-id"]) : undefined;
  const statusFilter = values.status as BountyStatus | undefined;

  const result = await listBountiesOperation(
    {
      ...(statusFilter !== undefined ? { status: statusFilter } : {}),
      ...(agentId !== undefined ? { creatorAgentId: agentId } : {}),
      limit: parseInt(values.limit ?? "20", 10),
    },
    toOpDeps(deps),
  );

  if (!result.ok) {
    if (values.json) {
      outputJsonError(result.error);
      return;
    }
    deps.stderr(`Error: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }

  if (values.json) {
    outputJson(result.value);
    return;
  }

  const bounties = result.value.bounties;

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
      json: { type: "boolean", default: false },
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

  // Pre-check: verify bounty exists and is open (the operation doesn't validate status)
  const bounty = await deps.bountyStore.getBounty(bountyId);
  if (!bounty) {
    deps.stderr(`Error: bounty '${bountyId}' not found.`);
    process.exitCode = 1;
    return;
  }
  if (bounty.status !== "open") {
    deps.stderr(`Error: bounty '${bountyId}' is not open (status: ${bounty.status}).`);
    process.exitCode = 1;
    return;
  }

  const agentId = resolveAgentId(values["agent-id"]);
  const leaseMs = parseDuration(values.lease ?? "30m");

  const result = await claimBountyOperation(
    {
      bountyId,
      agent: { agentId },
      leaseDurationMs: leaseMs,
    },
    toOpDeps(deps),
  );

  if (!result.ok) {
    if (values.json) {
      outputJsonError(result.error);
      return;
    }
    deps.stderr(`Error: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }

  if (values.json) {
    outputJson(result.value);
    return;
  }

  const v = result.value;
  const lines = [
    `Claimed bounty ${v.bountyId}`,
    `  Title:    ${v.title}`,
    `  Status:   ${v.status}`,
    `  Claim ID: ${v.claimId}`,
  ];
  if (v.claimedBy !== undefined) {
    lines.push(`  Claimed by: ${v.claimedBy}`);
  }
  deps.stdout(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatBountySummaryFromResult(
  result: { bountyId: string; title: string; amount: number; status: string; deadline: string },
  title: string,
  action: string,
): string {
  const lines = [
    `${action} bounty ${result.bountyId}`,
    `  Title:    ${title}`,
    `  Amount:   ${result.amount} credits`,
    `  Status:   ${result.status}`,
    `  Deadline: ${result.deadline}`,
  ];
  return lines.join("\n");
}

function formatBountyLine(bounty: {
  bountyId: string;
  title: string;
  amount: number;
  status: string;
  deadline: string;
}): string {
  const deadline = new Date(bounty.deadline);
  const remaining = deadline.getTime() - Date.now();
  const remainingStr =
    remaining > 0 ? `${Math.ceil(remaining / (1000 * 60 * 60))}h remaining` : "expired";

  return `[${bounty.status.padEnd(9)}] ${bounty.bountyId.slice(0, 8)}… ${bounty.amount} credits — ${bounty.title} (${remainingStr})`;
}

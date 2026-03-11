/**
 * MCP tools for bounty operations.
 *
 * grove_bounty_create  — Create a new bounty with credit reservation
 * grove_bounty_list    — List bounties with filters
 * grove_bounty_claim   — Claim an open bounty
 * grove_bounty_settle  — Settle a completed bounty (distribute credits)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Bounty, BountyCriteria } from "../../core/bounty.js";
import { BountyStatus } from "../../core/bounty.js";
import { evaluateBountyCriteria } from "../../core/bounty-logic.js";
import type { JsonValue } from "../../core/models.js";
import type { AgentInput } from "../agent-identity.js";
import { resolveAgentIdentity } from "../agent-identity.js";
import type { McpDeps } from "../deps.js";
import { handleToolError, notFoundError } from "../error-handler.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const agentSchema = z
  .object({
    agentId: z.string().optional().describe("Unique agent identifier"),
    agentName: z.string().optional().describe("Human-readable agent name"),
    provider: z.string().optional().describe("Agent provider"),
    model: z.string().optional().describe("Model identifier"),
  })
  .optional()
  .describe("Agent identity. If omitted, resolved from env vars.");

const criteriaSchema = z.object({
  description: z.string().describe("What the contribution must achieve"),
  metricName: z.string().optional().describe("Metric name to evaluate (e.g., 'val_bpb')"),
  metricThreshold: z.number().optional().describe("Threshold value the metric must reach"),
  metricDirection: z.enum(["minimize", "maximize"]).optional().describe("Whether lower or higher is better"),
  requiredTags: z.array(z.string()).optional().describe("Tags the contribution must include"),
});

const createBountySchema = z.object({
  title: z.string().describe("Short descriptive title for the bounty"),
  description: z.string().optional().describe("Detailed bounty description"),
  amount: z.number().int().positive().describe("Credit amount to offer"),
  criteria: criteriaSchema.describe("Criteria a contribution must meet to fulfill this bounty"),
  deadlineMs: z
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60 * 1000)
    .describe("Deadline in ms from now (default: 7 days)"),
  agent: agentSchema,
  zoneId: z.string().optional().describe("Zone scope for multi-tenant deployments"),
  context: z.record(z.string(), z.unknown()).optional().describe("Optional bounty metadata"),
});

const listBountiesSchema = z.object({
  status: z
    .enum(["draft", "open", "claimed", "completed", "settled", "expired", "cancelled"])
    .optional()
    .describe("Filter by bounty status"),
  creatorAgentId: z.string().optional().describe("Filter by creator agent ID"),
  limit: z.number().int().positive().optional().default(20).describe("Max results (default: 20)"),
});

const claimBountySchema = z.object({
  bountyId: z.string().describe("ID of the bounty to claim"),
  agent: agentSchema,
  leaseDurationMs: z
    .number()
    .int()
    .positive()
    .optional()
    .default(1_800_000)
    .describe("Claim lease duration in ms (default: 30 minutes)"),
});

const settleBountySchema = z.object({
  bountyId: z.string().describe("ID of the bounty to settle"),
  contributionCid: z.string().describe("CID of the contribution that fulfilled the bounty"),
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerBountyTools(server: McpServer, deps: McpDeps): void {
  // --- grove_bounty_create -------------------------------------------------
  server.registerTool(
    "grove_bounty_create",
    {
      description:
        "Create a new bounty offering credits for specific work. Credits are reserved " +
        "from the creator's balance and held in escrow until the bounty is settled or expires.",
      inputSchema: createBountySchema,
    },
    async (args) => {
      try {
        const { bountyStore, creditsService } = deps;
        if (!bountyStore || !creditsService) {
          return errorResult("Bounty operations not available (missing bountyStore or creditsService)");
        }

        const agent = resolveAgentIdentity(args.agent as AgentInput);
        const now = new Date();
        const bountyId = crypto.randomUUID();
        const reservationId = crypto.randomUUID();
        const deadlineMs = args.deadlineMs ?? 7 * 24 * 60 * 60 * 1000;
        const deadline = new Date(now.getTime() + deadlineMs).toISOString();

        // Reserve credits
        await creditsService.reserve({
          reservationId,
          agentId: agent.agentId,
          amount: args.amount,
          timeoutMs: deadlineMs + 24 * 60 * 60 * 1000, // deadline + 1 day
        });

        const bounty: Bounty = {
          bountyId,
          title: args.title,
          description: args.description ?? args.title,
          status: BountyStatus.Open,
          creator: agent,
          amount: args.amount,
          criteria: args.criteria as BountyCriteria,
          zoneId: args.zoneId,
          deadline,
          reservationId,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
        };

        const result = await bountyStore.createBounty(bounty);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                bountyId: result.bountyId,
                title: result.title,
                amount: result.amount,
                status: result.status,
                deadline: result.deadline,
                reservationId: result.reservationId,
              }),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // --- grove_bounty_list ---------------------------------------------------
  server.registerTool(
    "grove_bounty_list",
    {
      description: "List bounties with optional filters by status or creator.",
      inputSchema: listBountiesSchema,
    },
    async (args) => {
      try {
        const { bountyStore } = deps;
        if (!bountyStore) {
          return errorResult("Bounty operations not available");
        }

        const bounties = await bountyStore.listBounties({
          status: args.status as BountyStatus | undefined,
          creatorAgentId: args.creatorAgentId,
          limit: args.limit,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                bounties.map((b) => ({
                  bountyId: b.bountyId,
                  title: b.title,
                  amount: b.amount,
                  status: b.status,
                  deadline: b.deadline,
                  claimedBy: b.claimedBy?.agentId,
                })),
              ),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // --- grove_bounty_claim --------------------------------------------------
  server.registerTool(
    "grove_bounty_claim",
    {
      description:
        "Claim an open bounty. Creates a claim via the existing claim system " +
        "and transitions the bounty to 'claimed' status.",
      inputSchema: claimBountySchema,
    },
    async (args) => {
      try {
        const { bountyStore, claimStore } = deps;
        if (!bountyStore) {
          return errorResult("Bounty operations not available");
        }

        const bounty = await bountyStore.getBounty(args.bountyId);
        if (!bounty) {
          return notFoundError("Bounty", args.bountyId);
        }

        const agent = resolveAgentIdentity(args.agent as AgentInput);
        const now = new Date();
        const claimId = crypto.randomUUID();

        // Create claim via existing system
        const claim = await claimStore.claimOrRenew({
          claimId,
          targetRef: `bounty:${args.bountyId}`,
          agent,
          status: "active",
          intentSummary: `Claiming bounty: ${bounty.title}`,
          createdAt: now.toISOString(),
          heartbeatAt: now.toISOString(),
          leaseExpiresAt: new Date(now.getTime() + (args.leaseDurationMs ?? 1_800_000)).toISOString(),
        });

        const claimed = await bountyStore.claimBounty(args.bountyId, agent, claim.claimId);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                bountyId: claimed.bountyId,
                title: claimed.title,
                status: claimed.status,
                claimId: claim.claimId,
                claimedBy: claimed.claimedBy?.agentId,
              }),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // --- grove_bounty_settle -------------------------------------------------
  server.registerTool(
    "grove_bounty_settle",
    {
      description:
        "Settle a bounty by marking a contribution as fulfilling it. Captures the " +
        "reserved credits and distributes them to the fulfiller.",
      inputSchema: settleBountySchema,
    },
    async (args) => {
      try {
        const { bountyStore, creditsService, contributionStore } = deps;
        if (!bountyStore || !creditsService) {
          return errorResult("Bounty operations not available");
        }

        const bounty = await bountyStore.getBounty(args.bountyId);
        if (!bounty) {
          return notFoundError("Bounty", args.bountyId);
        }

        // Validate the contribution exists and meets criteria
        const contribution = await contributionStore.get(args.contributionCid);
        if (!contribution) {
          return errorResult(`Contribution '${args.contributionCid}' not found`);
        }
        if (!evaluateBountyCriteria(bounty.criteria, contribution)) {
          return errorResult(
            `Contribution '${args.contributionCid}' does not meet bounty criteria`,
          );
        }

        // Mark as completed
        const completed = await bountyStore.completeBounty(args.bountyId, args.contributionCid);

        // Settlement: void the reservation to release the hold, then transfer
        // credits from creator to fulfiller. void()+transfer() is the correct
        // pattern — capture() would deduct from creator, making a subsequent
        // transfer() double-charge.
        if (completed.reservationId) {
          await creditsService.void(completed.reservationId);
        }

        if (completed.claimedBy) {
          await creditsService.transfer({
            transferId: `bounty-payout:${args.bountyId}`,
            fromAgentId: completed.creator.agentId,
            toAgentId: completed.claimedBy.agentId,
            amount: completed.amount,
          });
        }

        // Mark as settled
        const settled = await bountyStore.settleBounty(args.bountyId);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                bountyId: settled.bountyId,
                status: settled.status,
                fulfilledByCid: settled.fulfilledByCid,
                amount: settled.amount,
                paidTo: settled.claimedBy?.agentId,
              }),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

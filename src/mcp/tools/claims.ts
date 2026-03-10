/**
 * MCP tools for claim operations.
 *
 * grove_claim   — Create or renew a claim to prevent duplicate work
 * grove_release — Release or complete a claim
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Claim, JsonValue } from "../../core/models.js";
import type { AgentInput } from "../agent-identity.js";
import { resolveAgentIdentity } from "../agent-identity.js";
import type { McpDeps } from "../deps.js";
import { handleToolError, notFoundError } from "../error-handler.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const agentSchema = z
  .object({
    agentId: z
      .string()
      .optional()
      .describe("Unique agent identifier (default: GROVE_AGENT_ID env var or hostname-pid)"),
    agentName: z.string().optional().describe("Human-readable agent name"),
    provider: z.string().optional().describe("Agent provider"),
    model: z.string().optional().describe("Model identifier"),
    platform: z.string().optional().describe("Platform"),
    version: z.string().optional().describe("Agent version"),
    toolchain: z.string().optional().describe("Toolchain"),
    runtime: z.string().optional().describe("Runtime environment"),
  })
  .optional()
  .describe(
    "Agent identity. Optional — if omitted, resolved from GROVE_AGENT_* env vars or defaults to hostname-pid.",
  );

const claimInputSchema = z.object({
  targetRef: z.string().describe("Reference to the work target (e.g., a CID or task identifier)"),
  agent: agentSchema,
  intentSummary: z.string().describe("What the agent intends to do with this claim"),
  leaseDurationMs: z
    .number()
    .int()
    .positive()
    .optional()
    .default(300_000)
    .describe("Lease duration in milliseconds (default: 5 minutes)"),
  context: z.record(z.string(), z.unknown()).optional().describe("Optional claim metadata"),
});

const releaseInputSchema = z.object({
  claimId: z.string().describe("ID of the claim to release or complete"),
  action: z
    .enum(["release", "complete"])
    .describe("Whether to release (give up) or complete (finished work) the claim"),
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerClaimTools(server: McpServer, deps: McpDeps): void {
  // --- grove_claim --------------------------------------------------------
  server.registerTool(
    "grove_claim",
    {
      description:
        "Claim a work target to prevent duplicate effort. If the same agent already has an " +
        "active claim on the target, the lease is renewed. If a different agent has an active " +
        "claim, an error is returned. Claims expire automatically after the lease duration.",
      inputSchema: claimInputSchema,
    },
    async (args) => {
      try {
        const { claimStore } = deps;
        const now = new Date();

        const claim: Claim = {
          claimId: crypto.randomUUID(),
          targetRef: args.targetRef,
          agent: resolveAgentIdentity(args.agent as AgentInput),
          status: "active",
          intentSummary: args.intentSummary,
          createdAt: now.toISOString(),
          heartbeatAt: now.toISOString(),
          leaseExpiresAt: new Date(now.getTime() + args.leaseDurationMs).toISOString(),
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
        };

        const result = await claimStore.claimOrRenew(claim);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                claimId: result.claimId,
                targetRef: result.targetRef,
                status: result.status,
                agentId: result.agent.agentId,
                intentSummary: result.intentSummary,
                leaseExpiresAt: result.leaseExpiresAt,
              }),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // --- grove_release ------------------------------------------------------
  server.registerTool(
    "grove_release",
    {
      description:
        "Release or complete an active claim. Use 'release' when giving up on the work, " +
        "or 'complete' when the work is finished.",
      inputSchema: releaseInputSchema,
    },
    async (args) => {
      try {
        const { claimStore } = deps;

        // Verify claim exists
        const existing = await claimStore.getClaim(args.claimId);
        if (existing === undefined) {
          return notFoundError("Claim", args.claimId);
        }

        let result: Claim;
        if (args.action === "release") {
          result = await claimStore.release(args.claimId);
        } else {
          result = await claimStore.complete(args.claimId);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                claimId: result.claimId,
                targetRef: result.targetRef,
                status: result.status,
                action: args.action,
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

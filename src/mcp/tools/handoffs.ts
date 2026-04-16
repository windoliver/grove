/**
 * MCP tools for querying and interacting with handoff coordination records.
 *
 * grove_list_handoffs — List handoffs, optionally filtered by role or status.
 * grove_get_handoff   — Get a single handoff by ID.
 * grove_ack_handoff   — Signal that the target agent has seen or acknowledged a handoff.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HandoffStatus, type HandoffStore } from "../../core/handoff.js";
import type { McpDeps } from "../deps.js";
import { toolError } from "../error-handler.js";

/**
 * Guard: require handoffStore to be configured.
 * Returns the store if available, or a NOT_CONFIGURED error result.
 */
function requireHandoffStore(
  deps: McpDeps,
): { ok: true; store: HandoffStore } | { ok: false; error: CallToolResult } {
  if (deps.handoffStore !== undefined) {
    return { ok: true, store: deps.handoffStore };
  }
  return {
    ok: false,
    error: toolError(
      "NOT_CONFIGURED",
      "Handoff store is not available. Topology routing must be active.",
    ),
  };
}

const listHandoffsInputSchema = z.object({
  toRole: z
    .string()
    .optional()
    .describe("Filter by target role (e.g. 'reviewer'). Omit to list all."),
  fromRole: z
    .string()
    .optional()
    .describe("Filter by originating role (e.g. 'coder'). Omit to list all."),
  status: z
    .enum([
      HandoffStatus.PendingPickup,
      HandoffStatus.Delivered,
      HandoffStatus.Replied,
      HandoffStatus.Expired,
    ])
    .optional()
    .describe(
      "Filter by status. Omit to return all statuses. Call this with status='pending_pickup' to find work waiting for your role.",
    ),
  sourceCid: z
    .string()
    .optional()
    .describe(
      "Filter by the source contribution CID. Useful for checking if a contribution was routed.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Maximum number of handoffs to return. Defaults to 50."),
});

const getHandoffInputSchema = z.object({
  handoffId: z.string().min(1).describe("ID of the handoff to retrieve."),
});

const ackHandoffInputSchema = z.object({
  handoffId: z.string().min(1).describe("ID of the handoff to acknowledge."),
  level: z
    .enum(["seen", "acked"])
    .describe(
      "Receipt level: 'seen' = agent observed the handoff; 'acked' = agent acknowledges and intends to act on it. 'acked' auto-fills 'seen' if not already set.",
    ),
});

/**
 * Register handoff tools. `includeAckTool` gates the receipt mutation tool
 * (grove_ack_handoff), which is unsafe on shared transports because it
 * authorizes on a process-global role. Defaults to true for backwards
 * compatibility with stdio callers.
 */
export function registerHandoffTools(
  server: McpServer,
  deps: McpDeps,
  opts?: { readonly includeAckTool?: boolean },
): void {
  const includeAck = opts?.includeAckTool !== false;
  server.registerTool(
    "grove_list_handoffs",
    {
      description:
        "List topology routing handoffs. Use this to discover work that has been routed to your role (status=pending_pickup), or to check what you have routed to downstream roles. Call expireStale implicitly (fresh status is always returned).",
      inputSchema: listHandoffsInputSchema,
    },
    async (args) => {
      const guard = requireHandoffStore(deps);
      if (!guard.ok) return guard.error;
      const { store } = guard;

      // Expire stale handoffs before listing so callers always see fresh status.
      await store.expireStale();

      const handoffs = await store.list({
        toRole: args.toRole,
        fromRole: args.fromRole,
        status: args.status,
        sourceCid: args.sourceCid,
        limit: args.limit ?? 50,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ handoffs }) }],
      };
    },
  );

  server.registerTool(
    "grove_get_handoff",
    {
      description: "Get a single handoff coordination record by its ID.",
      inputSchema: getHandoffInputSchema,
    },
    async (args) => {
      const guard = requireHandoffStore(deps);
      if (!guard.ok) return guard.error;
      const { store } = guard;

      const handoff = await store.get(args.handoffId);
      if (handoff === undefined) {
        return toolError("NOT_FOUND", `Handoff '${args.handoffId}' not found.`);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(handoff) }],
      };
    },
  );

  if (!includeAck) return;

  // grove_ack_handoff requires a session-scoped backend. Without the
  // isInCurrentSession capability, we cannot reliably tell whether a
  // caller owns the handoff they're acking (SQLite today shares the
  // handoffs table across sessions — a reviewer in session A could ack
  // session B's handoffs). Register the tool only when the active store
  // can answer the ownership question.
  if (deps.handoffStore?.isInCurrentSession === undefined) return;

  server.registerTool(
    "grove_ack_handoff",
    {
      description:
        "Signal that you have seen or acknowledged a handoff. Use level='seen' when you first observe a handoff routed to your role, and level='acked' when you intend to act on it. Acknowledging auto-fills 'seen' if not already set. Idempotent — safe to call multiple times.",
      inputSchema: ackHandoffInputSchema,
    },
    async (args) => {
      const guard = requireHandoffStore(deps);
      if (!guard.ok) return guard.error;
      const { store } = guard;

      const handoff = await store.get(args.handoffId);
      if (handoff === undefined) {
        return toolError("NOT_FOUND", `Handoff '${args.handoffId}' not found.`);
      }

      // Authorization: the caller role must match the handoff's toRole,
      // AND the handoff must belong to the caller's current session.
      // Without the session check on a non-scoped store (e.g. SQLite where
      // the handoff table is shared across sessions), a reviewer in session
      // A could enumerate and ack a reviewer handoff in session B.
      const callerRole = process.env.GROVE_AGENT_ROLE;
      if (callerRole === undefined || callerRole !== handoff.toRole) {
        return toolError(
          "PERMISSION_DENIED",
          `Only the target role '${handoff.toRole}' can acknowledge this handoff (caller role: '${callerRole ?? "unset"}').`,
        );
      }
      // Session ownership check via direct O(1) API. Registration guards
      // above guarantee isInCurrentSession is defined, so a missing method
      // is a programming error not a runtime fallback path.
      if (store.isInCurrentSession === undefined) {
        return toolError(
          "NOT_SUPPORTED",
          "Handoff store does not support session-scoped access.",
        );
      }
      const inSession = await store.isInCurrentSession(args.handoffId);
      if (!inSession) {
        return toolError(
          "PERMISSION_DENIED",
          `Handoff '${args.handoffId}' does not belong to the current session.`,
        );
      }

      if (args.level === "seen") {
        await store.markSeen(args.handoffId);
      } else {
        await store.markAcked(args.handoffId);
      }

      if (process.env.GROVE_DEBUG === "1") {
        process.stderr.write(
          `[grove:handoff] ACK handoff=${args.handoffId.slice(0, 8)} level=${args.level} toRole=${handoff.toRole}\n`,
        );
      }

      const updated = await store.get(args.handoffId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(updated) }],
      };
    },
  );
}

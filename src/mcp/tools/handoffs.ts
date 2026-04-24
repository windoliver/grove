/**
 * MCP tools for querying and interacting with handoff coordination records.
 *
 * grove_list_handoffs     — List handoffs, optionally filtered by role or status.
 * grove_get_handoff       — Get a single handoff by ID.
 * grove_list_dead_letters — List handoffs that failed IPC delivery (DLQ).
 * grove_process_handoff   — Mark a delivered handoff as processed (agent ack'd receipt).
 * grove_ack_handoff       — Record a seen/acked receipt timestamp on a handoff.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { canTransition, HandoffStatus, type HandoffStore } from "../../core/handoff.js";
import type { McpDeps } from "../deps.js";
import { handleToolError, toolError } from "../error-handler.js";

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

const INLINE_EXPIRE_INTERVAL_MS = 1_000;
const lastInlineExpiryAt = new WeakMap<HandoffStore, number>();
const pendingInlineExpiry = new WeakMap<HandoffStore, Promise<void>>();

async function maybeExpireBeforeList(store: HandoffStore, deps: McpDeps): Promise<void> {
  if (deps.handoffExpiryManaged === true) {
    return;
  }
  const pendingSweep = pendingInlineExpiry.get(store);
  if (pendingSweep !== undefined) {
    await pendingSweep;
    return;
  }
  const now = Date.now();
  const lastSweepAt = lastInlineExpiryAt.get(store) ?? 0;
  if (now - lastSweepAt < INLINE_EXPIRE_INTERVAL_MS) {
    return;
  }
  const sweep: Promise<void> = store
    .expireStale()
    .then(() => undefined)
    .finally(() => {
      lastInlineExpiryAt.set(store, Date.now());
      if (pendingInlineExpiry.get(store) === sweep) {
        pendingInlineExpiry.delete(store);
      }
    });
  pendingInlineExpiry.set(store, sweep);
  await sweep;
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
      HandoffStatus.Processed,
      HandoffStatus.Replied,
      HandoffStatus.Expired,
      HandoffStatus.DeadLettered,
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

const processHandoffInputSchema = z.object({
  handoffId: z.string().min(1).describe("ID of the handoff to mark as processed."),
});

const listDeadLettersInputSchema = z.object({
  toRole: z
    .string()
    .optional()
    .describe("Filter dead-lettered handoffs by target role. Omit to list all."),
  fromRole: z
    .string()
    .optional()
    .describe("Filter dead-lettered handoffs by originating role. Omit to list all."),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Maximum number of dead-lettered handoffs to return. Defaults to 50."),
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
        "List topology routing handoffs with IPC delivery state. Use this to discover work routed to your role (status=pending_pickup), check what you have routed downstream, or monitor delivery status (delivered, processed, dead_lettered). Stale handoffs are expired automatically before listing.",
      inputSchema: listHandoffsInputSchema,
    },
    async (args) => {
      const guard = requireHandoffStore(deps);
      if (!guard.ok) return guard.error;
      const { store } = guard;

      try {
        // When a proactive DeadlineWatcher is running it keeps statuses fresh
        // already. Otherwise, inline expiry is throttled so polling agents do
        // not turn every read into a write-heavy store sweep.
        await maybeExpireBeforeList(store, deps);

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
      } catch (err) {
        return handleToolError(err);
      }
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

      try {
        const handoff = await store.get(args.handoffId);
        if (handoff === undefined) {
          return toolError("NOT_FOUND", `Handoff '${args.handoffId}' not found.`);
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(handoff) }],
        };
      } catch (err) {
        return handleToolError(err);
      }
    },
  );

  server.registerTool(
    "grove_list_dead_letters",
    {
      description:
        "List handoffs that failed IPC delivery after retries (dead letter queue). " +
        "These represent routing failures that may require operator attention — " +
        "the source contribution was committed but the target agent was never notified. " +
        "Use this to diagnose delivery gaps in topology-driven routing.",
      inputSchema: listDeadLettersInputSchema,
    },
    async (args) => {
      const guard = requireHandoffStore(deps);
      if (!guard.ok) return guard.error;
      const { store } = guard;

      try {
        const handoffs = await store.list({
          toRole: args.toRole,
          fromRole: args.fromRole,
          status: HandoffStatus.DeadLettered,
          limit: args.limit ?? 50,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ count: handoffs.length, handoffs }),
            },
          ],
        };
      } catch (err) {
        return handleToolError(err);
      }
    },
  );

  // grove_process_handoff and grove_ack_handoff both mutate per-session
  // receipt state, so they share the same safety gates:
  //   - includeAckTool=false disables them on the shared HTTP transport
  //     (one process role is shared across clients there).
  //   - A session-scoped backend (isInCurrentSession present) is required
  //     so cross-session IDs can be rejected.
  if (!includeAck) return;
  if (deps.handoffStore?.isInCurrentSession === undefined) return;

  server.registerTool(
    "grove_process_handoff",
    {
      description:
        "Mark a handoff as processed. Transitions a delivered handoff to processed, signaling " +
        "to the orchestrator that your agent received it and is actively working on it. Use this " +
        "when you begin work on a handoff; use grove_submit_* tools when you finish.",
      inputSchema: processHandoffInputSchema,
    },
    async (args) => {
      const guard = requireHandoffStore(deps);
      if (!guard.ok) return guard.error;
      const { store } = guard;

      try {
        const handoff = await store.get(args.handoffId);
        if (handoff === undefined) {
          return toolError("NOT_FOUND", `Handoff '${args.handoffId}' not found.`);
        }

        // Authorization: only the target role can mark processed. Handoff IDs
        // are discoverable via read tools, so without this check any agent in
        // the session could forge "processed" signals for peer handoffs.
        //
        // Session ownership is enforced by the scoped store itself: these tools
        // are only registered when `isInCurrentSession` exists, which means the
        // backend's get()/mark*() path is already bound to the current session.
        const callerRole = process.env.GROVE_AGENT_ROLE;
        if (callerRole === undefined || callerRole !== handoff.toRole) {
          return toolError(
            "PERMISSION_DENIED",
            `Only the target role '${handoff.toRole}' can mark this handoff processed (caller role: '${callerRole ?? "unset"}').`,
          );
        }

        if (!canTransition(handoff.status, HandoffStatus.Processed)) {
          return toolError(
            "INVALID_STATE",
            `Cannot process handoff in status '${handoff.status}'. ` +
              `Only 'delivered' handoffs can be processed.`,
          );
        }

        await store.markProcessed(args.handoffId);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                handoffId: args.handoffId,
                previousStatus: handoff.status,
                status: HandoffStatus.Processed,
              }),
            },
          ],
        };
      } catch (err) {
        return handleToolError(err);
      }
    },
  );

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

      try {
        const handoff = await store.get(args.handoffId);
        if (handoff === undefined) {
          return toolError("NOT_FOUND", `Handoff '${args.handoffId}' not found.`);
        }

        // Authorization: the caller role must match the handoff's toRole.
        // Session ownership is enforced by the scoped store itself: these tools
        // are only registered when `isInCurrentSession` exists, which means the
        // backend's get()/mark*() path is already bound to the current session.
        const callerRole = process.env.GROVE_AGENT_ROLE;
        if (callerRole === undefined || callerRole !== handoff.toRole) {
          return toolError(
            "PERMISSION_DENIED",
            `Only the target role '${handoff.toRole}' can acknowledge this handoff (caller role: '${callerRole ?? "unset"}').`,
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
      } catch (err) {
        return handleToolError(err);
      }
    },
  );
}

/**
 * Handoff endpoints.
 *
 * GET  /api/handoffs              — List handoffs (filtered by role, status, etc.)
 * GET  /api/handoffs/:id          — Get a single handoff by ID
 * POST /api/handoffs/:id/delivered — Mark a handoff delivered (IPC transport ack)
 *
 * Other state mutations (replied / seen / acked / processed) are deliberately
 * NOT exposed here — they are role-sensitive and the HTTP surface is
 * unauthenticated. See comments below for rationale.
 */

import { zValidator } from "@hono/zod-validator";
import type { Context, Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { HandoffStore } from "../../core/handoff.js";
import { HandoffStatus as HandoffStatusValue } from "../../core/handoff.js";
import type { ServerEnv } from "../deps.js";

const handoffs: HonoType<ServerEnv> = new Hono<ServerEnv>();

const listQuerySchema = z.object({
  toRole: z.string().optional(),
  fromRole: z.string().optional(),
  status: z
    .enum([
      HandoffStatusValue.PendingPickup,
      HandoffStatusValue.Delivered,
      HandoffStatusValue.Processed,
      HandoffStatusValue.Replied,
      HandoffStatusValue.Expired,
      HandoffStatusValue.DeadLettered,
    ])
    .optional(),
  sourceCid: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sessionId: z.string().optional(),
});

/**
 * Middleware: require handoffStore to be configured.
 * Returns 501 if not available, otherwise passes through.
 */
handoffs.use("/*", async (c, next) => {
  const { handoffStore } = c.get("deps");
  if (handoffStore === undefined) {
    return c.json(
      { error: { code: "NOT_CONFIGURED", message: "Handoff store not available" } },
      501,
    );
  }
  await next();
});

/**
 * Resolve the right handoff store for this request. When `?sessionId=X` is
 * present and the deps expose a session-scoped factory, build a scoped
 * store. Otherwise fall back to the process-global store.
 *
 * Callers that care about session isolation (remote TUI reads) should
 * always pass ?sessionId=.
 *
 * NOTE: `sessionId` is caller-asserted scope, not caller-authenticated
 * identity. The HTTP surface is documented as unauthenticated and the
 * deployment trust boundary is localhost-binding (see serve.ts warning
 * for non-localhost binds). Role-sensitive mutations are NOT exposed on
 * this surface — they flow through MCP stdio with GROVE_AGENT_ROLE +
 * session-scoped store guards. The scoping here is a correctness filter
 * that keeps a well-behaved remote TUI from seeing peer sessions'
 * handoffs; it is NOT a security boundary against a hostile client.
 */
function resolveStore(c: Context<ServerEnv>): HandoffStore | undefined {
  const { handoffStore, handoffStoreForSession } = c.get("deps");
  const sessionId = c.req.query("sessionId");
  if (sessionId && handoffStoreForSession) {
    return handoffStoreForSession(sessionId) ?? handoffStore;
  }
  return handoffStore;
}

/** GET /api/handoffs — List handoffs with optional filters. */
handoffs.get("/", zValidator("query", listQuerySchema), async (c) => {
  const store = resolveStore(c);
  if (store === undefined) return c.json({ error: "unreachable" }, 500);

  // Expire stale handoffs before listing so callers always see fresh status.
  await store.expireStale();

  const { toRole, fromRole, status, sourceCid, limit } = c.req.valid("query");

  const results = await store.list({
    ...(toRole !== undefined ? { toRole } : {}),
    ...(fromRole !== undefined ? { fromRole } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(sourceCid !== undefined ? { sourceCid } : {}),
    limit,
  });

  return c.json({ handoffs: results });
});

/** GET /api/handoffs/:id — Get a single handoff. */
handoffs.get("/:id", async (c) => {
  const store = resolveStore(c);
  if (store === undefined) return c.json({ error: "unreachable" }, 500);

  const id = c.req.param("id");
  if (id === undefined) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Missing handoff id" } }, 400);
  }
  const handoff = await store.get(id);
  if (handoff === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }

  return c.json(handoff);
});

/**
 * POST /api/handoffs/:id/delivered — Transition pending_pickup → delivered.
 *
 * This is a transport-layer IPC acknowledgement, not a role-sensitive
 * action. It's safe on the unauthenticated HTTP surface because:
 *   - delivered means "IPC successfully routed the message to the agent's
 *     inbox," which is observable infrastructure state, not a claim about
 *     what a role did with the message.
 *   - The target role hasn't processed or replied — those transitions are
 *     still gated by the MCP tools (grove_process_handoff, contribute
 *     operations) with role+session authorization.
 *   - The remote TUI (RemoteDataProvider.markHandoffDelivered) calls this
 *     endpoint when SpawnManager detects a new contribution arriving at
 *     a target agent, so removing it would strand handoffs in
 *     pending_pickup and block grove_process_handoff on the target role.
 *
 * Role-sensitive mutations (replied, seen, acked, processed) are NOT
 * exposed here. They flow through MCP tools with GROVE_AGENT_ROLE +
 * session-scoped store guards.
 */
handoffs.post("/:id/delivered", async (c) => {
  const store = resolveStore(c);
  if (store === undefined) return c.json({ error: "unreachable" }, 500);

  const id = c.req.param("id");
  if (id === undefined) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Missing handoff id" } }, 400);
  }

  await store.markDelivered(id);
  const updated = await store.get(id);
  if (updated === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }
  return c.json(updated);
});

export { handoffs };

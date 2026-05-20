/**
 * Handoff endpoints.
 *
 * GET  /api/handoffs              — List handoffs (filtered by role, status, etc.)
 * GET  /api/handoffs/:id          — Get a single handoff by ID
 * POST /api/handoffs/:id/delivered — Mark a handoff delivered (IPC transport ack)
 * POST /api/handoffs/:id/cancel — Mark a handoff cancelled by operator action
 * POST /api/handoffs/:id/manual-resolve — Mark a handoff manually resolved
 * POST /api/handoffs/:id/resend — Create a retry handoff and cancel the original
 * POST /api/handoffs/:id/reroute — Create a replacement handoff for another role
 *
 * Role-sensitive state mutations (replied / seen / acked / processed) are
 * deliberately NOT exposed here — they flow through MCP tools with role and
 * session guards. See comments below for rationale.
 */

import { zValidator } from "@hono/zod-validator";
import type { Context, Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { Handoff, HandoffStore } from "../../core/handoff.js";
import { HANDOFF_STATUS_VALUES } from "../../core/handoff.js";
import type { ServerEnv } from "../deps.js";

const handoffs: HonoType<ServerEnv> = new Hono<ServerEnv>();

const listQuerySchema = z.object({
  toRole: z.string().optional(),
  fromRole: z.string().optional(),
  status: z.enum(HANDOFF_STATUS_VALUES).optional(),
  sourceCid: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sessionId: z.string().optional(),
});

const terminalActionSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

const replacementActionSchema = terminalActionSchema.extend({
  replyDueAt: z.string().datetime().optional(),
});

const rerouteActionSchema = replacementActionSchema.extend({
  toRole: z.string().min(1),
});

const invalidJsonBodySchema = z.custom(() => false, { message: "Invalid JSON body" });

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

async function parseOptionalJson(c: Context<ServerEnv>): Promise<unknown> {
  const body = await c.req.text();
  if (body.trim() === "") {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch {
    invalidJsonBodySchema.parse(body);
    return {};
  }
}

function replacementDueAt(original: Handoff, next?: string): string | undefined {
  if (next !== undefined) return next;
  if (original.replyDueAt !== undefined && Date.parse(original.replyDueAt) > Date.now()) {
    return original.replyDueAt;
  }
  return undefined;
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

/** POST /api/handoffs/:id/cancel — Mark unresolved handoff cancelled by operator action. */
handoffs.post("/:id/cancel", async (c) => {
  const store = resolveStore(c);
  if (store === undefined) return c.json({ error: "unreachable" }, 500);

  const id = c.req.param("id");
  if (id === undefined) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Missing handoff id" } }, 400);
  }

  const action = terminalActionSchema.parse(await parseOptionalJson(c));
  await store.markCancelled(id, { terminalReason: action.reason ?? "operator cancelled" });
  const updated = await store.get(id);
  if (updated === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }
  return c.json(updated);
});

/** POST /api/handoffs/:id/manual-resolve — Mark eligible handoff manually resolved. */
handoffs.post("/:id/manual-resolve", async (c) => {
  const store = resolveStore(c);
  if (store === undefined) return c.json({ error: "unreachable" }, 500);

  const id = c.req.param("id");
  if (id === undefined) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Missing handoff id" } }, 400);
  }

  const action = terminalActionSchema.parse(await parseOptionalJson(c));
  await store.markManuallyResolved(id, { terminalReason: action.reason ?? "operator resolved" });
  const updated = await store.get(id);
  if (updated === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }
  return c.json(updated);
});

/** POST /api/handoffs/:id/resend — Create retry handoff and cancel the original. */
handoffs.post("/:id/resend", async (c) => {
  const store = resolveStore(c);
  if (store === undefined) return c.json({ error: "unreachable" }, 500);

  const id = c.req.param("id");
  if (id === undefined) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Missing handoff id" } }, 400);
  }

  const action = replacementActionSchema.parse(await parseOptionalJson(c));
  const original = await store.get(id);
  if (original === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }

  const replyDueAt = replacementDueAt(original, action.replyDueAt);
  const replacementHandoffId = crypto.randomUUID();
  await store.markCancelled(id, {
    terminalReason: action.reason ?? "resent",
    replacementHandoffId,
  });
  const updatedOriginal = await store.get(id);
  if (updatedOriginal === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }
  const replacement = await store.create({
    handoffId: replacementHandoffId,
    sourceCid: original.sourceCid,
    fromRole: original.fromRole,
    toRole: original.toRole,
    requiresReply: original.requiresReply,
    ...(replyDueAt !== undefined ? { replyDueAt } : {}),
  });
  return c.json({ original: updatedOriginal, replacement });
});

/** POST /api/handoffs/:id/reroute — Create replacement handoff for selected role. */
handoffs.post("/:id/reroute", async (c) => {
  const store = resolveStore(c);
  if (store === undefined) return c.json({ error: "unreachable" }, 500);

  const id = c.req.param("id");
  if (id === undefined) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Missing handoff id" } }, 400);
  }

  const action = rerouteActionSchema.parse(await parseOptionalJson(c));
  const original = await store.get(id);
  if (original === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }

  const replyDueAt = replacementDueAt(original, action.replyDueAt);
  const replacementHandoffId = crypto.randomUUID();
  await store.markCancelled(id, {
    terminalReason: action.reason ?? `rerouted to ${action.toRole}`,
    replacementHandoffId,
  });
  const updatedOriginal = await store.get(id);
  if (updatedOriginal === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }
  const replacement = await store.create({
    handoffId: replacementHandoffId,
    sourceCid: original.sourceCid,
    fromRole: original.fromRole,
    toRole: action.toRole,
    requiresReply: original.requiresReply,
    ...(replyDueAt !== undefined ? { replyDueAt } : {}),
  });
  return c.json({ original: updatedOriginal, replacement });
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
 * Role-sensitive mutations (replied, seen, acked, processed) stay out of
 * this HTTP surface. Operator terminal/retry actions above do not claim
 * target-role processing; they only stop or replace stalled delivery work.
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

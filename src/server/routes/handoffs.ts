/**
 * Handoff endpoints.
 *
 * GET  /api/handoffs             — List handoffs (filtered by role, status, etc.)
 * GET  /api/handoffs/:id         — Get a single handoff by ID
 * POST /api/handoffs/:id/delivered — Mark a handoff as delivered
 * POST /api/handoffs/:id/replied   — Mark a handoff as replied
 *
 * Note: receipt mutations (seen/acked) are deliberately not exposed here.
 * See the comment below `handoffs.post("/:id/replied")` for rationale.
 */

import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import type { HandoffStatus } from "../../core/handoff.js";
import type { ServerEnv } from "../deps.js";

const handoffs: HonoType<ServerEnv> = new Hono<ServerEnv>();

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

/** GET /api/handoffs — List handoffs with optional filters. */
handoffs.get("/", async (c) => {
  const { handoffStore } = c.get("deps");
  // handoffStore is guaranteed by middleware, but TypeScript needs the check
  if (handoffStore === undefined) return c.json({ error: "unreachable" }, 500);

  // Expire stale handoffs before listing so callers always see fresh status.
  await handoffStore.expireStale();

  const toRole = c.req.query("toRole");
  const fromRole = c.req.query("fromRole");
  const status = c.req.query("status") as HandoffStatus | undefined;
  const sourceCid = c.req.query("sourceCid");
  const limitRaw = c.req.query("limit");
  const limit = limitRaw !== undefined ? Math.min(parseInt(limitRaw, 10) || 50, 200) : 50;

  const results = await handoffStore.list({
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
  const { handoffStore } = c.get("deps");
  if (handoffStore === undefined) return c.json({ error: "unreachable" }, 500);

  const handoff = await handoffStore.get(c.req.param("id"));
  if (handoff === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }

  return c.json(handoff);
});

/** POST /api/handoffs/:id/delivered — Transition handoff to delivered. */
handoffs.post("/:id/delivered", async (c) => {
  const { handoffStore } = c.get("deps");
  if (handoffStore === undefined) return c.json({ error: "unreachable" }, 500);

  try {
    await handoffStore.markDelivered(c.req.param("id"));
    const updated = await handoffStore.get(c.req.param("id"));
    return c.json(updated);
  } catch {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }
});

/** POST /api/handoffs/:id/replied — Transition handoff to replied. */
handoffs.post("/:id/replied", async (c) => {
  const { handoffStore } = c.get("deps");
  if (handoffStore === undefined) return c.json({ error: "unreachable" }, 500);

  let body: { resolvedByCid: string };
  try {
    body = await c.req.json<{ resolvedByCid: string }>();
  } catch {
    return c.json(
      { error: { code: "BAD_REQUEST", message: "Body must be JSON with resolvedByCid" } },
      400,
    );
  }

  if (!body.resolvedByCid) {
    return c.json({ error: { code: "BAD_REQUEST", message: "resolvedByCid is required" } }, 400);
  }

  try {
    await handoffStore.markReplied(c.req.param("id"), body.resolvedByCid);
    const updated = await handoffStore.get(c.req.param("id"));
    return c.json(updated);
  } catch {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }
});

// Intentionally no HTTP routes for seen/acked mutations. The grove-server
// HTTP surface is not authenticated — any client that can reach it can
// claim any role. Because receipt mutations must be bound to the actual
// target role to be trustworthy, they are exposed ONLY through the MCP
// tool grove_ack_handoff, where GROVE_AGENT_ROLE is set by the spawning
// process (TUI/runtime) and not controllable by the tool caller.

export { handoffs };

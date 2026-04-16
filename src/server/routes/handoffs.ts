/**
 * Handoff endpoints (read-only).
 *
 * GET /api/handoffs       — List handoffs (filtered by role, status, etc.)
 * GET /api/handoffs/:id   — Get a single handoff by ID
 *
 * All state mutations (delivered / replied / seen / acked) are deliberately
 * NOT exposed here — see the comment below for rationale.
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

// Intentionally no HTTP routes for handoff mutations (delivered / replied /
// seen / acked). The grove-server HTTP surface is unauthenticated — any
// client that can reach it can claim any role. Exposing these routes would
// let a caller mark another role's handoff replied and suppress SLA/overdue
// handling. The authoritative mutation paths are:
//   - delivered: driven by IPC routing inside the agent runtime
//   - replied:   driven by contributeOperation when a role submits a
//                reviews/responds_to/adopts contribution (requires agent.role)
//   - seen/acked: only via MCP grove_ack_handoff on stdio transport
//                 (per-agent GROVE_AGENT_ROLE binding is enforced there)

export { handoffs };

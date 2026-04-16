/**
 * Handoff endpoints.
 *
 * GET  /api/handoffs             — List handoffs (filtered by role, status, etc.)
 * GET  /api/handoffs/:id         — Get a single handoff by ID
 * POST /api/handoffs/:id/delivered — Mark a handoff as delivered
 * POST /api/handoffs/:id/replied   — Mark a handoff as replied
 * POST /api/handoffs/:id/seen      — Mark a handoff as seen
 * POST /api/handoffs/:id/acked     — Mark a handoff as acknowledged
 */

import type { Context, Hono as HonoType } from "hono";
import { Hono } from "hono";
import type { Handoff, HandoffStatus, HandoffStore } from "../../core/handoff.js";
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

/**
 * Verify the caller role matches the handoff's toRole before mutating
 * receipt state. Reads the role from the X-Grove-Role header or a JSON
 * body field. Returns an error Response if unauthorized; otherwise returns
 * the handoff for the route handler to use.
 */
async function authorizeReceiptMutation(
  c: Context<ServerEnv>,
  handoffStore: HandoffStore,
): Promise<{ ok: true; handoff: Handoff } | { ok: false; response: Response }> {
  const id = c.req.param("id");
  if (id === undefined) {
    return {
      ok: false,
      response: c.json({ error: { code: "BAD_REQUEST", message: "Missing handoff id" } }, 400),
    };
  }
  const handoff = await handoffStore.get(id);
  if (handoff === undefined) {
    return {
      ok: false,
      response: c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404),
    };
  }
  const headerRole = c.req.header("x-grove-role");
  let bodyRole: string | undefined;
  try {
    const body = (await c.req.json<{ role?: string }>().catch(() => undefined)) as
      | { role?: string }
      | undefined;
    bodyRole = body?.role;
  } catch {
    // ignore
  }
  const callerRole = headerRole ?? bodyRole;
  if (callerRole === undefined || callerRole !== handoff.toRole) {
    return {
      ok: false,
      response: c.json(
        {
          error: {
            code: "PERMISSION_DENIED",
            message: `Only the target role '${handoff.toRole}' can acknowledge this handoff (caller role: '${callerRole ?? "unset"}'). Set X-Grove-Role header or include {"role": "..."} in the body.`,
          },
        },
        403,
      ),
    };
  }
  return { ok: true, handoff };
}

/** POST /api/handoffs/:id/seen — Record that the target agent has seen this handoff. */
handoffs.post("/:id/seen", async (c) => {
  const { handoffStore } = c.get("deps");
  if (handoffStore === undefined) return c.json({ error: "unreachable" }, 500);

  const authz = await authorizeReceiptMutation(c, handoffStore);
  if (!authz.ok) return authz.response;

  try {
    await handoffStore.markSeen(c.req.param("id"));
    const updated = await handoffStore.get(c.req.param("id"));
    return c.json(updated);
  } catch {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }
});

/** POST /api/handoffs/:id/acked — Record that the target agent acknowledges this handoff. */
handoffs.post("/:id/acked", async (c) => {
  const { handoffStore } = c.get("deps");
  if (handoffStore === undefined) return c.json({ error: "unreachable" }, 500);

  const authz = await authorizeReceiptMutation(c, handoffStore);
  if (!authz.ok) return authz.response;

  try {
    await handoffStore.markAcked(c.req.param("id"));
    const updated = await handoffStore.get(c.req.param("id"));
    return c.json(updated);
  } catch {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }
});

export { handoffs };

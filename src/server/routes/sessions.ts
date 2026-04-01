/**
 * Session endpoints.
 *
 * POST /api/sessions           — Create a new session.
 * GET  /api/sessions           — List sessions with optional status filter.
 * GET  /api/sessions/:id       — Get a single session by ID.
 * PUT  /api/sessions/:id/archive — Archive a session.
 * POST /api/sessions/:id/contributions — Record a contribution against a session.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { GroveContract } from "../../core/contract.js";
import type { ServerEnv } from "../deps.js";
import { notConfigured } from "./shared.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createSessionSchema = z.object({
  goal: z.string().min(1).optional(),
  presetName: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const addContributionSchema = z.object({
  cid: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const sessions: Hono<ServerEnv> = new Hono<ServerEnv>();

/** POST /api/sessions — Create a new session. */
sessions.post("/", async (c) => {
  const { goalSessionStore } = c.get("deps");
  if (!goalSessionStore) return notConfigured(c, "Goal/session store is not configured");

  const body = await c.req.json();
  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", details: parsed.error.issues } }, 400);
  }

  // Build input with only defined fields (exactOptionalPropertyTypes).
  // Cast the loose JSON record to GroveContract — full contract validation
  // happens at the contract layer, not at the API boundary.
  const input: import("../../tui/provider.js").SessionInput = {
    ...(parsed.data.goal !== undefined ? { goal: parsed.data.goal } : {}),
    ...(parsed.data.presetName !== undefined ? { presetName: parsed.data.presetName } : {}),
    ...(parsed.data.config !== undefined
      ? { config: parsed.data.config as unknown as GroveContract }
      : {}),
  };
  const session = await goalSessionStore.createSession(input);
  return c.json(session, 201);
});

/** GET /api/sessions — List sessions with optional status filter. */
sessions.get("/", async (c) => {
  const { goalSessionStore } = c.get("deps");
  if (!goalSessionStore) return notConfigured(c, "Goal/session store is not configured");

  const status = c.req.query("status");
  const query =
    status === "active" || status === "archived"
      ? { status: status as "active" | "archived" }
      : undefined;

  const results = await goalSessionStore.listSessions(query);
  return c.json({ sessions: results });
});

/** GET /api/sessions/:id — Get a single session. */
sessions.get("/:id", async (c) => {
  const { goalSessionStore } = c.get("deps");
  if (!goalSessionStore) return notConfigured(c, "Goal/session store is not configured");

  const sessionId = c.req.param("id");
  const session = await goalSessionStore.getSession(sessionId);
  if (!session) {
    return c.json(
      { error: { code: "NOT_FOUND", message: `Session not found: ${sessionId}` } },
      404,
    );
  }
  return c.json(session);
});

/** PUT /api/sessions/:id/archive — Archive a session. */
sessions.put("/:id/archive", async (c) => {
  const { goalSessionStore } = c.get("deps");
  if (!goalSessionStore) return notConfigured(c, "Goal/session store is not configured");

  const sessionId = c.req.param("id");

  // Verify session exists before archiving
  const session = await goalSessionStore.getSession(sessionId);
  if (!session) {
    return c.json(
      { error: { code: "NOT_FOUND", message: `Session not found: ${sessionId}` } },
      404,
    );
  }

  await goalSessionStore.archiveSession(sessionId);
  return c.body(null, 204);
});

/** POST /api/sessions/:id/contributions — Record a contribution against a session. */
sessions.post("/:id/contributions", async (c) => {
  const { goalSessionStore } = c.get("deps");
  if (!goalSessionStore) return notConfigured(c, "Goal/session store is not configured");

  const sessionId = c.req.param("id");

  // Verify session exists
  const session = await goalSessionStore.getSession(sessionId);
  if (!session) {
    return c.json(
      { error: { code: "NOT_FOUND", message: `Session not found: ${sessionId}` } },
      404,
    );
  }

  const body = await c.req.json();
  const parsed = addContributionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", details: parsed.error.issues } }, 400);
  }

  await goalSessionStore.addContributionToSession(sessionId, parsed.data.cid);
  return c.body(null, 204);
});

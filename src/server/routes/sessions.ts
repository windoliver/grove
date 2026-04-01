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
import type { ServerEnv } from "../deps.js";
import { notConfigured } from "./shared.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createSessionSchema = z.object({
  goal: z.string().min(1).optional(),
  presetName: z.string().min(1).optional(),
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

  // Session config always comes from the server's own contract — never from
  // the client. This prevents callers from injecting permissive configs that
  // weaken policy enforcement. The client can specify goal and presetName;
  // the server resolves the authoritative contract snapshot.
  const { contract } = c.get("deps");
  const input: import("../../tui/provider.js").SessionInput = {
    ...(parsed.data.goal !== undefined ? { goal: parsed.data.goal } : {}),
    ...(parsed.data.presetName !== undefined ? { presetName: parsed.data.presetName } : {}),
    ...(contract !== undefined ? { config: contract } : {}),
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

/**
 * POST /api/sessions/:id/contributions — Attach an existing contribution to a session.
 *
 * Note: The preferred path for session-scoped contributions is to include
 * `sessionId` in `POST /api/contributions`, which performs enforcement + attachment
 * atomically. This endpoint is for attaching contributions that were already created
 * (e.g., via CLI with GROVE_SESSION_ID).
 */
sessions.post("/:id/contributions", async (c) => {
  const { goalSessionStore, contributionStore } = c.get("deps");
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

  // Verify contribution exists in the store before attaching.
  // This prevents attaching phantom CIDs that bypass enforcement.
  const contribution = await contributionStore.get(parsed.data.cid);
  if (!contribution) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Contribution not found: ${parsed.data.cid}`,
        },
      },
      404,
    );
  }

  await goalSessionStore.addContributionToSession(sessionId, parsed.data.cid);
  return c.body(null, 204);
});

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
import { lookupPresetTopology } from "../../core/presets.js";
import type { Session } from "../../core/session.js";
import type { AgentTopology } from "../../core/topology.js";
import { AgentTopologySchema, wireToTopology } from "../../core/topology.js";
import { resolveTopology } from "../../core/topology-resolver.js";
import type { ServerEnv } from "../deps.js";
import { notConfigured } from "./shared.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createSessionSchema = z.object({
  goal: z.string().min(1).optional(),
  // Accept both "preset" (external API) and "presetName" (TUI/internal)
  preset: z.string().min(1).optional(),
  presetName: z.string().min(1).optional(),
  // Topology accepted as opaque object — parsed in handler to support
  // both snake_case wire format (external) and camelCase (TUI/internal)
  topology: z.record(z.string(), z.unknown()).optional(),
});

const addContributionSchema = z.object({
  cid: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Response mapper
// ---------------------------------------------------------------------------

/** Map Session to API response (preserve sessionId for API backwards compat). */
function toSessionResponse(session: Session) {
  return {
    sessionId: session.id,
    goal: session.goal,
    presetName: session.presetName,
    status: session.status,
    startedAt: session.createdAt,
    endedAt: session.completedAt,
    contributionCount: session.contributionCount,
    ...(session.topology !== undefined && { topology: session.topology }),
  };
}

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

  // Normalize: accept both "preset" and "presetName"
  const presetName = parsed.data.preset ?? parsed.data.presetName;

  // Parse inline topology — try snake_case wire format first, fall back to camelCase pass-through
  let inlineTopology: AgentTopology | undefined;
  if (parsed.data.topology) {
    const wireResult = AgentTopologySchema.safeParse(parsed.data.topology);
    if (wireResult.success) {
      inlineTopology = wireToTopology(wireResult.data);
    } else {
      // Assume already camelCase (e.g. from TUI createSessionHttp)
      inlineTopology = parsed.data.topology as unknown as AgentTopology;
    }
  }

  // Resolve topology if preset or inline topology provided
  let resolvedTopology: AgentTopology | undefined;
  if (presetName || inlineTopology) {
    const resolution = resolveTopology({ inlineTopology, presetName }, lookupPresetTopology);
    if (!resolution.ok) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: resolution.error } }, 400);
    }
    resolvedTopology = resolution.topology;
  }

  const session = await goalSessionStore.createSession({
    goal: parsed.data.goal,
    presetName,
    topology: resolvedTopology,
  });
  return c.json(toSessionResponse(session), 201);
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
  return c.json({ sessions: results.map(toSessionResponse) });
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
  return c.json(toSessionResponse(session));
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

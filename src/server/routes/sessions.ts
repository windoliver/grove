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
  const { goalSessionStore, contract } = c.get("deps");
  if (!goalSessionStore) return notConfigured(c, "Goal/session store is not configured");
  if (!contract) {
    return c.json(
      { error: { code: "NOT_CONFIGURED", message: "No contract loaded — cannot snapshot session config" } },
      501,
    );
  }

  const body = await c.req.json();
  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", details: parsed.error.issues } }, 400);
  }

  // Normalize: accept both "preset" and "presetName"
  const presetName = parsed.data.preset ?? parsed.data.presetName;

  // Parse inline topology — try snake_case wire format first, then validate as camelCase
  let inlineTopology: AgentTopology | undefined;
  if (parsed.data.topology) {
    const wireResult = AgentTopologySchema.safeParse(parsed.data.topology);
    if (wireResult.success) {
      inlineTopology = wireToTopology(wireResult.data);
    } else {
      // Try camelCase (TUI sends camelCase directly) — validate structure/roles exist
      const t = parsed.data.topology;
      if (
        typeof t.structure === "string" &&
        ["graph", "tree", "flat"].includes(t.structure) &&
        Array.isArray(t.roles) &&
        t.roles.length > 0 &&
        t.roles.every(
          (r: unknown) =>
            typeof r === "object" &&
            r !== null &&
            typeof (r as Record<string, unknown>).name === "string",
        )
      ) {
        inlineTopology = t as unknown as AgentTopology;
      } else {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message:
                "Invalid topology: must have structure (graph|tree|flat) and at least one role with a name",
            },
          },
          400,
        );
      }
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
    config: contract,
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
  const deps = c.get("deps");
  const { goalSessionStore, contributionStore } = deps;
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

  // Verify contribution exists and run policy enforcement when possible
  const contribution = await contributionStore.get(parsed.data.cid);
  if (contribution) {
    // Policy enforcement against session config (only when contribution is available)
    const sessionConfig = await goalSessionStore.getSessionConfig(sessionId);
    if (sessionConfig) {
      const { PolicyEnforcer } = await import("../../core/policy-enforcer.js");
      const enforcer = new PolicyEnforcer(sessionConfig, contributionStore);
      const result = await enforcer.enforce(contribution, false);
      if (result.violations && result.violations.length > 0) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: `Contribution violates session policy: ${result.violations.map((v: { message: string }) => v.message).join(", ")}`,
            },
          },
          400,
        );
      }
    }
  }

  await goalSessionStore.addContributionToSession(sessionId, parsed.data.cid);
  return c.body(null, 204);
});

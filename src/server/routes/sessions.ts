/**
 * Session endpoints.
 *
 * POST /api/sessions           — Create a new session.
 * GET  /api/sessions           — List sessions with optional status filter.
 * GET  /api/sessions/:id/delete-blockers — List blockers preventing deletion.
 * GET  /api/sessions/:id       — Get a single session by ID.
 * GET  /api/sessions/:id/contributions — Full contribution history for a session.
 * DELETE /api/sessions/:id     — Delete a session.
 * PUT  /api/sessions/:id/archive — Archive a session.
 * POST /api/sessions/:id/contributions — Record a contribution against a session.
 */

import { Hono } from "hono";
import { z } from "zod";
import { getPreset, presetToSessionConfig } from "../../cli/presets/index.js";
import type { GroveContract } from "../../core/contract.js";
import type { Contribution } from "../../core/models.js";
import { lookupPresetTopology } from "../../core/presets.js";
import type { Session } from "../../core/session.js";
import type { AgentTopology } from "../../core/topology.js";
import { AgentTopologySchema, wireToTopology } from "../../core/topology.js";
import { resolveTopology } from "../../core/topology-resolver.js";
import type { ServerEnv } from "../deps.js";
import { dangerous, getIfMatch } from "../middleware/dangerous.js";
import { CID_REGEX } from "../schemas.js";
import { contributionStoreForSession, notConfigured, readJsonBody } from "./shared.js";

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
  cid: z.string().regex(CID_REGEX, "CID must be in format blake3:<64-hex-chars>"),
});

// ---------------------------------------------------------------------------
// Response mapper
// ---------------------------------------------------------------------------

/** Map Session to API response (preserve sessionId for API backwards compat). */
function toSessionResponse(session: Session) {
  return {
    sessionId: session.id,
    uid: session.uid,
    goal: session.goal,
    presetName: session.presetName,
    status: session.status,
    startedAt: session.createdAt,
    finalizers: session.finalizers,
    ...(session.deletionTimestamp !== undefined && {
      deletionTimestamp: session.deletionTimestamp,
    }),
    ...(session.deletionAudit !== undefined && { deletionAudit: session.deletionAudit }),
    endedAt: session.completedAt,
    stopReason: session.stopReason,
    stopStatus: session.stopStatus,
    contributionCount: session.contributionCount,
    ...(session.topology !== undefined && { topology: session.topology }),
    // Expose the frozen contract snapshot so clients (e.g. NexusProvider mirroring)
    // and downstream MCP servers can reconstruct the full enforcement contract
    // without hitting the local SQLite store. Without this, serve.ts running in
    // Nexus mode has to fall back to a minimal reconstruction from topology,
    // which loses rate limits / metrics configured in GROVE.md.
    ...(session.config !== undefined && { config: session.config }),
    // C6 (#304): expose persisted resource_version so the TUI's
    // confirmAndMutate flow can mint a DangerousToken with a fresh
    // ifMatch on the first attempt. Omitting this forces every archive
    // through one wasted 409 retry.
    ...(session.resourceVersion !== undefined && { resourceVersion: session.resourceVersion }),
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

  const json = await readJsonBody(c);
  if (!json.ok) return json.response;

  const parsed = createSessionSchema.safeParse(json.body);
  if (!parsed.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", details: parsed.error.issues } }, 400);
  }

  // Normalize: accept both "preset" and "presetName"
  const presetName = parsed.data.preset ?? parsed.data.presetName;

  // Resolve base config: frozen snapshot source for this session.
  // - Prefer a server-loaded GROVE.md (runtime.contract) when present.
  // - Otherwise fall back to preset resolution; #198/#199 mean the
  //   session's frozen config is what drives enforcement, so callers
  //   who supply a preset don't need a contract on the server.
  // - Reject when neither is available so misconfiguration surfaces.
  let baseConfig: GroveContract | undefined;
  if (contract) {
    baseConfig = contract;
  } else if (presetName) {
    const preset = getPreset(presetName);
    if (!preset) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: `Unknown preset '${presetName}'`,
          },
        },
        400,
      );
    }
    baseConfig = presetToSessionConfig(preset, presetName);
  } else {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "contract or preset required when no GROVE.md is loaded",
        },
      },
      400,
    );
  }

  // Invariant: the block above either assigns baseConfig or returns.
  if (!baseConfig) {
    throw new Error("unreachable: baseConfig must be assigned or the request must have returned");
  }

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

  // Build config: start from the server's GROVE.md contract, but override
  // topology with the resolved topology from the request (which may include
  // TUI-edited edge config like replyTimeoutSeconds). Without this override,
  // the server's config.topology would silently discard per-session edits.
  const sessionConfig = resolvedTopology
    ? { ...baseConfig, topology: resolvedTopology }
    : baseConfig;

  const session = await goalSessionStore.createSession({
    goal: parsed.data.goal,
    presetName,
    topology: resolvedTopology,
    config: sessionConfig,
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

/** GET /api/sessions/:id/delete-blockers — List blockers preventing deletion. */
sessions.get("/:id/delete-blockers", async (c) => {
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

  const blockers = await goalSessionStore.listSessionDeleteBlockers(sessionId);
  return c.json({ sessionId, blockers });
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

/** GET /api/sessions/:id/contributions — Full contribution history for a session. */
sessions.get("/:id/contributions", async (c) => {
  const deps = c.get("deps");
  const { goalSessionStore } = deps;
  if (!goalSessionStore) return notConfigured(c, "Goal/session store is not configured");

  const sessionId = c.req.param("id");
  const session = await goalSessionStore.getSession(sessionId);
  if (!session) {
    return c.json(
      { error: { code: "NOT_FOUND", message: `Session not found: ${sessionId}` } },
      404,
    );
  }

  const cids = await goalSessionStore.getSessionContributions(sessionId);
  if (cids.length === 0) return c.json([]);

  const contributionStore = contributionStoreForSession(deps, sessionId);
  const byCid = await contributionStore.getMany(cids);
  const contributions: Contribution[] = [];
  for (const cid of cids) {
    const contribution = byCid.get(cid);
    if (contribution !== undefined) contributions.push(contribution);
  }

  return c.json(contributions);
});

/**
 * DELETE /api/sessions/:id — Delete a session.
 *
 * @Dangerous: wrapped with `dangerous()` middleware. Requests without an
 * `If-Match` header are rejected with `428 Precondition Required` before
 * the handler runs. When the supplied If-Match no longer matches the
 * persisted session resource version, the store returns `rv-mismatch`
 * and this handler responds with `409 Conflict` carrying the current
 * snapshot so clients can re-fetch and retry.
 */
sessions.delete(
  "/:id",
  dangerous<"/:id">(async (c) => {
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

    // `dangerous()` middleware guarantees a non-empty `ifMatch` is set;
    // `getIfMatch` encodes that invariant in one place.
    const ifMatch = getIfMatch(c);
    const deleteResult = await goalSessionStore.deleteSession(sessionId, {
      ifMatch,
      force: c.req.query("force") === "true",
      actor: "http",
    });

    if (deleteResult.kind === "rv-mismatch") {
      return c.json(
        {
          error: {
            code: "CONFLICT",
            message: `Session ${sessionId} resourceVersion changed`,
            current: deleteResult.current,
          },
        },
        409,
      );
    }

    const result = deleteResult.view;
    const status = !result.deleted && !result.forced && result.blockers.length > 0 ? 409 : 200;
    return c.json(result, status);
  }),
);

/**
 * PUT /api/sessions/:id/archive — Archive a session.
 *
 * @Dangerous: wrapped with `dangerous()` middleware. Requests without an
 * `If-Match` header are rejected with `428 Precondition Required` before
 * the handler runs. A stale If-Match returns `409 Conflict` with the
 * store's current RV so the caller can re-fetch and retry.
 */
sessions.put(
  "/:id/archive",
  dangerous<"/:id/archive">(async (c) => {
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

    const ifMatch = getIfMatch(c);
    const archiveResult = await goalSessionStore.archiveSession(sessionId, { ifMatch });
    if (archiveResult.kind === "rv-mismatch") {
      return c.json(
        {
          error: {
            code: "CONFLICT",
            message: `Session ${sessionId} resourceVersion changed`,
            current: archiveResult.current,
          },
        },
        409,
      );
    }
    return c.body(null, 204);
  }),
);

/** POST /api/sessions/:id/contributions — Record a contribution against a session. */
sessions.post("/:id/contributions", async (c) => {
  const deps = c.get("deps");
  const { goalSessionStore } = deps;
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

  const json = await readJsonBody(c);
  if (!json.ok) return json.response;

  const parsed = addContributionSchema.safeParse(json.body);
  if (!parsed.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", details: parsed.error.issues } }, 400);
  }

  const contributionStore = contributionStoreForSession(deps, sessionId);
  const authoritativeStore =
    deps.contributionStoreForSession !== undefined ? contributionStore : deps.contributionStore;
  const contribution = await authoritativeStore.get(parsed.data.cid);
  if (contribution === undefined) {
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

  await goalSessionStore.addContributionToSession(sessionId, parsed.data.cid);
  return c.body(null, 204);
});

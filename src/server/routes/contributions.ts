/**
 * Contribution endpoints.
 *
 * POST /api/contributions — Submit contribution (multipart with artifacts)
 * GET  /api/contributions — List contributions
 * GET  /api/contributions/:cid — Get contribution manifest
 * GET  /api/contributions/:cid/artifacts/:name — Download artifact blob
 * GET  /api/contributions/:cid/artifacts/:name/meta — Artifact metadata
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type {
  Contribution,
  ContributionKind,
  ContributionMode,
  JsonValue,
  Relation,
  Score,
} from "../../core/models.js";
import type { ContributeInput } from "../../core/operations/index.js";
import { contributeOperation } from "../../core/operations/index.js";
import type { OutcomeStats, OutcomeStatus } from "../../core/outcome.js";
import type { ContributionQuery } from "../../core/store.js";
import type { ServerEnv } from "../deps.js";
import { toHttpResult, toOperationDeps } from "../operation-adapter.js";
import { CID_REGEX, MAX_REQUEST_SIZE } from "../schemas.js";
import { contributionStoreForSession } from "./shared.js";

// ---------------------------------------------------------------------------
// File-local schemas (not exported — avoids isolatedDeclarations issues)
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  kind: z.string().optional(),
  mode: z.string().optional(),
  tags: z.string().optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  outcome: z.enum(["accepted", "rejected", "crashed", "invalidated"]).optional(),
  sessionId: z.string().optional(),
});

const cidParamSchema = z.object({
  cid: z.string().regex(CID_REGEX, "CID must be in format blake3:<64-hex-chars>"),
});

const manifestSchema = z
  .object({
    kind: z.enum([
      "work",
      "review",
      "discussion",
      "adoption",
      "reproduction",
      "plan",
      "ask_user",
      "response",
    ]),
    mode: z.enum(["evaluation", "exploration"]),
    summary: z.string().min(1),
    description: z.string().optional(),
    commitHash: z.string().optional(),
    artifacts: z
      .record(z.string(), z.string().regex(CID_REGEX, "artifact hash must be blake3:<64-hex>"))
      .optional(),
    relations: z
      .array(
        z
          .object({
            targetCid: z.string().regex(CID_REGEX, "targetCid must be blake3:<64-hex>"),
            relationType: z.enum([
              "derives_from",
              "responds_to",
              "reviews",
              "reproduces",
              "adopts",
            ]),
            metadata: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .default([]),
    scores: z
      .record(
        z.string(),
        z
          .object({
            value: z.number(),
            direction: z.enum(["minimize", "maximize"]),
            unit: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    tags: z.array(z.string()).default([]),
    context: z.record(z.string(), z.unknown()).optional(),
    agent: z
      .object({
        agentId: z.string().min(1),
        agentName: z.string().optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        platform: z.string().optional(),
        version: z.string().optional(),
        toolchain: z.string().optional(),
        runtime: z.string().optional(),
        role: z.string().optional(),
      })
      .strict(),
    createdAt: z.string().datetime({ offset: true }).optional(),
    sessionId: z.string().min(1).optional(),
  })
  .strict();

/** Build ContributionQuery from validated query params. */
function toContributionQuery(raw: {
  kind?: string | undefined;
  mode?: string | undefined;
  tags?: string | undefined;
  agentId?: string | undefined;
  agentName?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  sessionId?: string | undefined;
}): ContributionQuery {
  return {
    kind: raw.kind as ContributionKind | undefined,
    mode: raw.mode as ContributionMode | undefined,
    tags: raw.tags ? raw.tags.split(",").filter((t) => t.length > 0) : undefined,
    agentId: raw.agentId,
    agentName: raw.agentName,
    limit: raw.limit,
    offset: raw.offset,
    ...(raw.sessionId !== undefined ? { sessionId: raw.sessionId } : {}),
  };
}

function hasContributionFilters(raw: {
  kind?: string | undefined;
  mode?: string | undefined;
  tags?: string | undefined;
  agentId?: string | undefined;
  agentName?: string | undefined;
  sessionId?: string | undefined;
}): boolean {
  return (
    raw.kind !== undefined ||
    raw.mode !== undefined ||
    raw.tags !== undefined ||
    raw.agentId !== undefined ||
    raw.agentName !== undefined ||
    raw.sessionId !== undefined
  );
}

function matchesContributionFilters(contribution: Contribution, query: ContributionQuery): boolean {
  if (query.kind !== undefined && contribution.kind !== query.kind) return false;
  if (query.mode !== undefined && contribution.mode !== query.mode) return false;
  if (query.agentId !== undefined && contribution.agent.agentId !== query.agentId) return false;
  if (query.agentName !== undefined && contribution.agent.agentName !== query.agentName) {
    return false;
  }
  if (
    query.tags !== undefined &&
    query.tags.length > 0 &&
    !query.tags.every((tag) => contribution.tags.includes(tag))
  ) {
    return false;
  }
  return true;
}

function compareByRecencyDesc(a: Contribution, b: Contribution): number {
  const byDate = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return byDate !== 0 ? byDate : b.cid.localeCompare(a.cid);
}

function totalForOutcomeStatus(stats: OutcomeStats, status: OutcomeStatus): number {
  switch (status) {
    case "accepted":
      return stats.accepted;
    case "rejected":
      return stats.rejected;
    case "crashed":
      return stats.crashed;
    case "invalidated":
      return stats.invalidated;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const contributions: HonoType<ServerEnv> = new Hono<ServerEnv>();

/** POST /api/contributions — Submit a contribution with optional artifacts. */
contributions.post("/", async (c) => {
  // Size guard
  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (contentLength > MAX_REQUEST_SIZE) {
    return c.json(
      {
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: `Request exceeds ${MAX_REQUEST_SIZE} bytes`,
        },
      },
      413,
    );
  }

  const serverDeps = c.get("deps");
  const { cas } = serverDeps;
  const contentType = c.req.header("content-type") ?? "";

  let manifestData: unknown;
  const artifactParts = new Map<string, File>();

  if (contentType.includes("multipart/form-data")) {
    const body = await c.req.parseBody();

    const rawManifest = body.manifest;
    if (typeof rawManifest !== "string") {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Missing 'manifest' part in multipart body",
          },
        },
        400,
      );
    }

    try {
      manifestData = JSON.parse(rawManifest);
    } catch {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid JSON in manifest part" } },
        400,
      );
    }

    // Collect artifact:* parts
    // With parseBody({ all: true }), values may be arrays
    for (const [key, value] of Object.entries(body)) {
      if (!key.startsWith("artifact:")) continue;
      const artifactName = key.slice("artifact:".length);
      const file = Array.isArray(value) ? value.find((v) => v instanceof File) : value;
      if (file instanceof File) {
        artifactParts.set(artifactName, file);
      }
    }
  } else {
    try {
      manifestData = await c.req.json();
    } catch {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } }, 400);
    }
  }

  // Validate manifest
  const parsed = manifestSchema.parse(manifestData);

  // Ingest multipart artifact files into CAS (HTTP-specific concern)
  const artifacts: Record<string, string> = {};
  if (parsed.artifacts) {
    for (const [name, hash] of Object.entries(parsed.artifacts)) {
      if (typeof hash === "string") {
        artifacts[name] = hash;
      }
    }
  }
  for (const [name, file] of artifactParts) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mediaType = file.type || undefined;
    const contentHash = await cas.put(bytes, mediaType ? { mediaType } : undefined);
    artifacts[name] = contentHash;
  }

  // Extract Idempotency-Key header (RFC 8284 / Stripe convention)
  const idempotencyKey = c.req.header("idempotency-key");

  // Build operation input and delegate to shared operations layer
  const input: ContributeInput = {
    kind: parsed.kind,
    mode: parsed.mode,
    summary: parsed.summary,
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(parsed.commitHash !== undefined ? { commitHash: parsed.commitHash } : {}),
    artifacts,
    relations: parsed.relations as readonly Relation[],
    ...(parsed.scores !== undefined
      ? { scores: parsed.scores as Readonly<Record<string, Score>> }
      : {}),
    tags: parsed.tags,
    ...(parsed.context !== undefined
      ? { context: parsed.context as Readonly<Record<string, JsonValue>> }
      : {}),
    agent: parsed.agent,
    ...(parsed.createdAt !== undefined ? { createdAt: parsed.createdAt } : {}),
    // Scope idempotency key by sessionId so the same key in different
    // sessions is treated as distinct — prevents cross-session cache
    // contamination and policy bypass.
    ...(idempotencyKey !== undefined
      ? {
          idempotencyKey: parsed.sessionId
            ? `${idempotencyKey}\x01${parsed.sessionId}`
            : idempotencyKey,
        }
      : {}),
  };

  let opDeps = toOperationDeps(serverDeps);
  // Inject namespace only for non-session writes (#292). When sessionId
  // is set, the write lands in the session-scoped store but /api/list
  // reads the process-global store, so emitting a watch event the lister
  // can't mirror would violate the list→watch RV invariant. Session-scoped
  // watch is tracked as a follow-up.
  if (parsed.sessionId === undefined) {
    opDeps = { ...opDeps, namespace: c.get("namespace") };
  }

  // Session-scoped store: when sessionId is present and a factory is wired
  // (Nexus mode), swap the contribution store so writes land at the
  // session-scoped VFS path — matching where MCP agents write. Without this
  // the HTTP submit path would write to the zone root while MCP writes go to
  // sessions/{sessionId}/, splitting the data across two directories.
  const scopedContributionStore =
    parsed.sessionId !== undefined
      ? contributionStoreForSession(serverDeps, parsed.sessionId)
      : serverDeps.contributionStore;

  // Session-scoped enforcement: override contract with session config
  if (parsed.sessionId) {
    const { goalSessionStore } = serverDeps;
    if (!goalSessionStore) {
      return c.json(
        { error: { code: "NOT_CONFIGURED", message: "Goal/session store is not configured" } },
        501,
      );
    }
    const session = await goalSessionStore.getSession(parsed.sessionId);
    if (!session) {
      return c.json(
        { error: { code: "NOT_FOUND", message: `Session not found: ${parsed.sessionId}` } },
        404,
      );
    }
    const sessionConfig = await goalSessionStore.getSessionConfig(parsed.sessionId);
    if (!sessionConfig) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: `Session ${parsed.sessionId} has no stored config`,
          },
        },
        400,
      );
    }
    opDeps = { ...opDeps, contract: sessionConfig, contributionStore: scopedContributionStore };
  }

  const result = await contributeOperation(input, opDeps);

  if (!result.ok) {
    const { data, status } = toHttpResult(result);
    return c.json(data, status);
  }

  // Auto-attach contribution to session
  if (parsed.sessionId) {
    const { goalSessionStore } = serverDeps;
    if (goalSessionStore) {
      try {
        await goalSessionStore.addContributionToSession(parsed.sessionId, result.value.cid);
      } catch {
        // Fetch the full contribution but flag attachment failure
        const contribution = await scopedContributionStore.get(result.value.cid);
        return c.json({ ...contribution, _attachmentFailed: true }, 201);
      }
    }
  }

  // Fetch the full contribution to preserve the existing response shape
  const contribution = await scopedContributionStore.get(result.value.cid);
  return c.json(contribution, 201);
});

/** GET /api/contributions — List contributions with filters. */
contributions.get("/", zValidator("query", listQuerySchema), async (c) => {
  const deps = c.get("deps");
  const { outcomeStore } = deps;
  const raw = c.req.valid("query");

  // When a sessionId is present and the deps expose a session-scoped factory
  // (Nexus mode), build a per-request store so list()/count() hit the
  // session-scoped FTS index instead of the zone root. Falls back to the
  // process-global store when no factory is wired (tests, local-only mode).
  const listStore = contributionStoreForSession(deps, raw.sessionId);

  if (raw.outcome !== undefined) {
    if (outcomeStore === undefined) {
      return c.json(
        { error: { code: "NOT_CONFIGURED", message: "Outcome store is not configured" } },
        501,
      );
    }

    const targetStatus = raw.outcome as OutcomeStatus;
    const limit = raw.limit ?? 20;
    const offset = raw.offset ?? 0;

    if (!hasContributionFilters(raw)) {
      const outcomes = await outcomeStore.list({ status: targetStatus, limit, offset });
      const contributions = await listStore.getMany(outcomes.map((outcome) => outcome.cid));
      const page: Contribution[] = [];
      for (const outcome of outcomes) {
        const contribution = contributions.get(outcome.cid);
        if (contribution !== undefined) page.push(contribution);
      }
      const stats = await outcomeStore.getStats();
      c.header("X-Total-Count", String(totalForOutcomeStatus(stats, targetStatus)));
      return c.json(page);
    }

    const filterQuery = toContributionQuery({ ...raw, limit: undefined, offset: undefined });
    const outcomes = await outcomeStore.list({ status: targetStatus });
    const contributions = await listStore.getMany(outcomes.map((outcome) => outcome.cid));
    const filtered: Contribution[] = [];
    const seen = new Set<string>();
    for (const outcome of outcomes) {
      if (seen.has(outcome.cid)) continue;
      seen.add(outcome.cid);
      const contribution = contributions.get(outcome.cid);
      if (contribution !== undefined && matchesContributionFilters(contribution, filterQuery)) {
        filtered.push(contribution);
      }
    }
    filtered.sort(compareByRecencyDesc);
    const page = filtered.slice(offset, offset + limit);

    c.header("X-Total-Count", String(filtered.length));
    return c.json(page);
  }

  const query = toContributionQuery(raw);
  const results = await listStore.list(query);

  const total = await listStore.count({
    kind: query.kind,
    mode: query.mode,
    tags: query.tags,
    agentId: query.agentId,
    agentName: query.agentName,
    ...(query.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
  });

  c.header("X-Total-Count", String(total));
  return c.json(results);
});

/** GET /api/contributions/:cid — Get a single contribution by CID. */
contributions.get("/:cid", zValidator("param", cidParamSchema), async (c) => {
  const contributionStore = contributionStoreForSession(c.get("deps"), c.req.query("sessionId"));
  const { cid } = c.req.valid("param");

  const contribution = await contributionStore.get(cid);
  if (!contribution) {
    return c.json({ error: { code: "NOT_FOUND", message: `Contribution ${cid} not found` } }, 404);
  }

  return c.json(contribution);
});

/** GET /api/contributions/:cid/artifacts/:name/meta — Artifact metadata (size + mediaType). */
contributions.get("/:cid/artifacts/:name{.+}/meta", async (c) => {
  const deps = c.get("deps");
  const contributionStore = contributionStoreForSession(deps, c.req.query("sessionId"));
  const { cas } = deps;
  const cid = c.req.param("cid");
  const name = c.req.param("name");

  const contribution = await contributionStore.get(cid);
  if (!contribution) {
    return c.json({ error: { code: "NOT_FOUND", message: `Contribution ${cid} not found` } }, 404);
  }

  const contentHash = contribution.artifacts[name];
  if (!contentHash) {
    return c.json(
      { error: { code: "NOT_FOUND", message: `Artifact '${name}' not found in ${cid}` } },
      404,
    );
  }

  const meta = await cas.stat(contentHash);
  if (!meta) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Artifact blob not found for hash ${contentHash}`,
        },
      },
      404,
    );
  }

  return c.json({
    sizeBytes: meta.sizeBytes,
    ...(meta.mediaType !== undefined ? { mediaType: meta.mediaType } : {}),
  });
});

/** GET /api/contributions/:cid/artifacts/:name — Download artifact blob. */
contributions.get("/:cid/artifacts/:name{.+}", async (c) => {
  const deps = c.get("deps");
  const contributionStore = contributionStoreForSession(deps, c.req.query("sessionId"));
  const { cas } = deps;
  const cid = c.req.param("cid");
  const name = c.req.param("name");

  const contribution = await contributionStore.get(cid);
  if (!contribution) {
    return c.json({ error: { code: "NOT_FOUND", message: `Contribution ${cid} not found` } }, 404);
  }

  const contentHash = contribution.artifacts[name];
  if (!contentHash) {
    return c.json(
      { error: { code: "NOT_FOUND", message: `Artifact '${name}' not found in ${cid}` } },
      404,
    );
  }

  const data = await cas.get(contentHash);
  if (!data) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Artifact blob not found for hash ${contentHash}`,
        },
      },
      404,
    );
  }

  const meta = await cas.stat(contentHash);
  return new Response(data, {
    status: 200,
    headers: {
      "Content-Type": meta?.mediaType ?? "application/octet-stream",
      "Content-Length": String(data.byteLength),
    },
  });
});

export { contributions };

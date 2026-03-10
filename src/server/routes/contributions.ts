/**
 * Contribution endpoints.
 *
 * POST /api/contributions — Submit contribution (multipart with artifacts)
 * GET  /api/contributions — List contributions
 * GET  /api/contributions/:cid — Get contribution manifest
 * GET  /api/contributions/:cid/artifacts/:name — Download artifact blob
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { createContribution } from "../../core/manifest.js";
import type {
  ContributionInput,
  ContributionKind,
  ContributionMode,
  JsonValue,
  Relation,
  Score,
} from "../../core/models.js";
import type { ContributionQuery } from "../../core/store.js";
import type { ServerEnv } from "../deps.js";
import { CID_REGEX, MAX_REQUEST_SIZE } from "../schemas.js";

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
});

const cidParamSchema = z.object({
  cid: z.string().regex(CID_REGEX, "CID must be in format blake3:<64-hex-chars>"),
});

const manifestSchema = z
  .object({
    kind: z.enum(["work", "review", "discussion", "adoption", "reproduction"]),
    mode: z.enum(["evaluation", "exploration"]),
    summary: z.string().min(1),
    description: z.string().optional(),
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
      })
      .strict(),
    createdAt: z.string().datetime({ offset: true }).optional(),
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
}): ContributionQuery {
  return {
    kind: raw.kind as ContributionKind | undefined,
    mode: raw.mode as ContributionMode | undefined,
    tags: raw.tags ? raw.tags.split(",").filter((t) => t.length > 0) : undefined,
    agentId: raw.agentId,
    agentName: raw.agentName,
    limit: raw.limit,
    offset: raw.offset,
  };
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

  const { contributionStore, cas } = c.get("deps");
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

  // Build artifacts map: start with pre-computed hashes, overlay multipart files
  const artifacts: Record<string, string> = {};
  if (parsed.artifacts) {
    for (const [name, hash] of Object.entries(parsed.artifacts)) {
      if (typeof hash === "string") {
        // Verify pre-computed hash exists in CAS
        const exists = await cas.exists(hash);
        if (!exists) {
          return c.json(
            {
              error: {
                code: "VALIDATION_ERROR",
                message: `Artifact '${name}' references non-existent hash ${hash}`,
              },
            },
            400,
          );
        }
        artifacts[name] = hash;
      }
    }
  }

  // Process multipart artifact files
  for (const [name, file] of artifactParts) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mediaType = file.type || undefined;
    const contentHash = await cas.put(bytes, mediaType ? { mediaType } : undefined);
    artifacts[name] = contentHash;
  }

  // Build contribution input
  const now = new Date().toISOString();
  const input: ContributionInput = {
    kind: parsed.kind,
    mode: parsed.mode,
    summary: parsed.summary,
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
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
    createdAt: parsed.createdAt ?? now,
  };

  const contribution = createContribution(input);
  await contributionStore.put(contribution);

  return c.json(contribution, 201);
});

/** GET /api/contributions — List contributions with filters. */
contributions.get("/", zValidator("query", listQuerySchema), async (c) => {
  const { contributionStore } = c.get("deps");
  const raw = c.req.valid("query");
  const query = toContributionQuery(raw);

  const results = await contributionStore.list(query);
  const total = await contributionStore.count({
    kind: query.kind,
    mode: query.mode,
    tags: query.tags,
    agentId: query.agentId,
    agentName: query.agentName,
  });

  c.header("X-Total-Count", String(total));
  return c.json(results);
});

/** GET /api/contributions/:cid — Get a single contribution by CID. */
contributions.get("/:cid", zValidator("param", cidParamSchema), async (c) => {
  const { contributionStore } = c.get("deps");
  const { cid } = c.req.valid("param");

  const contribution = await contributionStore.get(cid);
  if (!contribution) {
    return c.json({ error: { code: "NOT_FOUND", message: `Contribution ${cid} not found` } }, 404);
  }

  return c.json(contribution);
});

/** GET /api/contributions/:cid/artifacts/:name — Download artifact blob. */
contributions.get("/:cid/artifacts/:name", async (c) => {
  const { contributionStore, cas } = c.get("deps");
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

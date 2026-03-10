/**
 * Search endpoint.
 *
 * GET /api/search — Full-text search contributions.
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { ContributionKind, ContributionMode } from "../../core/models.js";
import type { ServerEnv } from "../deps.js";

const querySchema = z.object({
  q: z.string().min(1, "Search query is required"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  kind: z.string().optional(),
  mode: z.string().optional(),
  tags: z.string().optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
});

const search: HonoType<ServerEnv> = new Hono<ServerEnv>();

/** GET /api/search — Search contributions by text query with filters. */
search.get("/", zValidator("query", querySchema), async (c) => {
  const { contributionStore } = c.get("deps");
  const raw = c.req.valid("query");

  const results = await contributionStore.search(raw.q, {
    kind: raw.kind as ContributionKind | undefined,
    mode: raw.mode as ContributionMode | undefined,
    tags: raw.tags ? raw.tags.split(",").filter((t) => t.length > 0) : undefined,
    agentId: raw.agentId,
    agentName: raw.agentName,
    limit: raw.limit,
    offset: raw.offset,
  });

  return c.json(results);
});

export { search };

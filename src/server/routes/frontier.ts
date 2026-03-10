/**
 * Frontier endpoint.
 *
 * GET /api/frontier — Multi-signal frontier with filters.
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { ContributionKind, ContributionMode } from "../../core/models.js";
import type { ServerEnv } from "../deps.js";

const querySchema = z.object({
  kind: z.string().optional(),
  mode: z.string().optional(),
  tags: z.string().optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  metric: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

const frontier: HonoType<ServerEnv> = new Hono<ServerEnv>();

/** GET /api/frontier — Compute multi-signal frontier. */
frontier.get("/", zValidator("query", querySchema), async (c) => {
  const { frontier: calculator } = c.get("deps");
  const query = c.req.valid("query");

  const result = await calculator.compute({
    metric: query.metric,
    tags: query.tags ? query.tags.split(",").filter((t) => t.length > 0) : undefined,
    kind: query.kind as ContributionKind | undefined,
    mode: query.mode as ContributionMode | undefined,
    agentId: query.agentId,
    agentName: query.agentName,
    limit: query.limit,
  });

  return c.json(result);
});

export { frontier };

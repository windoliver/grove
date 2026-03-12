/**
 * Frontier endpoint.
 *
 * GET /api/frontier — Multi-signal frontier with filters.
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { ContributionKind, ContributionMode, JsonValue } from "../../core/models.js";
import { frontierOperation } from "../../core/operations/index.js";
import type { ServerEnv } from "../deps.js";
import { toHttpResult, toOperationDeps } from "../operation-adapter.js";

const querySchema = z.object({
  kind: z.string().optional(),
  mode: z.string().optional(),
  tags: z.string().optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  metric: z.string().optional(),
  context: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

const frontier: HonoType<ServerEnv> = new Hono<ServerEnv>();

/** GET /api/frontier — Compute multi-signal frontier. */
frontier.get("/", zValidator("query", querySchema), async (c) => {
  const query = c.req.valid("query");

  let contextFilter: Record<string, JsonValue> | undefined;
  if (query.context !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(query.context);
    } catch {
      return c.json({ error: "Invalid context parameter: must be valid JSON object" }, 400);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return c.json(
        { error: "Invalid context parameter: must be a JSON object, not an array or primitive" },
        400,
      );
    }
    contextFilter = parsed as Record<string, JsonValue>;
  }

  const deps = toOperationDeps(c.get("deps"));
  const result = await frontierOperation(
    {
      metric: query.metric,
      tags: query.tags ? query.tags.split(",").filter((t) => t.length > 0) : undefined,
      kind: query.kind as ContributionKind | undefined,
      mode: query.mode as ContributionMode | undefined,
      agentId: query.agentId,
      agentName: query.agentName,
      context: contextFilter,
      limit: query.limit,
    },
    deps,
  );

  const { data, status } = toHttpResult(result);
  return c.json(data, status);
});

export { frontier };

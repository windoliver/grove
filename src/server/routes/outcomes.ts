/**
 * Outcome endpoints.
 *
 * POST /api/outcomes/:cid — Set outcome for a contribution
 * GET  /api/outcomes/:cid — Get outcome for a contribution
 * GET  /api/outcomes       — List/filter outcomes
 * GET  /api/outcomes/stats — Get aggregated outcome statistics
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  getBatchOutcomesOperation,
  getOutcomeOperation,
  listOutcomesOperation,
  outcomeStatsOperation,
  setOutcomeOperation,
} from "../../core/operations/index.js";
import type { OutcomeStatus } from "../../core/outcome.js";
import type { ServerEnv } from "../deps.js";
import { toHttpResult, toOperationDeps } from "../operation-adapter.js";
import { CID_REGEX } from "../schemas.js";

const cidParamSchema = z.object({
  cid: z.string().regex(CID_REGEX, "CID must be in format blake3:<64-hex-chars>"),
});

const setOutcomeSchema = z.object({
  status: z.enum(["accepted", "rejected", "crashed", "invalidated"]),
  reason: z.string().max(1024).optional(),
  baselineCid: z.string().regex(CID_REGEX).optional(),
  evaluatedBy: z.string().min(1).max(256),
});

const listQuerySchema = z.object({
  status: z.enum(["accepted", "rejected", "crashed", "invalidated"]).optional(),
  evaluatedBy: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  cids: z.string().optional(),
});

export const outcomes: Hono<ServerEnv> = new Hono<ServerEnv>();

// GET /api/outcomes/stats — must be before /:cid to avoid route conflict
outcomes.get("/stats", async (c) => {
  const deps = toOperationDeps(c.get("deps"));
  const result = await outcomeStatsOperation(deps);

  const { data, status } = toHttpResult(result);
  return c.json(data, status);
});

// GET /api/outcomes/:cid
outcomes.get("/:cid", zValidator("param", cidParamSchema), async (c) => {
  const { cid } = c.req.valid("param");

  const deps = toOperationDeps(c.get("deps"));
  const result = await getOutcomeOperation({ cid }, deps);

  const { data, status } = toHttpResult(result);
  return c.json(data, status);
});

// POST /api/outcomes/:cid
outcomes.post("/:cid", zValidator("param", cidParamSchema), async (c) => {
  const { cid } = c.req.valid("param");
  const body = await c.req.json();
  const parsed = setOutcomeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.issues }, 400);
  }

  const deps = toOperationDeps(c.get("deps"));
  const result = await setOutcomeOperation(
    {
      cid,
      status: parsed.data.status as OutcomeStatus,
      ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
      ...(parsed.data.baselineCid !== undefined ? { baselineCid: parsed.data.baselineCid } : {}),
      agent: { agentId: parsed.data.evaluatedBy },
    },
    deps,
  );

  const { data, status } = toHttpResult(result, 201);
  return c.json(data, status);
});

// GET /api/outcomes
outcomes.get("/", zValidator("query", listQuerySchema), async (c) => {
  const query = c.req.valid("query");
  const deps = toOperationDeps(c.get("deps"));

  // When cids is provided, use batch lookup instead of list
  if (query.cids !== undefined) {
    // Reject mixed query modes — cids is a distinct lookup path
    const hasListFilters =
      query.status !== undefined ||
      query.evaluatedBy !== undefined ||
      query.limit !== 20 ||
      query.offset !== 0;
    if (hasListFilters) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message:
              "Cannot combine 'cids' with 'status', 'evaluatedBy', 'limit', or 'offset' filters",
          },
        },
        400,
      );
    }

    const cidList = query.cids
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (cidList.length === 0) {
      return c.json([], 200);
    }

    const result = await getBatchOutcomesOperation({ cids: cidList }, deps);
    if (!result.ok) {
      const { data, status } = toHttpResult(result);
      return c.json(data, status);
    }
    // Return as an array to match the existing list response format
    return c.json([...result.value.values()], 200);
  }

  const result = await listOutcomesOperation(
    {
      status: query.status as OutcomeStatus | undefined,
      evaluatedBy: query.evaluatedBy,
      limit: query.limit,
      offset: query.offset,
    },
    deps,
  );

  const { data, status } = toHttpResult(result);
  return c.json(data, status);
});

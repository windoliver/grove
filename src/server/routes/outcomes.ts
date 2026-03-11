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
import type { OutcomeInput, OutcomeStatus } from "../../core/outcome.js";
import type { ServerEnv } from "../deps.js";
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
});

export const outcomes: Hono<ServerEnv> = new Hono<ServerEnv>();

/** Helper to get the outcome store or return 501. */
function getOutcomeStore(c: { get: (key: "deps") => { outcomeStore?: unknown } }) {
  const deps = c.get("deps");
  if (!deps.outcomeStore) {
    return null;
  }
  return deps.outcomeStore as import("../../core/outcome.js").OutcomeStore;
}

// GET /api/outcomes/stats — must be before /:cid to avoid route conflict
outcomes.get("/stats", async (c) => {
  const store = getOutcomeStore(c);
  if (!store) return c.json({ error: "Outcome store not configured" }, 501);

  const stats = await store.getStats();
  return c.json(stats);
});

// GET /api/outcomes/:cid
outcomes.get("/:cid", zValidator("param", cidParamSchema), async (c) => {
  const store = getOutcomeStore(c);
  if (!store) return c.json({ error: "Outcome store not configured" }, 501);

  const { cid } = c.req.valid("param");
  const record = await store.get(cid);
  if (!record) return c.json({ error: "No outcome for this CID" }, 404);
  return c.json(record);
});

// POST /api/outcomes/:cid
outcomes.post("/:cid", zValidator("param", cidParamSchema), async (c) => {
  const store = getOutcomeStore(c);
  if (!store) return c.json({ error: "Outcome store not configured" }, 501);

  const { cid } = c.req.valid("param");
  const body = await c.req.json();
  const parsed = setOutcomeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.issues }, 400);
  }

  const input: OutcomeInput = {
    status: parsed.data.status as OutcomeStatus,
    reason: parsed.data.reason,
    baselineCid: parsed.data.baselineCid,
    evaluatedBy: parsed.data.evaluatedBy,
  };

  const record = await store.set(cid, input);
  return c.json(record, 201);
});

// GET /api/outcomes
outcomes.get("/", zValidator("query", listQuerySchema), async (c) => {
  const store = getOutcomeStore(c);
  if (!store) return c.json({ error: "Outcome store not configured" }, 501);

  const query = c.req.valid("query");
  const records = await store.list({
    status: query.status as OutcomeStatus | undefined,
    evaluatedBy: query.evaluatedBy,
    limit: query.limit,
    offset: query.offset,
  });
  return c.json(records);
});

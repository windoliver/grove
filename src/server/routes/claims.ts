/**
 * Claim endpoints.
 *
 * POST  /api/claims      — Create or renew a claim
 * PATCH /api/claims/:id  — Heartbeat, release, or complete
 * GET   /api/claims      — List claims with filters
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { DEFAULT_LEASE_MS } from "../../core/constants.js";
import type { AgentIdentity, Claim, JsonValue } from "../../core/models.js";
import { listClaimsOperation, releaseOperation } from "../../core/operations/index.js";
import type { ServerEnv } from "../deps.js";
import { toHttpResult, toOperationDeps } from "../operation-adapter.js";

const createBodySchema = z.object({
  claimId: z.string().min(1).optional(),
  targetRef: z.string().min(1),
  agent: z.object({
    agentId: z.string().min(1),
    agentName: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    platform: z.string().optional(),
    version: z.string().optional(),
    toolchain: z.string().optional(),
    runtime: z.string().optional(),
    role: z.string().optional(),
  }),
  intentSummary: z.string().min(1),
  leaseDurationMs: z.number().int().positive().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

const patchBodySchema = z.object({
  action: z.enum(["heartbeat", "release", "complete"]),
  leaseDurationMs: z.number().int().positive().optional(),
});

const listQuerySchema = z.object({
  status: z.enum(["active", "released", "expired", "completed"]).optional(),
  agentId: z.string().optional(),
  targetRef: z.string().optional(),
});

const claims: HonoType<ServerEnv> = new Hono<ServerEnv>();

/**
 * POST /api/claims — Create or renew a claim (idempotent per agent+target).
 *
 * Kept as direct store interaction because the HTTP API accepts a fully-formed
 * agent identity in the request body rather than using resolveAgent().
 */
claims.post("/", zValidator("json", createBodySchema), async (c) => {
  const { claimStore } = c.get("deps");
  const body = c.req.valid("json");
  const now = new Date();
  const leaseDurationMs = body.leaseDurationMs ?? DEFAULT_LEASE_MS;

  const claim: Claim = {
    claimId: body.claimId ?? crypto.randomUUID(),
    targetRef: body.targetRef,
    agent: body.agent as AgentIdentity,
    status: "active",
    intentSummary: body.intentSummary,
    createdAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
    ...(body.context !== undefined
      ? { context: body.context as Readonly<Record<string, JsonValue>> }
      : {}),
  };

  const result = await claimStore.claimOrRenew(claim);
  return c.json(result, 201);
});

/** PATCH /api/claims/:id — Heartbeat, release, or complete a claim. */
claims.patch("/:id", zValidator("json", patchBodySchema), async (c) => {
  const claimId = c.req.param("id");
  const { action, leaseDurationMs } = c.req.valid("json");

  // Heartbeat stays as direct store call (no matching operation)
  if (action === "heartbeat") {
    const { claimStore } = c.get("deps");
    const result = await claimStore.heartbeat(claimId, leaseDurationMs);
    return c.json(result);
  }

  // Release / complete via shared operation
  const deps = toOperationDeps(c.get("deps"));
  const result = await releaseOperation({ claimId, action }, deps);

  const { data, status } = toHttpResult(result);
  return c.json(data, status);
});

/** GET /api/claims — List claims with optional filters. */
claims.get("/", zValidator("query", listQuerySchema), async (c) => {
  const query = c.req.valid("query");

  const deps = toOperationDeps(c.get("deps"));
  const result = await listClaimsOperation(
    {
      status: query.status,
      agentId: query.agentId,
      targetRef: query.targetRef,
    },
    deps,
  );

  const { data, status } = toHttpResult(result);
  return c.json(data, status);
});

export { claims };

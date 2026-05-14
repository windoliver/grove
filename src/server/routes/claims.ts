/**
 * Claim endpoints.
 *
 * POST  /api/claims      — Create or renew a claim
 * PATCH /api/claims/:id  — Heartbeat, release, or complete
 * GET   /api/claims      — List claims with filters
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { DEFAULT_LEASE_MS } from "../../core/constants.js";
import { claimToEntity, claimViewToEntity } from "../../core/entity.js";
import type { AgentIdentity, Claim, ClaimSpecRecord, JsonValue } from "../../core/models.js";
import { listClaimsOperation, releaseOperation } from "../../core/operations/index.js";
import type { ClaimStatusPatch } from "../../core/store.js";
import type { ServerEnv } from "../deps.js";
import { toHttpResult, toOperationDeps } from "../operation-adapter.js";

const agentIdentitySchema = z.object({
  agentId: z.string().min(1),
  agentName: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  platform: z.string().optional(),
  version: z.string().optional(),
  toolchain: z.string().optional(),
  runtime: z.string().optional(),
  role: z.string().optional(),
});

const createBodySchema = z.object({
  claimId: z.string().min(1).optional(),
  targetRef: z.string().min(1),
  agent: agentIdentitySchema,
  intentSummary: z.string().min(1),
  leaseDurationMs: z.number().int().positive().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

const statusOwnedFields = [
  "status",
  "phase",
  "observedGeneration",
  "agentSessionId",
  "lastHeartbeatAt",
  "heartbeatAt",
  "leaseExpiresAt",
  "currentContributionCid",
  "conditions",
  "lastTransitionAt",
  "attemptCount",
  "revision",
] as const;

const specOwnedFields = [
  "roleName",
  "platform",
  "blueprint",
  "assignee",
  "leaseDeadlineSec",
  "priority",
  "maxIterations",
  "targetRef",
  "agent",
  "intentSummary",
  "context",
  "generation",
  "createdAt",
  "revision",
] as const;

function rejectFields(
  body: Readonly<Record<string, unknown>>,
  ctx: z.RefinementCtx,
  fields: readonly string[],
  owner: string,
): void {
  for (const field of fields) {
    if (Object.hasOwn(body, field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is owned by ${owner}`,
      });
    }
  }
}

const specBodySchema = z
  .object({
    targetRef: z.string().min(1),
    agent: agentIdentitySchema,
    intentSummary: z.string().min(1),
    roleName: z.string().optional(),
    platform: z.string().optional(),
    blueprint: z.string().optional(),
    assignee: agentIdentitySchema.optional(),
    leaseDeadlineSec: z.number().int().positive().optional(),
    priority: z.number().int().optional(),
    maxIterations: z.number().int().positive().optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .superRefine((body, ctx) => {
    rejectFields(body, ctx, statusOwnedFields, "claim status");
  });

const conditionSchema = z
  .object({
    type: z.string().min(1),
    status: z.enum(["True", "False", "Unknown"]),
    observedGeneration: z.number().int().nonnegative(),
    lastTransitionTime: z.string().datetime(),
    reason: z.string(),
    message: z.string(),
  })
  .passthrough();

const statusBodySchema = z
  .object({
    phase: z.enum(["active", "released", "expired", "completed"]).optional(),
    observedGeneration: z.number().int().nonnegative().optional(),
    agentSessionId: z.string().min(1).optional(),
    lastHeartbeatAt: z.string().datetime().optional(),
    leaseExpiresAt: z.string().datetime().optional(),
    currentContributionCid: z.string().min(1).optional(),
    conditions: z.array(conditionSchema).optional(),
    lastTransitionAt: z.string().datetime().optional(),
  })
  .passthrough()
  .superRefine((body, ctx) => {
    rejectFields(body, ctx, specOwnedFields, "claim spec");
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

const requireControllerToken: MiddlewareHandler<ServerEnv> = async (c, next) => {
  const deps = c.get("deps");
  const token = c.req.header("X-Grove-Controller-Token");

  if (!deps.controllerToken || token !== deps.controllerToken) {
    return c.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Controller token required",
        },
      },
      403,
    );
  }

  await next();
};

const claims: HonoType<ServerEnv> = new Hono<ServerEnv>();

/**
 * POST /api/claims — Create or renew a claim (idempotent per agent+target).
 *
 * Kept as direct store interaction because the HTTP API accepts a fully-formed
 * agent identity in the request body rather than using resolveAgent().
 */
claims.post("/", zValidator("json", createBodySchema), async (c) => {
  const deps = c.get("deps");
  const { claimStore, watchHub, watchSubscriber } = deps;
  const namespace = c.get("namespace");
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

  // Watch fan-out (#292). Direct store path bypasses the operations layer
  // so we record + markSeen here. Renewals must emit MODIFIED — they
  // advance heartbeatAt/leaseExpiresAt which Claim watchers use to
  // reason about lease state; suppressing them would let watchers
  // declare an actively-renewed claim expired. Ring pressure under
  // high renewal cadence is mitigated by sizing maxEventsPerKey to the
  // expected renewal × active-claim load and by the WatchClient's
  // relist-on-410 recovery path.
  const op: "ADDED" | "MODIFIED" = (result.revision ?? 1) === 1 ? "ADDED" : "MODIFIED";
  const entity = claimToEntity(result, () => Date.now(), namespace);
  try {
    watchHub.recordWrite({ kind: "Claim", namespace, op, entity });
    watchSubscriber?.markSeen({
      kind: "Claim",
      entityId: result.claimId,
      generation: entity.metadata.generation,
    });
  } catch (err) {
    process.stderr.write(
      `[grove] Warning: watch fan-out threw after POST /api/claims: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }

  return c.json(result, 201);
});

/** PUT /api/claims/:id — Create or update the user-owned claim spec. */
claims.put("/:id", zValidator("json", specBodySchema), async (c) => {
  const deps = c.get("deps");
  const claimId = c.req.param("id");
  const body = c.req.valid("json");
  const existing = await deps.claimStore.getClaimView(claimId);
  const spec: ClaimSpecRecord = {
    id: claimId,
    roleName: body.roleName,
    platform: body.platform,
    blueprint: body.blueprint,
    assignee: body.assignee as AgentIdentity | undefined,
    leaseDeadlineSec: body.leaseDeadlineSec,
    priority: body.priority,
    maxIterations: body.maxIterations,
    generation: 0,
    targetRef: body.targetRef,
    agent: body.agent as AgentIdentity,
    intentSummary: body.intentSummary,
    context: body.context as Readonly<Record<string, JsonValue>> | undefined,
    createdAt: existing?.spec.createdAt ?? new Date().toISOString(),
  };

  const putResult = await deps.claimStore.putClaimSpec(spec);
  if (putResult.kind === "rv-mismatch") {
    // PUT handler does not (yet) accept If-Match; if the inner store
    // surfaces an rv-mismatch here, that's a programming error — only
    // CAS-bearing routes should observe this branch (T6).
    throw new Error("unexpected RV mismatch on non-CAS putClaimSpec path");
  }
  const view = putResult.view;
  const namespace = c.get("namespace");
  const entity = claimViewToEntity(view, () => Date.now(), namespace);
  try {
    deps.watchHub.recordWrite({
      kind: "Claim",
      namespace,
      op: existing === undefined ? "ADDED" : "MODIFIED",
      entity,
    });
    deps.watchSubscriber?.markSeen({
      kind: "Claim",
      entityId: view.spec.id,
      generation: entity.metadata.generation,
    });
  } catch (err) {
    process.stderr.write(
      `[grove] Warning: watch fan-out threw after PUT /api/claims/${claimId}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
  return c.json(view, existing === undefined ? 201 : 200);
});

/** GET /api/claims/:id — Return the merged split claim view. */
claims.get("/:id", async (c) => {
  const claimId = c.req.param("id");
  const view = await c.get("deps").claimStore.getClaimView(claimId);

  if (view === undefined) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Claim '${claimId}' not found`,
        },
      },
      404,
    );
  }

  return c.json(view);
});

/** PATCH /api/claims/:id/status — Patch controller-owned claim status. */
claims.patch(
  "/:id/status",
  requireControllerToken,
  zValidator("json", statusBodySchema),
  async (c) => {
    const deps = c.get("deps");
    const body = c.req.valid("json");
    const patch: ClaimStatusPatch = {
      phase: body.phase,
      observedGeneration: body.observedGeneration,
      agentSessionId: body.agentSessionId,
      lastHeartbeatAt: body.lastHeartbeatAt,
      leaseExpiresAt: body.leaseExpiresAt,
      currentContributionCid: body.currentContributionCid,
      conditions: body.conditions as ClaimStatusPatch["conditions"],
      lastTransitionAt: body.lastTransitionAt,
    };

    const view = await deps.claimStore.patchClaimStatus(c.req.param("id"), patch);
    const namespace = c.get("namespace");
    const entity = claimViewToEntity(view, () => Date.now(), namespace);
    try {
      deps.watchHub.recordWrite({ kind: "Claim", namespace, op: "MODIFIED", entity });
      deps.watchSubscriber?.markSeen({
        kind: "Claim",
        entityId: view.spec.id,
        generation: entity.metadata.generation,
      });
    } catch (err) {
      process.stderr.write(
        `[grove] Warning: watch fan-out threw after PATCH /api/claims/${view.spec.id}/status: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
    return c.json(view);
  },
);

/** PATCH /api/claims/:id — Heartbeat, release, or complete a claim. */
claims.patch("/:id", zValidator("json", patchBodySchema), async (c) => {
  const claimId = c.req.param("id");
  const { action, leaseDurationMs } = c.req.valid("json");

  // Heartbeat stays as direct store call (no matching operation)
  if (action === "heartbeat") {
    const deps = c.get("deps");
    const { claimStore, watchHub, watchSubscriber } = deps;
    const namespace = c.get("namespace");
    const result = await claimStore.heartbeat(claimId, leaseDurationMs);
    // Heartbeats advance heartbeatAt/leaseExpiresAt — fields Claim watchers
    // depend on for lease-aware decisions. Emit MODIFIED so a watcher's
    // cached entity stays in sync with the new lease deadline.
    const entity = claimToEntity(result, () => Date.now(), namespace);
    try {
      watchHub.recordWrite({ kind: "Claim", namespace, op: "MODIFIED", entity });
      watchSubscriber?.markSeen({
        kind: "Claim",
        entityId: result.claimId,
        generation: entity.metadata.generation,
      });
    } catch (err) {
      process.stderr.write(
        `[grove] Warning: watch fan-out threw after PATCH heartbeat: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
    return c.json(result);
  }

  // Release / complete via shared operation
  let deps = toOperationDeps(c.get("deps"));
  deps = { ...deps, namespace: c.get("namespace") };
  const result = await releaseOperation({ claimId, action }, deps);

  const { data, status } = toHttpResult(result);
  return c.json(data, status);
});

/** GET /api/claims — List claims with optional filters. */
claims.get("/", zValidator("query", listQuerySchema), async (c) => {
  const query = c.req.valid("query");

  // Use operation for validation/filtering
  const deps = toOperationDeps(c.get("deps"));
  const result = await listClaimsOperation(
    {
      status: query.status,
      agentId: query.agentId,
      targetRef: query.targetRef,
    },
    deps,
  );

  if (!result.ok) {
    const { data, status } = toHttpResult(result);
    return c.json(data, status);
  }

  // Return full claim objects for HTTP consumers (TUI remote provider)
  const { claimStore } = c.get("deps");
  const fullClaims = await claimStore.listClaims({
    status: query.status,
    agentId: query.agentId,
    targetRef: query.targetRef,
  });
  return c.json({ claims: fullClaims, count: fullClaims.length });
});

export { claims };

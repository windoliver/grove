/**
 * AgentTask endpoints.
 *
 * PUT   /api/agent-tasks/:id        — Create or update user-owned task spec
 * PATCH /api/agent-tasks/:id/status — Controller-owned task status patch
 * GET   /api/agent-tasks/:id        — Return merged split task view
 * GET   /api/agent-tasks            — List merged split task views
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AgentTaskSpecRecord } from "../../core/agent-task.js";
import { AgentTaskPhase } from "../../core/agent-task.js";
import type { JsonValue } from "../../core/models.js";
import type { AgentTaskStatusPatch } from "../../core/store.js";
import type { ServerEnv } from "../deps.js";
import { dangerous, getIfMatch } from "../middleware/dangerous.js";

const phaseSchema = z.enum([
  AgentTaskPhase.Pending,
  AgentTaskPhase.PendingBind,
  AgentTaskPhase.Running,
  AgentTaskPhase.AwaitingReview,
  AgentTaskPhase.Succeeded,
  AgentTaskPhase.Failed,
]);

const statusOwnedFields = [
  "status",
  "phase",
  "sessionId",
  "contributions",
  "conditions",
  "observedGeneration",
  "lastTransitionAt",
  "revision",
] as const;

const specOwnedFields = [
  "worktree",
  "runtime",
  "role",
  "prompt",
  "dependsOn",
  "maxTurns",
  "budget",
  "generation",
  "createdAt",
  "ownerRef",
  "finalizers",
  "deletionTimestamp",
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
    worktree: z.string().min(1),
    runtime: z.string().min(1),
    role: z.string().min(1),
    prompt: z.string().min(1),
    dependsOn: z.array(z.string().min(1)).default([]),
    maxTurns: z.number().int().positive().optional(),
    budget: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .superRefine((body, ctx) => {
    rejectFields(body, ctx, statusOwnedFields, "agent task status");
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
    phase: phaseSchema.optional(),
    sessionId: z.string().min(1).optional(),
    contributions: z.array(z.string().min(1)).optional(),
    conditions: z.array(conditionSchema).optional(),
    observedGeneration: z.number().int().nonnegative().optional(),
    lastTransitionAt: z.string().datetime().optional(),
  })
  .passthrough()
  .superRefine((body, ctx) => {
    rejectFields(body, ctx, specOwnedFields, "agent task spec");
  });

const listQuerySchema = z.object({
  phase: phaseSchema.optional(),
  role: z.string().optional(),
  runtime: z.string().optional(),
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

const requireAgentTaskStore: MiddlewareHandler<ServerEnv> = async (c, next) => {
  if (c.get("deps").agentTaskStore === undefined) {
    return c.json(
      {
        error: {
          code: "NOT_CONFIGURED",
          message: "AgentTask store is not configured",
        },
      },
      501,
    );
  }
  await next();
};

export const agentTasks: HonoType<ServerEnv> = new Hono<ServerEnv>();

agentTasks.use("*", requireAgentTaskStore);

/**
 * PUT /api/agent-tasks/:id — Create or update user-owned agent task spec.
 *
 * @Dangerous: wrapped with `dangerous()` middleware. Requests without an
 * `If-Match` header are rejected with `428 Precondition Required` before
 * the handler runs. A stale If-Match returns `409 Conflict` with the
 * store's current spec RV so callers can re-fetch and retry.
 */
agentTasks.put(
  "/:id",
  zValidator("json", specBodySchema),
  dangerous<"/:id">(async (c) => {
    const taskId = c.req.param("id");
    // Re-narrow validator output — `dangerous()` wraps as `Handler<ServerEnv, P>`
    // which discards the zValidator typing contribution.
    const body = c.req.valid("json" as never) as z.infer<typeof specBodySchema>;
    const store = c.get("deps").agentTaskStore;
    if (store === undefined) throw new Error("AgentTask store middleware did not run");

    const existing = await store.getAgentTask(taskId);
    const spec: AgentTaskSpecRecord = {
      id: taskId,
      worktree: body.worktree,
      runtime: body.runtime,
      role: body.role,
      prompt: body.prompt,
      dependsOn: body.dependsOn,
      maxTurns: body.maxTurns,
      budget: body.budget as Readonly<Record<string, JsonValue>> | undefined,
      generation: 0,
      createdAt: existing?.spec.createdAt ?? new Date().toISOString(),
      ownerRef: existing?.spec.ownerRef,
      finalizers: existing?.spec.finalizers,
      deletionTimestamp: existing?.spec.deletionTimestamp,
    };

    const ifMatch = getIfMatch(c);
    const result = await store.putAgentTaskSpec(spec, { ifMatch });
    if (result.kind === "rv-mismatch") {
      return c.json(
        {
          error: {
            code: "CONFLICT",
            message: `AgentTask ${taskId} resourceVersion changed`,
            current: result.current,
          },
        },
        409,
      );
    }
    return c.json(result.view, existing === undefined ? 201 : 200);
  }),
);

agentTasks.get("/", zValidator("query", listQuerySchema), async (c) => {
  const store = c.get("deps").agentTaskStore;
  if (store === undefined) throw new Error("AgentTask store middleware did not run");
  const query = c.req.valid("query");
  return c.json(await store.listAgentTasks(query));
});

agentTasks.get("/:id", async (c) => {
  const store = c.get("deps").agentTaskStore;
  if (store === undefined) throw new Error("AgentTask store middleware did not run");
  const taskId = c.req.param("id");
  const view = await store.getAgentTask(taskId);
  if (view === undefined) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `AgentTask '${taskId}' not found`,
        },
      },
      404,
    );
  }
  return c.json(view);
});

/**
 * PATCH /api/agent-tasks/:id/status — Controller-owned task status patch.
 *
 * @Dangerous: wrapped with `dangerous()` middleware. Requests without an
 * `If-Match` header are rejected with `428 Precondition Required` before
 * the handler runs. A stale If-Match returns `409 Conflict` with the
 * store's current status RV.
 */
agentTasks.patch(
  "/:id/status",
  requireControllerToken,
  zValidator("json", statusBodySchema),
  dangerous<"/:id/status">(async (c) => {
    const store = c.get("deps").agentTaskStore;
    if (store === undefined) throw new Error("AgentTask store middleware did not run");
    // Re-narrow validator output — see PUT /:id for rationale.
    const body = c.req.valid("json" as never) as z.infer<typeof statusBodySchema>;
    const patch: AgentTaskStatusPatch = {
      phase: body.phase,
      sessionId: body.sessionId,
      contributions: body.contributions,
      conditions: body.conditions as AgentTaskStatusPatch["conditions"],
      observedGeneration: body.observedGeneration,
      lastTransitionAt: body.lastTransitionAt,
    };
    const ifMatch = getIfMatch(c);
    const taskId = c.req.param("id");
    const result = await store.patchAgentTaskStatus(taskId, patch, { ifMatch });
    if (result.kind === "rv-mismatch") {
      return c.json(
        {
          error: {
            code: "CONFLICT",
            message: `AgentTask ${taskId} status resourceVersion changed`,
            current: result.current,
          },
        },
        409,
      );
    }
    return c.json(result.view);
  }),
);

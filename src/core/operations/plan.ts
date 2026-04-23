/**
 * Plan operations — sugars over `contributeOperation`.
 *
 * Plans are modeled as `plan`-kind contributions with structured task
 * lists in the `context.tasks` field. Plan updates use `derives_from`
 * relations to form a version chain.
 *
 * Both operations route through `contributeOperation` so they go through
 * the same role-kind / topology / hooks pipeline as `grove_submit_work`,
 * preventing the bypass described in #228. Plans are coordination metadata
 * (not progress) and opt out of handoff creation and stop-condition
 * evaluation inside `contributeOperation` based on `kind === "plan"`.
 */

import { ContributionKind, ContributionMode, RelationType } from "../models.js";
import type { AgentOverrides } from "./agent.js";
import { buildPlanContext, type PlanTask, parsePlanContext } from "./context-schemas.js";
import { type ContributeResult, contributeOperation } from "./contribute.js";
import type { OperationDeps } from "./deps.js";
import type { OperationResult } from "./result.js";
import { notFound, ok, validationErr } from "./result.js";

// Re-export for backwards compat with existing imports.
export type { PlanTask } from "./context-schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for creating a new plan. */
export interface CreatePlanInput {
  readonly title: string;
  readonly tasks: readonly PlanTask[];
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly agent?: AgentOverrides | undefined;
  readonly idempotencyKey?: string | undefined;
}

/** Input for updating an existing plan. */
export interface UpdatePlanInput {
  readonly previousPlanCid: string;
  readonly tasks: readonly PlanTask[];
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly agent?: AgentOverrides | undefined;
  readonly idempotencyKey?: string | undefined;
}

/** Result of a plan operation. */
export interface PlanResult {
  readonly cid: string;
  readonly title: string;
  readonly taskCount: number;
  readonly done: number;
  readonly inProgress: number;
  readonly todo: number;
  readonly blocked: number;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Create a new plan contribution.
 *
 * Sugar over contributeOperation: kind=plan, mode=exploration, with the
 * plan title and tasks stored in context via buildPlanContext.
 */
export async function createPlanOperation(
  input: CreatePlanInput,
  deps: OperationDeps,
): Promise<OperationResult<PlanResult>> {
  if (!input.title || input.title.trim().length === 0) {
    return validationErr("Plan title is required");
  }
  if (!input.tasks || input.tasks.length === 0) {
    return validationErr("Plan must have at least one task");
  }

  const result = await contributeOperation(
    {
      kind: ContributionKind.Plan,
      mode: ContributionMode.Exploration,
      summary: `Plan: ${input.title}`,
      ...(input.description !== undefined ? { description: input.description } : {}),
      tags: [...(input.tags ?? []), "plan"],
      context: buildPlanContext({ title: input.title, tasks: input.tasks }),
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    },
    deps,
  );

  if (!result.ok) return result as OperationResult<PlanResult>;
  return ok(toPlanResult(result.value, input.title, input.tasks));
}

/**
 * Update an existing plan (creates a new version with derives_from relation).
 *
 * Sugar over contributeOperation. Validates that the previous CID resolves
 * to an actual plan-kind contribution before creating the update — see
 * Issue 6A in the #228 review.
 */
export async function updatePlanOperation(
  input: UpdatePlanInput,
  deps: OperationDeps,
): Promise<OperationResult<PlanResult>> {
  const store = deps.contributionStore;
  if (!store) {
    return validationErr("contributionStore is required");
  }

  // Verify the previous CID resolves AND points at a plan. Doing the kind
  // check here (instead of relying on validateRelations alone) gives a clear
  // 'wrong kind' error and prevents constructing a plan update that derives
  // from a work / review / discussion contribution.
  const previous = await store.get(input.previousPlanCid);
  if (!previous) {
    return notFound("Previous plan", input.previousPlanCid);
  }
  if (previous.kind !== ContributionKind.Plan) {
    return validationErr(
      `Previous CID ${input.previousPlanCid} is a '${previous.kind}' contribution, not a plan`,
    );
  }

  if (!input.tasks || input.tasks.length === 0) {
    return validationErr("Plan must have at least one task");
  }

  const previousContext = parsePlanContext(previous.context);
  const title = input.title ?? previousContext?.plan_title ?? "Untitled Plan";
  // Omitted tags keep the previous plan's tags; explicit tags replace.
  const tags = [...new Set([...(input.tags ?? previous.tags), "plan"])];

  const result = await contributeOperation(
    {
      kind: ContributionKind.Plan,
      mode: ContributionMode.Exploration,
      summary: `Plan update: ${title}`,
      ...(input.description !== undefined ? { description: input.description } : {}),
      relations: [
        {
          targetCid: input.previousPlanCid,
          relationType: RelationType.DerivesFrom,
        },
      ],
      tags,
      context: buildPlanContext({ title, tasks: input.tasks }),
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    },
    deps,
  );

  if (!result.ok) return result as OperationResult<PlanResult>;
  return ok(toPlanResult(result.value, title, input.tasks));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPlanResult(
  result: ContributeResult,
  title: string,
  tasks: readonly PlanTask[],
): PlanResult {
  const stats = computeStats(tasks);
  return {
    cid: result.cid,
    title,
    ...stats,
    createdAt: result.createdAt,
  };
}

function computeStats(tasks: readonly PlanTask[]): {
  taskCount: number;
  done: number;
  inProgress: number;
  todo: number;
  blocked: number;
} {
  let done = 0;
  let inProgress = 0;
  let todo = 0;
  let blocked = 0;
  for (const t of tasks) {
    switch (t.status) {
      case "done":
        done++;
        break;
      case "in_progress":
        inProgress++;
        break;
      case "blocked":
        blocked++;
        break;
      default:
        todo++;
    }
  }
  return { taskCount: tasks.length, done, inProgress, todo, blocked };
}

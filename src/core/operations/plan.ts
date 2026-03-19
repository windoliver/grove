/**
 * Plan operations — create and update project plans.
 *
 * Plans are modeled as `plan`-kind contributions with structured task
 * lists in the `context.tasks` field. Plan updates use `derives_from`
 * relations to form a version chain.
 */

import { createContribution } from "../manifest.js";
import type { ContributionInput, JsonValue } from "../models.js";
import { ContributionKind, ContributionMode, RelationType } from "../models.js";
import type { AgentOverrides } from "./agent.js";
import { resolveAgent } from "./agent.js";
import type { OperationDeps } from "./deps.js";
import type { OperationResult } from "./result.js";
import { notFound, ok, validationErr } from "./result.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single task within a plan. */
export interface PlanTask {
  readonly id: string;
  readonly title: string;
  readonly status: "todo" | "in_progress" | "done" | "blocked";
  readonly assignee?: string | undefined;
}

/** Input for creating a new plan. */
export interface CreatePlanInput {
  readonly title: string;
  readonly tasks: readonly PlanTask[];
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly agent?: AgentOverrides | undefined;
}

/** Input for updating an existing plan. */
export interface UpdatePlanInput {
  readonly previousPlanCid: string;
  readonly tasks: readonly PlanTask[];
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly agent?: AgentOverrides | undefined;
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

/** Create a new plan contribution. */
export async function createPlanOperation(
  input: CreatePlanInput,
  deps: OperationDeps,
): Promise<OperationResult<PlanResult>> {
  const store = deps.contributionStore;
  if (!store) {
    return validationErr("contributionStore is required");
  }

  if (!input.title || input.title.trim().length === 0) {
    return validationErr("Plan title is required");
  }
  if (!input.tasks || input.tasks.length === 0) {
    return validationErr("Plan must have at least one task");
  }

  const agent = resolveAgent(input.agent);
  const now = new Date().toISOString();

  const contributionInput: ContributionInput = {
    kind: ContributionKind.Plan,
    mode: ContributionMode.Exploration,
    summary: `Plan: ${input.title}`,
    description: input.description,
    artifacts: {},
    relations: [],
    tags: [...(input.tags ?? []), "plan"],
    context: {
      plan_title: input.title,
      tasks: input.tasks as unknown as JsonValue,
    },
    agent,
    createdAt: now,
  };

  const contribution = createContribution(contributionInput);
  await store.put(contribution);
  deps.onContributionWrite?.();

  const stats = computeStats(input.tasks);
  return ok({
    cid: contribution.cid,
    title: input.title,
    ...stats,
    createdAt: contribution.createdAt,
  });
}

/** Update an existing plan (creates a new version with derives_from relation). */
export async function updatePlanOperation(
  input: UpdatePlanInput,
  deps: OperationDeps,
): Promise<OperationResult<PlanResult>> {
  const store = deps.contributionStore;
  if (!store) {
    return validationErr("contributionStore is required");
  }

  // Verify the previous plan exists
  const previous = await store.get(input.previousPlanCid);
  if (!previous) {
    return notFound("Previous plan", input.previousPlanCid);
  }

  if (!input.tasks || input.tasks.length === 0) {
    return validationErr("Plan must have at least one task");
  }

  const title = input.title ?? (previous.context?.plan_title as string) ?? "Untitled Plan";
  const agent = resolveAgent(input.agent);
  const now = new Date().toISOString();

  const contributionInput: ContributionInput = {
    kind: ContributionKind.Plan,
    mode: ContributionMode.Exploration,
    summary: `Plan update: ${title}`,
    description: input.description,
    artifacts: {},
    relations: [
      {
        targetCid: input.previousPlanCid,
        relationType: RelationType.DerivesFrom,
      },
    ],
    tags: [...(input.tags ?? []), "plan"],
    context: {
      plan_title: title,
      tasks: input.tasks as unknown as JsonValue,
    },
    agent,
    createdAt: now,
  };

  const contribution = createContribution(contributionInput);
  await store.put(contribution);
  deps.onContributionWrite?.();

  const stats = computeStats(input.tasks);
  return ok({
    cid: contribution.cid,
    title,
    ...stats,
    createdAt: contribution.createdAt,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

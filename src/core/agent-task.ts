import { rvComposite } from "./cas.js";
import type { Condition, Entity } from "./entity.js";
import type { Finalizer, OwnerRef } from "./lifecycle-metadata.js";
import type { JsonValue } from "./models.js";

export const AgentTaskPhase = {
  Pending: "Pending",
  PendingBind: "PendingBind",
  Running: "Running",
  AwaitingReview: "AwaitingReview",
  Succeeded: "Succeeded",
  Failed: "Failed",
} as const;
export type AgentTaskPhase = (typeof AgentTaskPhase)[keyof typeof AgentTaskPhase];

export const AgentTaskConditionType = {
  Admitted: "Admitted",
  Scheduled: "Scheduled",
  Bound: "Bound",
  Running: "Running",
  AwaitingReview: "AwaitingReview",
  Succeeded: "Succeeded",
  Failed: "Failed",
  Blocked: "Blocked",
} as const;
export type AgentTaskConditionType =
  (typeof AgentTaskConditionType)[keyof typeof AgentTaskConditionType];

export interface AgentTaskSpecRecord {
  readonly id: string;
  readonly worktree: string;
  readonly runtime: string;
  readonly role: string;
  readonly prompt: string;
  readonly dependsOn: readonly string[];
  readonly maxTurns?: number | undefined;
  readonly budget?: Readonly<Record<string, JsonValue>> | undefined;
  readonly generation: number;
  readonly ownerRef?: OwnerRef | undefined;
  readonly finalizers?: readonly Finalizer[] | undefined;
  readonly deletionTimestamp?: string | undefined;
  readonly createdAt: string;
  /**
   * Optimistic-concurrency resource version persisted by the store (C6, #304).
   * Optional: legacy stores that have not yet been migrated emit `undefined`,
   * in which case the entity projection falls back to deriving RV from
   * `generation`.
   */
  readonly resourceVersion?: number | undefined;
}

export interface AgentTaskStatusRecord {
  readonly id: string;
  readonly phase: AgentTaskPhase;
  readonly sessionId?: string | undefined;
  readonly contributions: readonly string[];
  readonly conditions: readonly Condition[];
  readonly observedGeneration: number;
  readonly lastTransitionAt: string;
  readonly revision: number;
  /**
   * Optimistic-concurrency resource version persisted by the store (C6, #304).
   * Optional: legacy stores that have not yet been migrated emit `undefined`,
   * in which case the entity projection falls back to deriving RV from
   * `revision`.
   */
  readonly resourceVersion?: number | undefined;
}

export interface AgentTaskView {
  readonly spec: AgentTaskSpecRecord;
  readonly status: AgentTaskStatusRecord;
}

export interface AgentTaskSpec {
  readonly worktree: string;
  readonly runtime: string;
  readonly role: string;
  readonly prompt: string;
  readonly dependsOn: readonly string[];
  readonly maxTurns?: number | undefined;
  readonly budget?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface AgentTaskStatus {
  readonly phase: AgentTaskPhase;
  readonly sessionId?: string | undefined;
  readonly contributions: readonly string[];
  readonly conditions: readonly Condition[];
  readonly observedGeneration: number;
}

export type AgentTaskEntity = Entity<"AgentTask", AgentTaskSpec, AgentTaskStatus>;

export function agentTaskViewToEntity(view: AgentTaskView, namespace = "default"): AgentTaskEntity {
  return {
    kind: "AgentTask",
    namespace,
    id: view.spec.id,
    spec: {
      worktree: view.spec.worktree,
      runtime: view.spec.runtime,
      role: view.spec.role,
      prompt: view.spec.prompt,
      dependsOn: view.spec.dependsOn,
      maxTurns: view.spec.maxTurns,
      budget: view.spec.budget,
    },
    status: {
      phase: view.status.phase,
      sessionId: view.status.sessionId,
      contributions: view.status.contributions,
      conditions: view.status.conditions,
      observedGeneration: view.status.observedGeneration,
    },
    conditions: view.status.conditions,
    observedGeneration: view.status.observedGeneration,
    // C6 (#304): The Entity's `resourceVersion` is a composite of the
    // persisted spec `resource_version` (bumped by `putAgentTaskSpec`) and
    // the status `resource_version` (bumped by `patchAgentTaskStatus`).
    // Mirrors the `claimViewToEntity` formula: (specRv + statusRv - 1) so
    // a freshly-created task has RV "1" rather than "2". `status.revision`
    // remains a backstop for stores that haven't migrated the
    // `resource_version` column yet.
    resourceVersion: String(
      rvComposite(view.spec.resourceVersion, view.status.resourceVersion ?? view.status.revision),
    ),
    metadata: {
      generation: view.spec.generation,
      creationTimestamp: view.spec.createdAt,
      ownerRefs: view.spec.ownerRef === undefined ? undefined : [view.spec.ownerRef],
      finalizers: view.spec.finalizers,
      deletionTimestamp: view.spec.deletionTimestamp,
    },
  };
}

export function isAgentTaskSpecStale(entity: AgentTaskEntity): boolean {
  return entity.status.observedGeneration < entity.metadata.generation;
}

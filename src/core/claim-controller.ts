import type { ClaimEntity, Condition } from "./entity.js";
import { ClaimStatus, type ClaimView } from "./models.js";
import type { ClaimStatusPatch, ClaimStore } from "./store.js";
import { KeyedWorkQueue } from "./workqueue.js";

export type ClaimControllerStore = Pick<
  ClaimStore,
  "getClaimView" | "patchClaimStatus" | "listEntities"
>;

export interface ClaimStatusTransition {
  readonly claimId: string;
  readonly fromPhase: ClaimStatus;
  readonly toPhase: ClaimStatus;
  readonly reason: string;
  readonly observedGeneration: number;
}

export interface ClaimReconciliationControllerOptions {
  readonly claimStore: ClaimControllerStore;
  readonly resyncIntervalMs?: number | undefined;
  readonly workerCount?: number | undefined;
  readonly queue?: KeyedWorkQueue | undefined;
  readonly now?: (() => number) | undefined;
  readonly onError?: ((error: unknown, claimId: string) => void) | undefined;
  readonly onTransition?: ((transition: ClaimStatusTransition) => void) | undefined;
}

interface ReconciliationResult {
  readonly patch: ClaimStatusPatch;
  readonly transition?: ClaimStatusTransition | undefined;
}

const DEFAULT_RESYNC_INTERVAL_MS = 30_000;
const DEFAULT_WORKER_COUNT = 1;
const LEASE_EXPIRED_REASON = "lease-expired";
const OBSERVED_GENERATION_REASON = "observed-generation-current";
const DELETION_REQUESTED_REASON = "deletion-requested";

export class ClaimReconciliationController {
  private readonly claimStore: ClaimControllerStore;
  private readonly queue: KeyedWorkQueue;
  private readonly now: () => number;
  private readonly resyncIntervalMs: number;
  private readonly workerCount: number;
  private readonly onError: ((error: unknown, claimId: string) => void) | undefined;
  private readonly onTransition: ((transition: ClaimStatusTransition) => void) | undefined;

  constructor(options: ClaimReconciliationControllerOptions) {
    this.claimStore = options.claimStore;
    this.now = options.now ?? Date.now;
    this.queue = options.queue ?? new KeyedWorkQueue({ now: this.now });
    this.resyncIntervalMs = options.resyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS;
    this.workerCount = options.workerCount ?? DEFAULT_WORKER_COUNT;
    this.onError = options.onError;
    this.onTransition = options.onTransition;
  }

  enqueue(claimId: string): void {
    this.queue.enqueue(claimId);
  }

  enqueueFromEntity(entity: ClaimEntity): void {
    this.enqueue(entity.id);
  }

  async resync(): Promise<number> {
    const entities = await this.claimStore.listEntities();
    for (const entity of entities) {
      this.enqueue(entity.id);
    }
    return entities.length;
  }

  async reconcileClaim(claimId: string): Promise<ClaimStatusTransition | undefined> {
    const view = await this.claimStore.getClaimView(claimId);
    if (view === undefined) return undefined;

    const result = this.computeReconciliation(view);
    if (result === undefined) return undefined;

    await this.claimStore.patchClaimStatus(claimId, result.patch);
    if (result.transition !== undefined) {
      this.onTransition?.(result.transition);
    }
    return result.transition;
  }

  start(): void {
    void this.resyncIntervalMs;
    void this.workerCount;
    void this.onError;
  }

  stop(): Promise<void> {
    this.queue.close();
    return Promise.resolve();
  }

  private computeReconciliation(view: ClaimView): ReconciliationResult | undefined {
    const leaseExpiresAtMs = Date.parse(view.status.leaseExpiresAt);
    if (!Number.isFinite(leaseExpiresAtMs)) {
      throw new Error(
        `invalid leaseExpiresAt for claim ${view.spec.id}: ${view.status.leaseExpiresAt}`,
      );
    }

    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const fromPhase = view.status.phase;
    const specGeneration = view.spec.generation;
    const needsObservedGeneration = view.status.observedGeneration !== specGeneration;
    const leaseExpired = fromPhase === ClaimStatus.Active && leaseExpiresAtMs <= nowMs;
    const terminating =
      view.spec.deletionTimestamp !== undefined &&
      view.spec.finalizers !== undefined &&
      view.spec.finalizers.length > 0;

    const nextPhase = leaseExpired ? ClaimStatus.Expired : undefined;
    let nextConditions = view.status.conditions;

    if (leaseExpired) {
      nextConditions = upsertCondition(nextConditions, {
        type: "Active",
        status: "False",
        observedGeneration: specGeneration,
        lastTransitionTime: nowIso,
        reason: LEASE_EXPIRED_REASON,
        message: "",
      });
      nextConditions = upsertCondition(nextConditions, {
        type: "Expired",
        status: "True",
        observedGeneration: specGeneration,
        lastTransitionTime: nowIso,
        reason: LEASE_EXPIRED_REASON,
        message: "",
      });
    }

    if (terminating) {
      nextConditions = upsertCondition(nextConditions, {
        type: "Terminating",
        status: "True",
        observedGeneration: specGeneration,
        lastTransitionTime: nowIso,
        reason: DELETION_REQUESTED_REASON,
        message: "",
      });
    }

    const conditionsChanged = !conditionsEqual(view.status.conditions, nextConditions);
    const patch = buildPatch({
      phase: nextPhase,
      observedGeneration: needsObservedGeneration || leaseExpired ? specGeneration : undefined,
      conditions: conditionsChanged ? nextConditions : undefined,
      lastTransitionAt: leaseExpired ? nowIso : undefined,
    });

    if (isEmptyPatch(patch)) return undefined;

    const transition =
      nextPhase !== undefined
        ? {
            claimId: view.spec.id,
            fromPhase,
            toPhase: nextPhase,
            reason: LEASE_EXPIRED_REASON,
            observedGeneration: specGeneration,
          }
        : needsObservedGeneration && !conditionsChanged
          ? {
              claimId: view.spec.id,
              fromPhase,
              toPhase: fromPhase,
              reason: OBSERVED_GENERATION_REASON,
              observedGeneration: specGeneration,
            }
          : undefined;

    return { patch, transition };
  }
}

function buildPatch(input: {
  readonly phase?: ClaimStatus | undefined;
  readonly observedGeneration?: number | undefined;
  readonly conditions?: readonly Condition[] | undefined;
  readonly lastTransitionAt?: string | undefined;
}): ClaimStatusPatch {
  return {
    ...(input.phase === undefined ? {} : { phase: input.phase }),
    ...(input.observedGeneration === undefined
      ? {}
      : { observedGeneration: input.observedGeneration }),
    ...(input.conditions === undefined ? {} : { conditions: input.conditions }),
    ...(input.lastTransitionAt === undefined ? {} : { lastTransitionAt: input.lastTransitionAt }),
  };
}

function isEmptyPatch(patch: ClaimStatusPatch): boolean {
  return (
    patch.phase === undefined &&
    patch.observedGeneration === undefined &&
    patch.agentSessionId === undefined &&
    patch.lastHeartbeatAt === undefined &&
    patch.leaseExpiresAt === undefined &&
    patch.currentContributionCid === undefined &&
    patch.conditions === undefined &&
    patch.lastTransitionAt === undefined
  );
}

function upsertCondition(
  conditions: readonly Condition[],
  desired: Condition,
): readonly Condition[] {
  const index = conditions.findIndex((condition) => condition.type === desired.type);
  if (index === -1) {
    return [...conditions, desired];
  }

  const existing = conditions[index];
  if (existing === undefined) return conditions;
  const next: Condition =
    existing.status === desired.status &&
    existing.reason === desired.reason &&
    existing.message === desired.message
      ? {
          ...desired,
          lastTransitionTime: existing.lastTransitionTime,
        }
      : desired;

  if (conditionEqual(existing, next)) return conditions;

  return conditions.map((condition, conditionIndex) =>
    conditionIndex === index ? next : condition,
  );
}

function conditionsEqual(left: readonly Condition[], right: readonly Condition[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((condition, index) => {
    const other = right[index];
    return other !== undefined && conditionEqual(condition, other);
  });
}

function conditionEqual(left: Condition, right: Condition): boolean {
  return (
    left.type === right.type &&
    left.status === right.status &&
    left.observedGeneration === right.observedGeneration &&
    left.lastTransitionTime === right.lastTransitionTime &&
    left.reason === right.reason &&
    left.message === right.message
  );
}

import { expectCasOk } from "./cas.js";
import type { ClaimEntity, Condition } from "./entity.js";
import { ClaimStatus, type ClaimView } from "./models.js";
import type { ClaimStatusPatch, ClaimStore } from "./store.js";
import { KeyedWorkQueue, QueueClosedError, type WorkItemResult } from "./workqueue.js";

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
const MAX_RESYNC_INTERVAL_MS = 2_147_483_647;
const MAX_WORKER_COUNT = 1_000;
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
  private running = false;
  private stopRequested = false;
  private workers: Promise<void>[] = [];
  private resyncTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ClaimReconciliationControllerOptions) {
    this.claimStore = options.claimStore;
    this.now = options.now ?? Date.now;
    this.queue = options.queue ?? new KeyedWorkQueue({ now: this.now });
    this.resyncIntervalMs = options.resyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS;
    this.workerCount = options.workerCount ?? DEFAULT_WORKER_COUNT;
    validateResyncIntervalMs(this.resyncIntervalMs);
    validateWorkerCount(this.workerCount);
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

    expectCasOk(
      await this.claimStore.patchClaimStatus(claimId, result.patch),
      `reconcileClaim(${claimId})`,
    );
    if (result.transition !== undefined) {
      this.onTransition?.(result.transition);
    }
    return result.transition;
  }

  start(): void {
    if (this.running) return;
    if (this.stopRequested) throw new QueueClosedError();
    this.running = true;
    this.stopRequested = false;
    for (let i = 0; i < this.workerCount; i += 1) {
      this.workers.push(this.workerLoop());
    }
    this.resyncTimer = setInterval(() => {
      void this.resync().catch((error: unknown) => {
        this.reportError(error, "__resync__");
      });
    }, this.resyncIntervalMs);
    this.resyncTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.running && this.stopRequested) return;
    this.stopRequested = true;
    if (this.resyncTimer !== undefined) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = undefined;
    }
    this.queue.close();
    const workers = this.workers;
    this.workers = [];
    await Promise.all(workers);
    this.running = false;
  }

  private async workerLoop(): Promise<void> {
    while (!this.stopRequested) {
      let item: WorkItemResult;
      try {
        item = await this.queue.take();
      } catch (error) {
        if (this.stopRequested) return;
        throw error;
      }

      try {
        await this.reconcileClaim(item.key);
        this.queue.acknowledge(item.key);
      } catch (error) {
        if (!this.stopRequested) this.queue.retry(item.key);
        this.reportError(error, item.key);
      }
    }
  }

  private reportError(error: unknown, claimId: string): void {
    try {
      this.onError?.(error, claimId);
    } catch {
      return;
    }
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
        : {
            claimId: view.spec.id,
            fromPhase,
            toPhase: fromPhase,
            reason: statusPatchTransitionReason(
              needsObservedGeneration,
              terminating,
              conditionsChanged,
            ),
            observedGeneration: specGeneration,
          };

    return { patch, transition };
  }
}

function validateResyncIntervalMs(value: number): void {
  if (!Number.isFinite(value) || value < 1 || value > MAX_RESYNC_INTERVAL_MS) {
    throw new RangeError(
      `resyncIntervalMs must be a finite positive number no greater than ${MAX_RESYNC_INTERVAL_MS}`,
    );
  }
}

function validateWorkerCount(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_WORKER_COUNT) {
    throw new RangeError(`workerCount must be an integer between 1 and ${MAX_WORKER_COUNT}`);
  }
}

function statusPatchTransitionReason(
  observedGenerationChanged: boolean,
  terminating: boolean,
  conditionsChanged: boolean,
): string {
  if (observedGenerationChanged) return OBSERVED_GENERATION_REASON;
  if (terminating && conditionsChanged) return DELETION_REQUESTED_REASON;
  return "conditions-updated";
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

import { describe, expect, test } from "bun:test";
import {
  type ClaimControllerStore,
  ClaimReconciliationController,
  type ClaimStatusTransition,
} from "./claim-controller.js";
import { type ClaimEntity, type Condition, claimViewToEntity } from "./entity.js";
import { Finalizer } from "./lifecycle-metadata.js";
import {
  type AgentIdentity,
  type ClaimSpecRecord,
  ClaimStatus,
  type ClaimStatusRecord,
  type ClaimView,
} from "./models.js";
import type { ClaimStatusPatch } from "./store.js";
import { KeyedWorkQueue } from "./workqueue.js";

const FIXED_NOW_MS = Date.parse("2026-05-09T12:00:00.000Z");
const FIXED_NOW_ISO = "2026-05-09T12:00:00.000Z";
const BEFORE_NOW_ISO = "2026-05-09T11:59:59.000Z";
const AFTER_NOW_ISO = "2026-05-09T12:00:01.000Z";
const CREATED_AT_ISO = "2026-05-09T11:55:00.000Z";
const HEARTBEAT_AT_ISO = "2026-05-09T11:58:00.000Z";

const AGENT: AgentIdentity = {
  agentId: "agent-1",
  role: "coder",
  platform: "codex",
};

interface RecordedPatch {
  readonly claimId: string;
  readonly patch: ClaimStatusPatch;
}

interface ViewOverrides {
  readonly id?: string | undefined;
  readonly phase?: ClaimStatus | undefined;
  readonly generation?: number | undefined;
  readonly observedGeneration?: number | undefined;
  readonly leaseExpiresAt?: string | undefined;
  readonly conditions?: readonly Condition[] | undefined;
  readonly finalizers?: readonly Finalizer[] | undefined;
  readonly deletionTimestamp?: string | undefined;
}

class FakeClaimControllerStore implements ClaimControllerStore {
  readonly views = new Map<string, ClaimView>();
  readonly patches: RecordedPatch[] = [];
  specMutationCalls = 0;

  seed(view: ClaimView): void {
    this.views.set(view.spec.id, view);
  }

  getClaimView = async (claimId: string): Promise<ClaimView | undefined> => {
    return this.views.get(claimId);
  };

  patchClaimStatus = async (claimId: string, patch: ClaimStatusPatch): Promise<ClaimView> => {
    const view = this.views.get(claimId);
    if (view === undefined) {
      throw new Error(`missing claim ${claimId}`);
    }
    this.patches.push({ claimId, patch });
    const updatedStatus: ClaimStatusRecord = {
      ...view.status,
      phase: patch.phase ?? view.status.phase,
      observedGeneration: patch.observedGeneration ?? view.status.observedGeneration,
      agentSessionId: patch.agentSessionId ?? view.status.agentSessionId,
      lastHeartbeatAt: patch.lastHeartbeatAt ?? view.status.lastHeartbeatAt,
      leaseExpiresAt: patch.leaseExpiresAt ?? view.status.leaseExpiresAt,
      currentContributionCid: patch.currentContributionCid ?? view.status.currentContributionCid,
      conditions: patch.conditions ?? view.status.conditions,
      lastTransitionAt: patch.lastTransitionAt ?? view.status.lastTransitionAt,
      revision: view.status.revision + 1,
    };
    const updated: ClaimView = { spec: view.spec, status: updatedStatus };
    this.views.set(claimId, updated);
    return updated;
  };

  listEntities = async (): Promise<readonly ClaimEntity[]> => {
    return [...this.views.values()].map((view) => claimViewToEntity(view, () => FIXED_NOW_MS));
  };

  putClaimSpec = async (spec: ClaimSpecRecord): Promise<ClaimView> => {
    this.specMutationCalls += 1;
    const view = this.views.get(spec.id);
    if (view === undefined) {
      throw new Error(`unexpected spec mutation for ${spec.id}`);
    }
    return view;
  };
}

function makeView(overrides: ViewOverrides = {}): ClaimView {
  const id = overrides.id ?? "claim-1";
  const generation = overrides.generation ?? 2;
  const observedGeneration = overrides.observedGeneration ?? generation;
  const spec: ClaimSpecRecord = {
    id,
    roleName: "coder",
    platform: "codex",
    assignee: AGENT,
    leaseDeadlineSec: 300,
    generation,
    targetRef: "target-1",
    agent: AGENT,
    intentSummary: "claim task",
    createdAt: CREATED_AT_ISO,
    ...(overrides.finalizers === undefined ? {} : { finalizers: overrides.finalizers }),
    ...(overrides.deletionTimestamp === undefined
      ? {}
      : { deletionTimestamp: overrides.deletionTimestamp }),
  };
  return {
    spec,
    status: {
      id,
      phase: overrides.phase ?? ClaimStatus.Active,
      observedGeneration,
      lastHeartbeatAt: HEARTBEAT_AT_ISO,
      leaseExpiresAt: overrides.leaseExpiresAt ?? AFTER_NOW_ISO,
      conditions: overrides.conditions ?? [],
      lastTransitionAt: HEARTBEAT_AT_ISO,
      attemptCount: 0,
      revision: observedGeneration,
    },
  };
}

function makeCondition(type: string, overrides: Partial<Condition> = {}): Condition {
  return {
    type,
    status: "True",
    observedGeneration: 1,
    lastTransitionTime: "2026-05-09T11:00:00.000Z",
    reason: "seeded",
    message: "seeded condition",
    ...overrides,
  };
}

function makeController(
  store: FakeClaimControllerStore,
  overrides: {
    readonly queue?: KeyedWorkQueue | undefined;
    readonly onTransition?: (transition: ClaimStatusTransition) => void;
  } = {},
): ClaimReconciliationController {
  return new ClaimReconciliationController({
    claimStore: store,
    now: () => FIXED_NOW_MS,
    queue: overrides.queue,
    onTransition: overrides.onTransition,
  });
}

function onlyPatch(store: FakeClaimControllerStore): RecordedPatch {
  expect(store.patches).toHaveLength(1);
  const patch = store.patches[0];
  if (patch === undefined) {
    throw new Error("expected one recorded patch");
  }
  return patch;
}

function conditionByType(
  conditions: readonly Condition[] | undefined,
  type: string,
): Condition | undefined {
  return conditions?.find((condition) => condition.type === type);
}

describe("ClaimReconciliationController", () => {
  test("expires active claims whose lease deadline has passed", async () => {
    const store = new FakeClaimControllerStore();
    store.seed(makeView({ leaseExpiresAt: BEFORE_NOW_ISO }));
    const transitions: ClaimStatusTransition[] = [];
    const controller = makeController(store, {
      onTransition: (transition) => {
        transitions.push(transition);
      },
    });

    const transition = await controller.reconcileClaim("claim-1");

    const expectedTransition: ClaimStatusTransition = {
      claimId: "claim-1",
      fromPhase: ClaimStatus.Active,
      toPhase: ClaimStatus.Expired,
      reason: "lease-expired",
      observedGeneration: 2,
    };
    expect(transition).toEqual(expectedTransition);
    expect(transitions).toEqual([expectedTransition]);
    const recorded = onlyPatch(store);
    expect(recorded.claimId).toBe("claim-1");
    expect(recorded.patch.phase).toBe(ClaimStatus.Expired);
    expect(recorded.patch.observedGeneration).toBe(2);
    expect(recorded.patch.lastTransitionAt).toBe(FIXED_NOW_ISO);
    expect(conditionByType(recorded.patch.conditions, "Active")).toEqual({
      type: "Active",
      status: "False",
      observedGeneration: 2,
      lastTransitionTime: FIXED_NOW_ISO,
      reason: "lease-expired",
      message: "",
    });
    expect(conditionByType(recorded.patch.conditions, "Expired")).toEqual({
      type: "Expired",
      status: "True",
      observedGeneration: 2,
      lastTransitionTime: FIXED_NOW_ISO,
      reason: "lease-expired",
      message: "",
    });
    expect(store.specMutationCalls).toBe(0);
  });

  test("catches observedGeneration up without changing phase", async () => {
    const store = new FakeClaimControllerStore();
    store.seed(makeView({ generation: 7, observedGeneration: 3, leaseExpiresAt: AFTER_NOW_ISO }));
    const controller = makeController(store);

    const transition = await controller.reconcileClaim("claim-1");

    expect(transition).toEqual({
      claimId: "claim-1",
      fromPhase: ClaimStatus.Active,
      toPhase: ClaimStatus.Active,
      reason: "observed-generation-current",
      observedGeneration: 7,
    });
    expect(onlyPatch(store).patch).toEqual({ observedGeneration: 7 });
  });

  test("does not move terminal claims back to active", async () => {
    const store = new FakeClaimControllerStore();
    store.seed(
      makeView({
        phase: ClaimStatus.Completed,
        generation: 5,
        observedGeneration: 2,
        leaseExpiresAt: BEFORE_NOW_ISO,
      }),
    );
    const controller = makeController(store);

    const transition = await controller.reconcileClaim("claim-1");

    expect(transition).toEqual({
      claimId: "claim-1",
      fromPhase: ClaimStatus.Completed,
      toPhase: ClaimStatus.Completed,
      reason: "observed-generation-current",
      observedGeneration: 5,
    });
    expect(onlyPatch(store).patch).toEqual({ observedGeneration: 5 });
  });

  test("adds Terminating condition only when deletionTimestamp and finalizers are present", async () => {
    const deletingStore = new FakeClaimControllerStore();
    deletingStore.seed(
      makeView({
        deletionTimestamp: FIXED_NOW_ISO,
        finalizers: [Finalizer.ReleaseSlots],
      }),
    );
    const deletingController = makeController(deletingStore);

    await deletingController.reconcileClaim("claim-1");

    const terminating = conditionByType(onlyPatch(deletingStore).patch.conditions, "Terminating");
    expect(terminating).toEqual({
      type: "Terminating",
      status: "True",
      observedGeneration: 2,
      lastTransitionTime: FIXED_NOW_ISO,
      reason: "deletion-requested",
      message: "",
    });

    const noFinalizersStore = new FakeClaimControllerStore();
    noFinalizersStore.seed(
      makeView({
        deletionTimestamp: FIXED_NOW_ISO,
        finalizers: [],
        leaseExpiresAt: BEFORE_NOW_ISO,
      }),
    );
    const noFinalizersController = makeController(noFinalizersStore);

    await noFinalizersController.reconcileClaim("claim-1");

    expect(conditionByType(onlyPatch(noFinalizersStore).patch.conditions, "Terminating")).toBe(
      undefined,
    );
  });

  test("preserves unknown condition types when updating lifecycle conditions", async () => {
    const store = new FakeClaimControllerStore();
    const unknownCondition = makeCondition("ThirdPartyReady", {
      status: "Unknown",
      observedGeneration: 19,
      reason: "external-controller",
      message: "owned elsewhere",
    });
    store.seed(makeView({ leaseExpiresAt: BEFORE_NOW_ISO, conditions: [unknownCondition] }));
    const controller = makeController(store);

    await controller.reconcileClaim("claim-1");

    const conditions = onlyPatch(store).patch.conditions;
    expect(conditions?.[0]).toEqual(unknownCondition);
    expect(conditionByType(conditions, "Active")?.reason).toBe("lease-expired");
    expect(conditionByType(conditions, "Expired")?.reason).toBe("lease-expired");
  });

  test("enqueueFromEntity ignores payload details and reconcile re-reads current store state", async () => {
    const store = new FakeClaimControllerStore();
    const staleView = makeView({ leaseExpiresAt: AFTER_NOW_ISO });
    const staleEntity = claimViewToEntity(staleView, () => FIXED_NOW_MS);
    store.seed(staleView);
    const queue = new KeyedWorkQueue({ now: () => FIXED_NOW_MS });
    const controller = makeController(store, { queue });

    controller.enqueueFromEntity(staleEntity);
    const queued = await queue.take();
    store.seed(makeView({ leaseExpiresAt: BEFORE_NOW_ISO }));
    const transition = await controller.reconcileClaim(queued.key);

    expect(queued.key).toBe("claim-1");
    expect(transition?.toPhase).toBe(ClaimStatus.Expired);
    expect(onlyPatch(store).patch.phase).toBe(ClaimStatus.Expired);
  });

  test("missing claims are successful no-ops", async () => {
    const store = new FakeClaimControllerStore();
    const controller = makeController(store);

    const transition = await controller.reconcileClaim("missing");

    expect(transition).toBeUndefined();
    expect(store.patches).toEqual([]);
  });

  test("invalid lease timestamps reject so worker retry can handle the claim", async () => {
    const store = new FakeClaimControllerStore();
    store.seed(makeView({ leaseExpiresAt: "not-a-timestamp" }));
    const controller = makeController(store);

    await expect(controller.reconcileClaim("claim-1")).rejects.toThrow(
      "invalid leaseExpiresAt for claim claim-1",
    );
    expect(store.patches).toEqual([]);
  });

  test("resync enqueues every claim entity id", async () => {
    const store = new FakeClaimControllerStore();
    store.seed(makeView({ id: "claim-1" }));
    store.seed(makeView({ id: "claim-2" }));
    const queue = new KeyedWorkQueue({ now: () => FIXED_NOW_MS });
    const controller = makeController(store, { queue });

    const count = await controller.resync();

    expect(count).toBe(2);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 0 });
    await expect(queue.take()).resolves.toEqual({ key: "claim-2", attempt: 0 });
  });
});

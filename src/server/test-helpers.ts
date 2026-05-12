/**
 * Shared test utilities for grove-server integration tests.
 *
 * Provides in-memory implementations of ClaimStore and ContentStore,
 * plus a factory to create a test app with all dependencies wired up.
 */

import type { Hono } from "hono";
import type { ContentStore, PutOptions } from "../core/cas.js";
import type { ClaimEntity } from "../core/entity.js";
import { claimToEntity, contributionToEntity } from "../core/entity.js";
import { NotFoundError, StateConflictError } from "../core/errors.js";
import type { EventBus } from "../core/event-bus.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import { type OwnerRef, ownerRefsEqual } from "../core/lifecycle-metadata.js";
import { LocalEventBus } from "../core/local-event-bus.js";
import type {
  AgentIdentity,
  Artifact,
  Claim,
  ClaimSpecRecord,
  ClaimStatusRecord,
  ClaimView,
  ContributionInput,
} from "../core/models.js";
import { claimToSpecRecord, claimToStatusRecord, claimViewToClaim } from "../core/models.js";
import type { OutcomeStore } from "../core/outcome.js";
import type {
  ActiveClaimFilter,
  ClaimQuery,
  ClaimStatusPatch,
  ClaimStore,
  ExpiredClaim,
  ExpireStaleOptions,
} from "../core/store.js";
import { ExpiryReason } from "../core/store.js";
import { InMemoryContributionStore } from "../core/testing.js";
import { WatchHub, type WatchHubOptions } from "../core/watch-hub.js";
import type { GoalSessionStore } from "../local/sqlite-goal-session-store.js";
import { NexusWatchSubscriber } from "../nexus/nexus-watch-subscriber.js";
import { createApp } from "./app.js";
import type { ServerDeps, ServerEnv } from "./deps.js";
import type { KeyRegistry } from "./middleware/namespace-auth.js";

// ---------------------------------------------------------------------------
// In-memory ContentStore (CAS)
// ---------------------------------------------------------------------------

export class InMemoryContentStore implements ContentStore {
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly metadata = new Map<string, { mediaType?: string }>();

  async put(data: Uint8Array, options?: PutOptions): Promise<string> {
    // Simple deterministic hash simulation using content bytes
    const { hash } = await import("blake3");
    const digest = hash(data).toString("hex");
    const contentHash = `blake3:${digest}`;
    this.blobs.set(contentHash, new Uint8Array(data));
    if (options?.mediaType) {
      this.metadata.set(contentHash, { mediaType: options.mediaType });
    }
    return contentHash;
  }

  async get(contentHash: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(contentHash);
  }

  async exists(contentHash: string): Promise<boolean> {
    return this.blobs.has(contentHash);
  }

  async existsMany(contentHashes: readonly string[]): Promise<ReadonlyMap<string, boolean>> {
    const result = new Map<string, boolean>();
    for (const hash of contentHashes) {
      result.set(hash, this.blobs.has(hash));
    }
    return result;
  }

  async delete(contentHash: string): Promise<boolean> {
    const had = this.blobs.has(contentHash);
    this.blobs.delete(contentHash);
    this.metadata.delete(contentHash);
    return had;
  }

  async putFile(_path: string, _options?: PutOptions): Promise<string> {
    throw new Error("putFile not implemented in test CAS");
  }

  async getToFile(_contentHash: string, _path: string): Promise<boolean> {
    throw new Error("getToFile not implemented in test CAS");
  }

  async stat(contentHash: string): Promise<Artifact | undefined> {
    const data = this.blobs.get(contentHash);
    if (!data) return undefined;
    const meta = this.metadata.get(contentHash);
    return {
      contentHash,
      sizeBytes: data.byteLength,
      mediaType: meta?.mediaType,
    };
  }

  close(): void {
    /* expected */
  }
}

// ---------------------------------------------------------------------------
// In-memory ClaimStore
// ---------------------------------------------------------------------------

export class InMemoryClaimStore implements ClaimStore {
  private readonly specs = new Map<string, ClaimSpecRecord>();
  private readonly statuses = new Map<string, ClaimStatusRecord>();

  private toClaim(view: ClaimView): Claim {
    return claimViewToClaim(view);
  }

  private viewFor(claimId: string): ClaimView | undefined {
    const spec = this.specs.get(claimId);
    const status = this.statuses.get(claimId);
    if (spec === undefined || status === undefined) return undefined;
    return { spec, status };
  }

  private allViews(): ClaimView[] {
    const views: ClaimView[] = [];
    for (const claimId of this.specs.keys()) {
      const view = this.viewFor(claimId);
      if (view !== undefined) views.push(view);
    }
    return views;
  }

  private putView(view: ClaimView): void {
    this.specs.set(view.spec.id, view.spec);
    this.statuses.set(view.status.id, view.status);
  }

  async putClaimSpec(spec: ClaimSpecRecord): Promise<ClaimView> {
    const existing = this.viewFor(spec.id);
    if (existing !== undefined) {
      const updated: ClaimView = {
        spec: {
          ...spec,
          createdAt: existing.spec.createdAt,
          generation: existing.spec.generation + 1,
        },
        status: existing.status,
      };
      this.putView(updated);
      return updated;
    }

    const now = new Date().toISOString();
    const createdAtMs = Date.parse(spec.createdAt);
    const leaseBaseMs = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
    const leaseDurationSec = spec.leaseDeadlineSec ?? 300;
    const view: ClaimView = {
      spec: { ...spec, generation: 1 },
      status: {
        id: spec.id,
        phase: "active",
        observedGeneration: 0,
        lastHeartbeatAt: now,
        leaseExpiresAt: new Date(leaseBaseMs + leaseDurationSec * 1000).toISOString(),
        conditions: [],
        lastTransitionAt: now,
        attemptCount: 0,
        revision: 1,
      },
    };
    this.putView(view);
    return view;
  }

  async getClaimView(claimId: string): Promise<ClaimView | undefined> {
    return this.viewFor(claimId);
  }

  async patchClaimStatus(claimId: string, patch: ClaimStatusPatch): Promise<ClaimView> {
    const view = this.viewFor(claimId);
    if (view === undefined) {
      throw new NotFoundError({
        resource: "Claim",
        identifier: claimId,
        message: `Claim ${claimId} does not exist`,
      });
    }

    const updated: ClaimView = {
      spec: view.spec,
      status: {
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
      },
    };
    this.putView(updated);
    return updated;
  }

  async createClaim(claim: Claim): Promise<Claim> {
    if (this.specs.has(claim.claimId)) {
      throw new StateConflictError({
        resource: "Claim",
        reason: "already exists",
        message: `Claim ${claim.claimId} already exists`,
      });
    }
    const claimWithRevision: Claim = { ...claim, revision: 1 };
    const view: ClaimView = {
      spec: { ...claimToSpecRecord(claimWithRevision), generation: 1 },
      status: {
        ...claimToStatusRecord(claimWithRevision),
        observedGeneration: 0,
        revision: 1,
      },
    };
    this.putView(view);
    return this.toClaim(view);
  }

  async claimOrRenew(claim: Claim): Promise<Claim> {
    // Check if same agent already has an active claim on this target
    for (const existingView of this.allViews()) {
      const existing = this.toClaim(existingView);
      if (existing.targetRef === claim.targetRef && existing.status === "active") {
        if (existing.agent.agentId === claim.agent.agentId) {
          // Renew: update lease and bump revision (matches the conformance
          // contract — SQLite + Nexus stores both increment revision on
          // every renewal, and watch fan-out depends on it to distinguish
          // create from renew).
          const renewedView: ClaimView = {
            spec: {
              ...existingView.spec,
              intentSummary: claim.intentSummary,
              generation: existingView.spec.generation + 1,
            },
            status: {
              ...existingView.status,
              lastHeartbeatAt: claim.heartbeatAt,
              leaseExpiresAt: claim.leaseExpiresAt,
              revision: existingView.status.revision + 1,
            },
          };
          this.putView(renewedView);
          return this.toClaim(renewedView);
        }
        throw new StateConflictError({
          resource: "Claim",
          reason: "target already has an active claim",
          message: `Target ${claim.targetRef} already has an active claim by another agent`,
        });
      }
    }
    const created: Claim = { ...claim, revision: 1 };
    this.putView({
      spec: { ...claimToSpecRecord(created), generation: 1 },
      status: {
        ...claimToStatusRecord(created),
        observedGeneration: 0,
        revision: 1,
      },
    });
    const view = this.viewFor(claim.claimId);
    if (view === undefined) {
      throw new Error(`Failed to create claim ${claim.claimId}`);
    }
    return this.toClaim(view);
  }

  async getClaim(claimId: string): Promise<Claim | undefined> {
    const view = this.viewFor(claimId);
    return view === undefined ? undefined : this.toClaim(view);
  }

  async heartbeat(claimId: string, leaseDurationMs?: number): Promise<Claim> {
    const view = this.viewFor(claimId);
    if (view === undefined) {
      throw new NotFoundError({
        resource: "Claim",
        identifier: claimId,
        message: `Claim ${claimId} does not exist`,
      });
    }
    const claim = this.toClaim(view);
    if (claim.status !== "active") {
      throw new StateConflictError({
        resource: "Claim",
        reason: "not active",
        message: `Claim ${claimId} is not active`,
      });
    }
    const now = new Date();
    const updated: ClaimView = {
      spec: view.spec,
      status: {
        ...view.status,
        lastHeartbeatAt: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + (leaseDurationMs ?? 300_000)).toISOString(),
        revision: view.status.revision + 1,
      },
    };
    this.putView(updated);
    return this.toClaim(updated);
  }

  async release(claimId: string): Promise<Claim> {
    const view = this.viewFor(claimId);
    if (view === undefined) {
      throw new NotFoundError({
        resource: "Claim",
        identifier: claimId,
        message: `Claim ${claimId} does not exist`,
      });
    }
    const claim = this.toClaim(view);
    if (claim.status !== "active") {
      throw new StateConflictError({
        resource: "Claim",
        reason: "not active",
        message: `Claim ${claimId} is not active`,
      });
    }
    const now = new Date().toISOString();
    const updated: ClaimView = {
      spec: view.spec,
      status: {
        ...view.status,
        phase: "released",
        lastTransitionAt: now,
        revision: view.status.revision + 1,
      },
    };
    this.putView(updated);
    return this.toClaim(updated);
  }

  async releaseOwnedBy(ownerRef: OwnerRef): Promise<number> {
    let count = 0;
    for (const claim of this.allViews().map((view) => this.toClaim(view))) {
      if (claim.status === "active" && ownerRefsEqual(claim.ownerRef, ownerRef)) {
        await this.release(claim.claimId);
        count++;
      }
    }
    return count;
  }

  async complete(claimId: string): Promise<Claim> {
    const view = this.viewFor(claimId);
    if (view === undefined) {
      throw new NotFoundError({
        resource: "Claim",
        identifier: claimId,
        message: `Claim ${claimId} does not exist`,
      });
    }
    const claim = this.toClaim(view);
    if (claim.status !== "active") {
      throw new StateConflictError({
        resource: "Claim",
        reason: "not active",
        message: `Claim ${claimId} is not active`,
      });
    }
    const now = new Date().toISOString();
    const updated: ClaimView = {
      spec: view.spec,
      status: {
        ...view.status,
        phase: "completed",
        lastTransitionAt: now,
        revision: view.status.revision + 1,
      },
    };
    this.putView(updated);
    return this.toClaim(updated);
  }

  async deleteTerminalOwnedBy(ownerRef: OwnerRef): Promise<number> {
    let count = 0;
    for (const claim of this.allViews().map((view) => this.toClaim(view))) {
      if (claim.status !== "active" && ownerRefsEqual(claim.ownerRef, ownerRef)) {
        this.specs.delete(claim.claimId);
        this.statuses.delete(claim.claimId);
        count++;
      }
    }
    return count;
  }

  async expireStale(options?: ExpireStaleOptions): Promise<readonly ExpiredClaim[]> {
    const now = Date.now();
    const expired: ExpiredClaim[] = [];
    for (const view of this.allViews()) {
      const claim = this.toClaim(view);
      if (claim.status === "active" && Date.parse(claim.leaseExpiresAt) < now) {
        const updated: ClaimView = {
          spec: view.spec,
          status: {
            ...view.status,
            phase: "expired",
            lastTransitionAt: new Date().toISOString(),
            revision: view.status.revision + 1,
          },
        };
        this.putView(updated);
        expired.push({ claim: this.toClaim(updated), reason: ExpiryReason.LeaseExpired });
      }
    }
    if (options?.stallThresholdMs !== undefined) {
      const stallCutoff = now - options.stallThresholdMs;
      for (const view of this.allViews()) {
        const claim = this.toClaim(view);
        if (claim.status === "active" && Date.parse(claim.heartbeatAt) < stallCutoff) {
          const updated: ClaimView = {
            spec: view.spec,
            status: {
              ...view.status,
              phase: "expired",
              lastTransitionAt: new Date().toISOString(),
              revision: view.status.revision + 1,
            },
          };
          this.putView(updated);
          expired.push({ claim: this.toClaim(updated), reason: ExpiryReason.Stalled });
        }
      }
    }
    return expired;
  }

  async activeClaims(targetRef?: string): Promise<readonly Claim[]> {
    const active = this.allViews()
      .map((view) => this.toClaim(view))
      .filter((c) => c.status === "active");
    if (targetRef) return active.filter((c) => c.targetRef === targetRef);
    return active;
  }

  async listClaims(query?: ClaimQuery): Promise<readonly Claim[]> {
    let results = this.allViews().map((view) => this.toClaim(view));
    if (query?.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      results = results.filter((c) => statuses.includes(c.status));
    }
    if (query?.agentId) {
      results = results.filter((c) => c.agent.agentId === query.agentId);
    }
    if (query?.targetRef) {
      results = results.filter((c) => c.targetRef === query.targetRef);
    }
    if (query?.ownerRef !== undefined) {
      results = results.filter((c) => ownerRefsEqual(c.ownerRef, query.ownerRef));
    }
    return results;
  }

  async cleanCompleted(_retentionMs: number): Promise<number> {
    return 0;
  }

  async countActiveClaims(filter?: ActiveClaimFilter): Promise<number> {
    let active = this.allViews()
      .map((view) => this.toClaim(view))
      .filter((c) => c.status === "active");
    if (filter?.agentId) active = active.filter((c) => c.agent.agentId === filter.agentId);
    if (filter?.targetRef) active = active.filter((c) => c.targetRef === filter.targetRef);
    return active.length;
  }

  async detectStalled(stallTimeoutMs: number): Promise<readonly Claim[]> {
    const now = Date.now();
    return this.allViews()
      .map((view) => this.toClaim(view))
      .filter(
        (c) =>
          c.status === "active" &&
          Date.parse(c.leaseExpiresAt) >= now &&
          Date.parse(c.heartbeatAt) < now - stallTimeoutMs,
      );
  }

  async listEntities(query?: ClaimQuery): Promise<readonly ClaimEntity[]> {
    let results = this.allViews().map((view) => this.toClaim(view));
    if (query?.agentId) results = results.filter((c) => c.agent.agentId === query.agentId);
    if (query?.targetRef) results = results.filter((c) => c.targetRef === query.targetRef);
    if (query?.ownerRef !== undefined) {
      results = results.filter((c) => ownerRefsEqual(c.ownerRef, query.ownerRef));
    }
    // Filter on effective (lease-aware) phase after projection.
    const entities = results.map((c) => claimToEntity(c));
    if (query?.status === undefined) return entities;
    const wanted = Array.isArray(query.status) ? new Set(query.status) : new Set([query.status]);
    return entities.filter((e) => wanted.has(e.status.phase));
  }

  close(): void {
    /* expected */
  }
}

// ---------------------------------------------------------------------------
// Test auth constants
// ---------------------------------------------------------------------------

export const TEST_NAMESPACE_KEY: string = `grv_${"b".repeat(64)}`;
export const TEST_NAMESPACE: string = "test-uuid/test-worktree";
export const TEST_AUTH_HEADERS: Record<string, string> = {
  Authorization: `Bearer ${TEST_NAMESPACE_KEY}`,
};

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

export interface TestContext {
  app: Hono<ServerEnv>;
  deps: ServerDeps;
  contributionStore: InMemoryContributionStore;
  claimStore: InMemoryClaimStore;
  cas: InMemoryContentStore;
  watchHub: WatchHub;
  watchEventBus: EventBus;
}

export interface CreateTestAppOptions {
  readonly watchHubOptions?: WatchHubOptions;
  readonly eventBus?: EventBus;
  readonly outcomeStore?: OutcomeStore | undefined;
  readonly goalSessionStore?: GoalSessionStore;
}

/** Create a test app with fresh in-memory stores. */
export function createTestApp(opts: CreateTestAppOptions = {}): TestContext {
  const contributionStore = new InMemoryContributionStore();
  const claimStore = new InMemoryClaimStore();
  const cas = new InMemoryContentStore();
  const frontier = new DefaultFrontierCalculator(contributionStore);
  const watchHub = new WatchHub(opts.watchHubOptions);

  // Cross-process subscriber that fans `entity.changed` envelopes from the
  // shared event-bus into the WatchHub. fetchEntity uses the same in-memory
  // stores so tests can simulate out-of-band writes (#292 T23).
  const watchEventBus = opts.eventBus ?? new LocalEventBus();
  const watchSubscriber = new NexusWatchSubscriber({
    bus: watchEventBus,
    hub: watchHub,
    // Pin a stable instanceId distinct from the default process id so the
    // cross-process integration test (#292 T23) can publish with a different
    // id and exercise the cross-process branch — instead of being filtered
    // out as a self-emitted envelope.
    instanceId: "test-server-proc",
    fetchEntity: async (kind, namespace, id) => {
      if (kind === "Contribution") {
        const c = await contributionStore.get(id);
        if (!c) throw new Error(`Contribution ${id} not found`);
        return contributionToEntity(c, namespace);
      }
      if (kind === "Claim") {
        const c = await claimStore.getClaim(id);
        if (!c) throw new Error(`Claim ${id} not found`);
        return claimToEntity(c, () => Date.now(), namespace);
      }
      throw new Error(`Unsupported kind: ${kind}`);
    },
  });
  watchSubscriber.start();

  const deps: ServerDeps = {
    contributionStore,
    claimStore,
    cas,
    frontier,
    goalSessionStore: opts.goalSessionStore,
    watchHub,
    watchSubscriber,
    ...(opts.outcomeStore !== undefined ? { outcomeStore: opts.outcomeStore } : {}),
  };
  const registry: KeyRegistry = new Map([[TEST_NAMESPACE_KEY, TEST_NAMESPACE]]);
  const app = createApp(deps, registry);

  return { app, deps, contributionStore, claimStore, cas, watchHub, watchEventBus };
}

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

const DEFAULT_AGENT: AgentIdentity = {
  agentId: "test-agent-001",
  agentName: "Test Agent",
  provider: "test",
  model: "test-model",
};

/** Create a minimal valid contribution manifest body for POST. */
export function makeManifestBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "work",
    mode: "evaluation",
    summary: "Test contribution",
    agent: { ...DEFAULT_AGENT },
    tags: [],
    relations: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a ContributionInput for directly seeding the store. */
export function makeContributionInput(overrides?: Partial<ContributionInput>): ContributionInput {
  return {
    kind: "work",
    mode: "evaluation",
    summary: "Test contribution",
    artifacts: {},
    relations: [],
    tags: [],
    agent: { ...DEFAULT_AGENT },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a minimal valid claim body for POST /api/claims. */
export function makeClaimBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    targetRef: "task-001",
    agent: { ...DEFAULT_AGENT },
    intentSummary: "Working on task",
    ...overrides,
  };
}

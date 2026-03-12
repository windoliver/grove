/**
 * Shared test utilities for grove-server integration tests.
 *
 * Provides in-memory implementations of ClaimStore and ContentStore,
 * plus a factory to create a test app with all dependencies wired up.
 */

import type { Hono } from "hono";
import type { ContentStore, PutOptions } from "../core/cas.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import type { AgentIdentity, Artifact, Claim, ContributionInput } from "../core/models.js";
import type {
  ActiveClaimFilter,
  ClaimQuery,
  ClaimStore,
  ExpiredClaim,
  ExpireStaleOptions,
} from "../core/store.js";
import { InMemoryContributionStore } from "../core/testing.js";
import { createApp } from "./app.js";
import type { ServerDeps, ServerEnv } from "./deps.js";

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

  close(): void {}
}

// ---------------------------------------------------------------------------
// In-memory ClaimStore
// ---------------------------------------------------------------------------

export class InMemoryClaimStore implements ClaimStore {
  private readonly claims = new Map<string, Claim>();

  async createClaim(claim: Claim): Promise<Claim> {
    if (this.claims.has(claim.claimId)) {
      throw new Error(`Claim ${claim.claimId} already exists`);
    }
    this.claims.set(claim.claimId, claim);
    return claim;
  }

  async claimOrRenew(claim: Claim): Promise<Claim> {
    // Check if same agent already has an active claim on this target
    for (const existing of this.claims.values()) {
      if (existing.targetRef === claim.targetRef && existing.status === "active") {
        if (existing.agent.agentId === claim.agent.agentId) {
          // Renew: update lease
          const renewed: Claim = {
            ...existing,
            heartbeatAt: claim.heartbeatAt,
            leaseExpiresAt: claim.leaseExpiresAt,
            intentSummary: claim.intentSummary,
          };
          this.claims.set(existing.claimId, renewed);
          return renewed;
        }
        throw new Error(`Target ${claim.targetRef} already has an active claim by another agent`);
      }
    }
    this.claims.set(claim.claimId, claim);
    return claim;
  }

  async getClaim(claimId: string): Promise<Claim | undefined> {
    return this.claims.get(claimId);
  }

  async heartbeat(claimId: string, leaseDurationMs?: number): Promise<Claim> {
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`Claim ${claimId} does not exist`);
    if (claim.status !== "active") throw new Error(`Claim ${claimId} is not active`);
    const now = new Date();
    const updated: Claim = {
      ...claim,
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + (leaseDurationMs ?? 300_000)).toISOString(),
    };
    this.claims.set(claimId, updated);
    return updated;
  }

  async release(claimId: string): Promise<Claim> {
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`Claim ${claimId} does not exist`);
    if (claim.status !== "active") throw new Error(`Claim ${claimId} is not active`);
    const updated: Claim = { ...claim, status: "released" };
    this.claims.set(claimId, updated);
    return updated;
  }

  async complete(claimId: string): Promise<Claim> {
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`Claim ${claimId} does not exist`);
    if (claim.status !== "active") throw new Error(`Claim ${claimId} is not active`);
    const updated: Claim = { ...claim, status: "completed" };
    this.claims.set(claimId, updated);
    return updated;
  }

  async expireStale(_options?: ExpireStaleOptions): Promise<readonly ExpiredClaim[]> {
    const now = Date.now();
    const expired: ExpiredClaim[] = [];
    for (const claim of this.claims.values()) {
      if (claim.status === "active" && Date.parse(claim.leaseExpiresAt) < now) {
        const updated: Claim = { ...claim, status: "expired" };
        this.claims.set(claim.claimId, updated);
        expired.push({ claim: updated, reason: "lease_expired" });
      }
    }
    return expired;
  }

  async activeClaims(targetRef?: string): Promise<readonly Claim[]> {
    const active = [...this.claims.values()].filter((c) => c.status === "active");
    if (targetRef) return active.filter((c) => c.targetRef === targetRef);
    return active;
  }

  async listClaims(query?: ClaimQuery): Promise<readonly Claim[]> {
    let results = [...this.claims.values()];
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
    return results;
  }

  async cleanCompleted(_retentionMs: number): Promise<number> {
    return 0;
  }

  async countActiveClaims(filter?: ActiveClaimFilter): Promise<number> {
    let active = [...this.claims.values()].filter((c) => c.status === "active");
    if (filter?.agentId) active = active.filter((c) => c.agent.agentId === filter.agentId);
    if (filter?.targetRef) active = active.filter((c) => c.targetRef === filter.targetRef);
    return active.length;
  }

  async detectStalled(_stallTimeoutMs: number): Promise<readonly Claim[]> {
    return [];
  }

  close(): void {}
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

export interface TestContext {
  app: Hono<ServerEnv>;
  deps: ServerDeps;
  contributionStore: InMemoryContributionStore;
  claimStore: InMemoryClaimStore;
  cas: InMemoryContentStore;
}

/** Create a test app with fresh in-memory stores. */
export function createTestApp(): TestContext {
  const contributionStore = new InMemoryContributionStore();
  const claimStore = new InMemoryClaimStore();
  const cas = new InMemoryContentStore();
  const frontier = new DefaultFrontierCalculator(contributionStore);

  const deps: ServerDeps = { contributionStore, claimStore, cas, frontier };
  const app = createApp(deps);

  return { app, deps, contributionStore, claimStore, cas };
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

/**
 * Shared test utilities for operation tests.
 *
 * Provides OperationDeps backed by real SQLite and filesystem CAS,
 * plus a lightweight in-memory ContributionStore for routing tests.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsCas } from "../../local/fs-cas.js";
import { SqliteBountyStore } from "../../local/sqlite-bounty-store.js";
import {
  initSqliteDb,
  SqliteClaimStore,
  SqliteContributionStore,
  SqliteIdempotencyStore,
} from "../../local/sqlite-store.js";
import { LocalWorkspaceManager } from "../../local/workspace.js";
import type { ContentStore } from "../cas.js";
import type { GroveContract } from "../contract.js";
import type { ContributionEntity } from "../entity.js";
import { contributionToEntity } from "../entity.js";
import { DefaultFrontierCalculator } from "../frontier.js";
import type { HandoffStore } from "../handoff.js";
import { InMemoryCreditsService } from "../in-memory-credits.js";
import { InMemoryHandoffStore } from "../in-memory-handoff-store.js";
import type { Contribution } from "../models.js";
import type { OutcomeStore } from "../outcome.js";
import type { ContributionQuery, ContributionStore } from "../store.js";
import type { OperationDeps } from "./deps.js";

/**
 * Minimal in-memory ContributionStore for unit tests that don't need SQLite.
 * Suitable for routing and event-bus tests where persistence is not required.
 */
export function makeInMemoryContributionStore(items: Contribution[] = []): ContributionStore {
  const store = [...items];
  return {
    storeIdentity: undefined,
    put: async (c: Contribution) => {
      if (!store.find((x) => x.cid === c.cid)) store.push(c);
    },
    putMany: async (cs: readonly Contribution[]) => {
      for (const c of cs) {
        if (!store.find((x) => x.cid === c.cid)) store.push(c);
      }
    },
    get: async (cid: string) => store.find((c) => c.cid === cid),
    getMany: async (cids: readonly string[]) => {
      const cidSet = new Set(cids);
      const result = new Map<string, Contribution>();
      for (const c of store) {
        if (cidSet.has(c.cid)) result.set(c.cid, c);
      }
      return result;
    },
    list: async (query?) => {
      let result = [...store];
      if (query?.kind) result = result.filter((c) => c.kind === query.kind);
      if (query?.mode) result = result.filter((c) => c.mode === query.mode);
      if (query?.agentId) result = result.filter((c) => c.agent.agentId === query.agentId);
      if (query?.limit) result = result.slice(0, query.limit);
      return result;
    },
    children: async () => [],
    ancestors: async () => [],
    relationsOf: async () => [],
    relatedTo: async () => [],
    search: async () => [],
    findExisting: async () => [],
    count: async (query?) => {
      let result = [...store];
      if (query?.kind) result = result.filter((c) => c.kind === query.kind);
      if (query?.mode) result = result.filter((c) => c.mode === query.mode);
      return result.length;
    },
    countSince: async (query) =>
      store.filter((c) => {
        if (query.agentId && c.agent.agentId !== query.agentId) return false;
        return c.createdAt >= query.since;
      }).length,
    thread: async () => [],
    incomingSources: async () => [],
    replyCounts: async () => new Map(),
    hotThreads: async () => [],
    listEntities: async (query?: ContributionQuery): Promise<readonly ContributionEntity[]> => {
      let result = [...store];
      if (query?.kind) result = result.filter((c) => c.kind === query.kind);
      if (query?.mode) result = result.filter((c) => c.mode === query.mode);
      if (query?.agentId) result = result.filter((c) => c.agent.agentId === query.agentId);
      if (query?.limit) result = result.slice(0, query.limit);
      return result.map(contributionToEntity);
    },
    close: () => {
      /* expected */
    },
  };
}

/** OperationDeps with all fields guaranteed present (for tests). */
export type FullOperationDeps = {
  readonly [K in keyof Required<OperationDeps>]: NonNullable<OperationDeps[K]>;
};

/** A test OperationDeps instance with cleanup function. */
export interface TestOperationDeps {
  readonly deps: FullOperationDeps;
  readonly tempDir: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Create OperationDeps backed by real SQLite and filesystem CAS.
 * Call cleanup() in afterEach to remove the temp directory.
 */
export async function createTestOperationDeps(): Promise<TestOperationDeps> {
  const tempDir = await mkdtemp(join(tmpdir(), "grove-ops-test-"));
  const dbPath = join(tempDir, "test.db");
  const casPath = join(tempDir, "cas");
  const groveRoot = tempDir;

  const db = initSqliteDb(dbPath);
  const contributionStore = new SqliteContributionStore(db);
  const claimStore = new SqliteClaimStore(db);
  const bountyStore = new SqliteBountyStore(db);
  const creditsService = new InMemoryCreditsService();
  const cas = new FsCas(casPath);
  const frontier = new DefaultFrontierCalculator(contributionStore);
  const workspace = new LocalWorkspaceManager({
    groveRoot,
    db,
    contributionStore,
    cas,
  });

  const handoffStore = new InMemoryHandoffStore();
  const idempotencyStore = new SqliteIdempotencyStore(db);

  const deps: FullOperationDeps = {
    contributionStore,
    claimStore,
    bountyStore,
    creditsService,
    cas,
    frontier,
    workspace,
    handoffStore,
    idempotencyStore,
    contract: undefined as unknown as GroveContract,
    outcomeStore: undefined as unknown as OutcomeStore,
    onContributionWrite: () => {
      /* no-op for tests */
    },
    onContributionWritten: () => {
      /* no-op for tests */
    },
    eventBus: undefined as unknown as NonNullable<OperationDeps["eventBus"]>,
    topologyRouter: undefined as unknown as NonNullable<OperationDeps["topologyRouter"]>,
    hookRunner: undefined as unknown as NonNullable<OperationDeps["hookRunner"]>,
    hookCwd: undefined as unknown as string,
    deadlineWatcher: undefined as unknown as NonNullable<OperationDeps["deadlineWatcher"]>,
  };

  return {
    deps,
    tempDir,
    cleanup: async () => {
      workspace.close();
      db.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

/**
 * Create a mock HandoffStore with sensible no-op defaults.
 *
 * Override specific methods for test assertions. When the HandoffStore
 * interface changes (e.g., adding markSeen/markAcked), update this one
 * factory instead of N inline mocks across test files.
 */
export function createMockHandoffStore(overrides?: Partial<HandoffStore>): HandoffStore {
  return {
    create: async () => ({
      handoffId: "mock",
      sourceCid: "",
      fromRole: "",
      toRole: "",
      status: "pending_pickup" as const,
      requiresReply: false,
      createdAt: "",
    }),
    get: async () => undefined,
    list: async () => [],
    markDelivered: async () => undefined,
    markReplied: async () => undefined,
    markSeen: async () => undefined,
    markAcked: async () => undefined,
    expireStale: async () => [],
    countPending: async () => 0,
    close: () => undefined,
    ...overrides,
  } as HandoffStore;
}

/**
 * Store test content in CAS and return its hash.
 */
export async function storeTestContent(cas: ContentStore, content: string): Promise<string> {
  return cas.put(new TextEncoder().encode(content));
}

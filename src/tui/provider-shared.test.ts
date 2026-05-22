/**
 * Tests for shared provider functions.
 */

import { describe, expect, test } from "bun:test";
import type { FrontierCalculator } from "../core/frontier.js";
import type { Contribution } from "../core/models.js";
import type { OutcomeStore } from "../core/outcome.js";
import type { ClaimStore, ContributionStore, ThreadNode } from "../core/store.js";
import {
  activityFromStore,
  archiveSessionHttp,
  claimsFromStore,
  contributionDetailFromStore,
  contributionsForCidsInOrder,
  dagFromStore,
  dashboardFromStores,
  diffArtifactsFromBuffers,
  HttpConflictError,
  outcomeStatsFromStore,
  setGoalHttp,
} from "./provider-shared.js";
import { __test_only_mintToken } from "./safety/testing.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeContribution(overrides: Partial<Contribution> = {}): Contribution {
  return {
    cid: "blake3:abc123",
    manifestVersion: 1,
    kind: "work",
    mode: "evaluation",
    agent: { agentId: "agent-1" },
    summary: "Test contribution",
    tags: [],
    artifacts: {},
    relations: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockContributionStore(contributions: Contribution[] = []): ContributionStore {
  return {
    storeIdentity: "mock-store",
    get: async (cid: string) => contributions.find((c) => c.cid === cid),
    getMany: async (cids: readonly string[]) => {
      const result = new Map<string, Contribution>();
      for (const cid of cids) {
        const contribution = contributions.find((c) => c.cid === cid);
        if (contribution !== undefined) result.set(cid, contribution);
      }
      return result;
    },
    put: async () => {
      /* noop */
    },
    putMany: async () => {
      /* noop */
    },
    list: async (query?: { limit?: number; offset?: number }) => {
      const start = query?.offset ?? 0;
      const limit = query?.limit ?? contributions.length;
      return contributions.slice(start, start + limit);
    },
    ancestors: async () => [],
    children: async (_cid: string) => [] as Contribution[],
    count: async () => contributions.length,
    thread: async (): Promise<readonly ThreadNode[]> => [],
    hotThreads: async () => [],
    search: async () => [],
    relationsOf: async () => [],
    relatedTo: async () => [],
    findExisting: async () => undefined,
    replyCounts: async () => new Map(),
    close: () => {
      /* noop */
    },
  } as unknown as ContributionStore;
}

function makeMockClaimStore(): ClaimStore {
  return {
    storeIdentity: "mock-claims",
    putClaimSpec: async () => {
      throw new Error("putClaimSpec not implemented by test mock");
    },
    getClaimView: async () => undefined,
    patchClaimStatus: async () => {
      throw new Error("patchClaimStatus not implemented by test mock");
    },
    createClaim: async (claim) => claim,
    claimOrRenew: async (claim) => claim,
    getClaim: async () => undefined,
    heartbeat: async (id) => ({
      claimId: id,
      targetRef: "t",
      agent: { agentId: "a" },
      status: "active",
      intentSummary: "",
      createdAt: "",
      heartbeatAt: "",
      leaseExpiresAt: "",
    }),
    release: async (id) => ({
      claimId: id,
      targetRef: "t",
      agent: { agentId: "a" },
      status: "released",
      intentSummary: "",
      createdAt: "",
      heartbeatAt: "",
      leaseExpiresAt: "",
    }),
    releaseOwnedBy: async () => 0,
    complete: async (id) => ({
      claimId: id,
      targetRef: "t",
      agent: { agentId: "a" },
      status: "completed",
      intentSummary: "",
      createdAt: "",
      heartbeatAt: "",
      leaseExpiresAt: "",
    }),
    deleteTerminalOwnedBy: async () => 0,
    expireStale: async () => [],
    activeClaims: async () => [],
    listClaims: async () => [],
    cleanCompleted: async () => 0,
    countActiveClaims: async () => 0,
    detectStalled: async () => [],
    listEntities: async () => [],
    close: () => {
      /* noop */
    },
  };
}

function makeMockFrontier(): FrontierCalculator {
  return {
    compute: async () => ({
      byRecency: [],
      byAdoption: [],
      byMetric: {},
      byReviewScore: [],
      byReproduction: [],
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("provider-shared", () => {
  describe("contributionsForCidsInOrder", () => {
    test("batch-loads contributions and preserves requested CID order", async () => {
      const first = makeContribution({ cid: "blake3:first" });
      const second = makeContribution({ cid: "blake3:second" });
      const third = makeContribution({ cid: "blake3:third" });
      const store = makeMockContributionStore([first, second, third]);

      const result = await contributionsForCidsInOrder(store, [
        "blake3:third",
        "blake3:first",
        "blake3:missing",
        "blake3:second",
      ]);

      expect(result.map((c) => c.cid)).toEqual(["blake3:third", "blake3:first", "blake3:second"]);
    });
  });

  describe("dashboardFromStores", () => {
    test("returns structured dashboard data", async () => {
      const store = makeMockContributionStore([makeContribution()]);
      const claims = makeMockClaimStore();
      const frontier = makeMockFrontier();

      const result = await dashboardFromStores(store, claims, frontier, "test-grove", "local");

      expect(result.metadata.name).toBe("test-grove");
      expect(result.metadata.mode).toBe("local");
      expect(result.metadata.contributionCount).toBe(1);
      expect(result.metadata.activeClaimCount).toBe(0);
      expect(Array.isArray(result.activeClaims)).toBe(true);
      expect(Array.isArray(result.recentContributions)).toBe(true);
      expect(result.frontierSummary).toBeDefined();
    });
  });

  describe("contributionDetailFromStore", () => {
    test("returns detail for existing contribution", async () => {
      const c = makeContribution({ cid: "blake3:existing" });
      const store = makeMockContributionStore([c]);

      const detail = await contributionDetailFromStore(store, "blake3:existing");

      expect(detail).toBeDefined();
      expect(detail?.contribution.cid).toBe("blake3:existing");
      expect(Array.isArray(detail?.ancestors)).toBe(true);
      expect(Array.isArray(detail?.children)).toBe(true);
      expect(Array.isArray(detail?.thread)).toBe(true);
    });

    test("returns undefined for non-existent CID", async () => {
      const store = makeMockContributionStore([]);
      const detail = await contributionDetailFromStore(store, "blake3:nonexistent");
      expect(detail).toBeUndefined();
    });
  });

  describe("claimsFromStore", () => {
    test("returns active claims by default", async () => {
      const claims = makeMockClaimStore();
      const result = await claimsFromStore(claims);
      expect(Array.isArray(result)).toBe(true);
    });

    test("filters by agentId when provided", async () => {
      const claims = makeMockClaimStore();
      const result = await claimsFromStore(claims, { agentId: "agent-1", status: "active" });
      expect(Array.isArray(result)).toBe(true);
    });

    test("returns all claims when status is not active", async () => {
      const claims = makeMockClaimStore();
      const result = await claimsFromStore(claims, { status: "all" });
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("activityFromStore", () => {
    test("returns contributions as activity", async () => {
      const c = makeContribution();
      const store = makeMockContributionStore([c]);

      const result = await activityFromStore(store);
      expect(result.length).toBe(1);
    });

    test("applies limit", async () => {
      const contributions = Array.from({ length: 10 }, (_, i) =>
        makeContribution({ cid: `blake3:c${i}` }),
      );
      const store = makeMockContributionStore(contributions);

      const result = await activityFromStore(store, { limit: 5 });
      expect(result.length).toBe(5);
    });
  });

  describe("dagFromStore", () => {
    test("returns all contributions when no rootCid", async () => {
      const contributions = [
        makeContribution({ cid: "blake3:a" }),
        makeContribution({ cid: "blake3:b" }),
      ];
      const store = makeMockContributionStore(contributions);

      const result = await dagFromStore(store);
      expect(result.contributions.length).toBe(2);
    });

    test("returns BFS traversal from rootCid", async () => {
      const root = makeContribution({ cid: "blake3:root" });
      const store = makeMockContributionStore([root]);

      const result = await dagFromStore(store, "blake3:root");
      expect(result.contributions.length).toBe(1);
      expect(result.contributions[0]?.cid).toBe("blake3:root");
    });

    test("returns empty when rootCid not found", async () => {
      const store = makeMockContributionStore([]);
      const result = await dagFromStore(store, "blake3:missing");
      expect(result.contributions.length).toBe(0);
    });
  });

  describe("outcomeStatsFromStore", () => {
    test("returns zero stats when no outcome store", async () => {
      const result = await outcomeStatsFromStore(undefined);
      expect(result.totalContributions).toBe(0);
      expect(result.acceptanceRate).toBe(0);
    });

    test("returns stats from outcome store", async () => {
      const outcomes: OutcomeStore = {
        set: async () => ({
          cid: "",
          status: "accepted",
          evaluatedBy: "agent-a",
          evaluatedAt: "",
          revision: 1,
        }),
        get: async () => undefined,
        getBatch: async () => new Map(),
        list: async () => [],
        getStats: async () => ({
          total: 10,
          accepted: 7,
          rejected: 2,
          crashed: 1,
          invalidated: 0,
          acceptanceRate: 0.7,
        }),
        close: () => {
          /* noop */
        },
      };

      const result = await outcomeStatsFromStore(outcomes);
      expect(result.totalContributions).toBe(10);
      expect(result.outcomeBreakdown.accepted).toBe(7);
      expect(result.acceptanceRate).toBe(0.7);
    });
  });

  describe("diffArtifactsFromBuffers", () => {
    test("converts buffers to strings", () => {
      const parent = Buffer.from("hello");
      const child = Buffer.from("world");
      const result = diffArtifactsFromBuffers(parent, child);
      expect(result.parent).toBe("hello");
      expect(result.child).toBe("world");
    });
  });

  describe("HttpConflictError", () => {
    // C6 (#304) T11 critical item A: dangerous HTTP helpers must throw a
    // structured HttpConflictError on 409 so the ConfirmAndMutateProvider's
    // retry loop can bump its snapshot RV from `current` and re-open.

    const ORIGINAL_FETCH = globalThis.fetch;

    function withMockFetch(responder: (input: string, init?: RequestInit) => Response): void {
      globalThis.fetch = (async (input: unknown, init?: unknown) =>
        responder(String(input), init as RequestInit | undefined)) as typeof globalThis.fetch;
    }

    function restoreFetch(): void {
      globalThis.fetch = ORIGINAL_FETCH;
    }

    test("archiveSessionHttp parses 409 body into HttpConflictError.current", async () => {
      withMockFetch(
        () =>
          new Response(
            JSON.stringify({
              error: {
                code: "CONFLICT",
                message: "session changed",
                current: { resourceVersion: "42", generation: 7 },
              },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
      );
      try {
        const token = __test_only_mintToken("AgentSession", "sess-1", "1");
        await expect(archiveSessionHttp(token, "http://x")).rejects.toMatchObject({
          name: "HttpConflictError",
          status: 409,
          current: { resourceVersion: "42", generation: 7 },
        });
      } finally {
        restoreFetch();
      }
    });

    test("setGoalHttp parses 409 body into HttpConflictError.current", async () => {
      withMockFetch(
        () =>
          new Response(
            JSON.stringify({
              error: {
                code: "CONFLICT",
                message: "goal changed",
                current: { resourceVersion: "9", generation: 2 },
              },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
      );
      try {
        const token = __test_only_mintToken("Goal", "goal", "1");
        await expect(setGoalHttp(token, "http://x", "do thing", [])).rejects.toMatchObject({
          name: "HttpConflictError",
          status: 409,
          current: { resourceVersion: "9", generation: 2 },
        });
      } finally {
        restoreFetch();
      }
    });

    test("falls back to safe defaults when 409 body is unparseable", async () => {
      withMockFetch(() => new Response("not json", { status: 409 }));
      try {
        const token = __test_only_mintToken("AgentSession", "sess-1", "1");
        const err = await archiveSessionHttp(token, "http://x").catch((e) => e);
        expect(err).toBeInstanceOf(HttpConflictError);
        expect(err.status).toBe(409);
        expect(err.current.resourceVersion).toBe("?");
        expect(err.current.generation).toBe(0);
      } finally {
        restoreFetch();
      }
    });

    test("non-409 errors stay as plain Error", async () => {
      withMockFetch(() => new Response("server error", { status: 500 }));
      try {
        const token = __test_only_mintToken("AgentSession", "sess-1", "1");
        const err = await archiveSessionHttp(token, "http://x").catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(HttpConflictError);
      } finally {
        restoreFetch();
      }
    });
  });
});

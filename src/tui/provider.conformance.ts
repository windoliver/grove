/**
 * Conformance test suite for TuiDataProvider implementations.
 *
 * Run the same behavioral tests against both LocalDataProvider
 * and RemoteDataProvider to ensure consistent behavior.
 */

import { describe, expect, test } from "bun:test";
import type { TuiDataProvider, TuiGoalProvider, TuiSessionProvider } from "./provider.js";
import { isGoalProvider, isSessionProvider } from "./provider.js";

/** Factory function that creates a provider with test data pre-loaded. */
export type ProviderFactory = () => Promise<{
  provider: TuiDataProvider;
  /** At least one contribution CID that exists in the test data. */
  testCid: string;
  cleanup: () => void;
}>;

/**
 * Run conformance tests against a TuiDataProvider implementation.
 *
 * The factory must return a provider with at least:
 * - 3+ contributions (at least 1 work, 1 review)
 * - 1+ active claim
 */
export function runProviderConformanceTests(suiteName: string, factory: ProviderFactory): void {
  describe(`${suiteName} conformance`, () => {
    test("getDashboard returns structured data", async () => {
      const { provider, cleanup } = await factory();
      try {
        const dashboard = await provider.getDashboard();
        expect(dashboard.metadata).toBeDefined();
        expect(typeof dashboard.metadata.name).toBe("string");
        expect(typeof dashboard.metadata.contributionCount).toBe("number");
        expect(typeof dashboard.metadata.activeClaimCount).toBe("number");
        expect(Array.isArray(dashboard.activeClaims)).toBe(true);
        expect(Array.isArray(dashboard.recentContributions)).toBe(true);
        expect(dashboard.frontierSummary).toBeDefined();
      } finally {
        cleanup();
      }
    });

    test("getContributions returns a list", async () => {
      const { provider, cleanup } = await factory();
      try {
        const contributions = await provider.getContributions({ limit: 10 });
        expect(Array.isArray(contributions)).toBe(true);
        expect(contributions.length).toBeGreaterThan(0);

        const first = contributions[0];
        expect(first).toBeDefined();
        expect(typeof first?.cid).toBe("string");
        expect(typeof first?.kind).toBe("string");
        expect(typeof first?.summary).toBe("string");
      } finally {
        cleanup();
      }
    });

    test("getContribution returns detail for existing CID", async () => {
      const { provider, testCid, cleanup } = await factory();
      try {
        const detail = await provider.getContribution(testCid);
        expect(detail).toBeDefined();
        expect(detail?.contribution.cid).toBe(testCid);
        expect(Array.isArray(detail?.ancestors)).toBe(true);
        expect(Array.isArray(detail?.children)).toBe(true);
        expect(Array.isArray(detail?.thread)).toBe(true);
      } finally {
        cleanup();
      }
    });

    test("getContribution returns undefined for non-existent CID", async () => {
      const { provider, cleanup } = await factory();
      try {
        const detail = await provider.getContribution(
          "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        );
        expect(detail).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    test("getClaims returns active claims", async () => {
      const { provider, cleanup } = await factory();
      try {
        const claims = await provider.getClaims({ status: "active" });
        expect(Array.isArray(claims)).toBe(true);
      } finally {
        cleanup();
      }
    });

    test("getFrontier returns frontier data", async () => {
      const { provider, cleanup } = await factory();
      try {
        const frontier = await provider.getFrontier();
        expect(frontier).toBeDefined();
        expect(frontier.byAdoption).toBeDefined();
        expect(frontier.byRecency).toBeDefined();
      } finally {
        cleanup();
      }
    });

    test("getActivity returns contributions", async () => {
      const { provider, cleanup } = await factory();
      try {
        const activity = await provider.getActivity({ limit: 5 });
        expect(Array.isArray(activity)).toBe(true);
      } finally {
        cleanup();
      }
    });

    test("getDag returns graph data", async () => {
      const { provider, cleanup } = await factory();
      try {
        const dag = await provider.getDag();
        expect(dag).toBeDefined();
        expect(Array.isArray(dag.contributions)).toBe(true);
      } finally {
        cleanup();
      }
    });

    test("getHotThreads returns thread summaries", async () => {
      const { provider, cleanup } = await factory();
      try {
        const threads = await provider.getHotThreads(5);
        expect(Array.isArray(threads)).toBe(true);
      } finally {
        cleanup();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Lifecycle conformance (optional — only for providers with lifecycle methods)
// ---------------------------------------------------------------------------

/**
 * Run lifecycle conformance tests against a TuiDataProvider implementation.
 *
 * Tests: createClaim → getClaims → releaseClaim → verify released.
 * Only runs when the provider has lifecycle methods.
 */
export function runProviderLifecycleTests(suiteName: string, factory: ProviderFactory): void {
  describe(`${suiteName} lifecycle conformance`, () => {
    test("createClaim → getClaims → releaseClaim lifecycle", async () => {
      const { provider, cleanup } = await factory();
      try {
        if (!provider.createClaim || !provider.releaseClaim) {
          // Provider doesn't support lifecycle — skip
          return;
        }

        const agent = { agentId: `lifecycle-test-${Date.now()}` };
        const targetRef = `lifecycle-target-${Date.now()}`;

        // Create claim
        const claim = await provider.createClaim({
          targetRef,
          agent,
          intentSummary: "conformance lifecycle test",
          leaseDurationMs: 300_000,
        });
        expect(claim.status).toBe("active");
        expect(claim.targetRef).toBe(targetRef);

        // Verify claim shows in active claims
        const activeClaims = await provider.getClaims({ status: "active" });
        const found = activeClaims.find((c) => c.claimId === claim.claimId);
        expect(found).toBeDefined();

        // Release claim
        await provider.releaseClaim(claim.claimId);

        // Verify claim is no longer in active claims
        const afterRelease = await provider.getClaims({ status: "active" });
        const notFound = afterRelease.find((c) => c.claimId === claim.claimId);
        expect(notFound).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    test("checkoutWorkspace returns a valid path", async () => {
      const { provider, cleanup } = await factory();
      try {
        if (!provider.checkoutWorkspace) {
          return;
        }

        const agent = { agentId: `workspace-test-${Date.now()}` };
        const targetRef = `ws-target-${Date.now()}`;
        const path = await provider.checkoutWorkspace(targetRef, agent);
        expect(typeof path).toBe("string");
        expect(path.length).toBeGreaterThan(0);

        // Clean up
        if (provider.cleanWorkspace) {
          await provider.cleanWorkspace(targetRef, agent.agentId);
        }
      } finally {
        cleanup();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Goal conformance (optional — only for providers with capabilities.goals)
// ---------------------------------------------------------------------------

/**
 * Run goal conformance tests against a TuiDataProvider implementation.
 *
 * Tests: getGoal (empty) → setGoal → getGoal (verify) → setGoal (upsert).
 * Only runs when the provider has capabilities.goals === true.
 */
export function runProviderGoalTests(suiteName: string, factory: ProviderFactory): void {
  describe(`${suiteName} goal conformance`, () => {
    test("getGoal returns undefined before any goal is set", async () => {
      const { provider, cleanup } = await factory();
      try {
        if (!provider.capabilities.goals || !isGoalProvider(provider)) {
          // Provider doesn't support goals — skip
          return;
        }

        const goal = await (provider as TuiDataProvider & TuiGoalProvider).getGoal();
        expect(goal).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    test("setGoal creates a goal with correct fields", async () => {
      const { provider, cleanup } = await factory();
      try {
        if (!provider.capabilities.goals || !isGoalProvider(provider)) {
          return;
        }

        const goalProvider = provider as TuiDataProvider & TuiGoalProvider;
        const result = await goalProvider.setGoal("Fix auth", ["Tests pass"]);
        expect(result.goal).toBe("Fix auth");
        expect(result.acceptance).toEqual(["Tests pass"]);
        expect(result.status).toBe("active");
        expect(typeof result.setAt).toBe("string");
        expect(typeof result.setBy).toBe("string");

        // Verify getGoal returns the same goal
        const fetched = await goalProvider.getGoal();
        expect(fetched).toBeDefined();
        expect(fetched?.goal).toBe("Fix auth");
        expect(fetched?.acceptance).toEqual(["Tests pass"]);
      } finally {
        cleanup();
      }
    });

    test("setGoal again upserts the existing goal", async () => {
      const { provider, cleanup } = await factory();
      try {
        if (!provider.capabilities.goals || !isGoalProvider(provider)) {
          return;
        }

        const goalProvider = provider as TuiDataProvider & TuiGoalProvider;

        // Set initial goal
        await goalProvider.setGoal("Fix auth", ["Tests pass"]);

        // Upsert with new goal
        const updated = await goalProvider.setGoal("Refactor DB", [
          "Migrations run",
          "No downtime",
        ]);
        expect(updated.goal).toBe("Refactor DB");
        expect(updated.acceptance).toEqual(["Migrations run", "No downtime"]);

        // Verify getGoal returns the updated goal, not the old one
        const fetched = await goalProvider.getGoal();
        expect(fetched).toBeDefined();
        expect(fetched?.goal).toBe("Refactor DB");
        expect(fetched?.acceptance).toEqual(["Migrations run", "No downtime"]);
      } finally {
        cleanup();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Session conformance (optional — only for providers with capabilities.sessions)
// ---------------------------------------------------------------------------

/**
 * Run session conformance tests against a TuiDataProvider implementation.
 *
 * Tests the full session lifecycle: list (empty) → create → list → get →
 * archive → list (filtered) → addContribution.
 * Only runs when the provider has capabilities.sessions === true.
 */
export function runProviderSessionTests(suiteName: string, factory: ProviderFactory): void {
  describe(`${suiteName} session conformance`, () => {
    test("listSessions returns empty before any sessions", async () => {
      const { provider, cleanup } = await factory();
      try {
        if (!provider.capabilities.sessions || !isSessionProvider(provider)) {
          return;
        }

        const sessions = await (provider as TuiDataProvider & TuiSessionProvider).listSessions();
        expect(Array.isArray(sessions)).toBe(true);
        expect(sessions.length).toBe(0);
      } finally {
        cleanup();
      }
    });

    test("createSession creates a session with auto-generated ID", async () => {
      const { provider, cleanup } = await factory();
      try {
        if (!provider.capabilities.sessions || !isSessionProvider(provider)) {
          return;
        }

        const sessionProvider = provider as TuiDataProvider & TuiSessionProvider;
        const session = await sessionProvider.createSession({});
        expect(session).toBeDefined();
        expect(typeof session.sessionId).toBe("string");
        expect(session.sessionId.length).toBeGreaterThan(0);
        expect(session.status).toBe("active");
        expect(typeof session.startedAt).toBe("string");
      } finally {
        cleanup();
      }
    });

    test("listSessions returns the created session", async () => {
      const { provider, cleanup } = await factory();
      try {
        if (!provider.capabilities.sessions || !isSessionProvider(provider)) {
          return;
        }

        const sessionProvider = provider as TuiDataProvider & TuiSessionProvider;
        const session = await sessionProvider.createSession({ goal: "Test session" });

        const sessions = await sessionProvider.listSessions();
        expect(sessions.length).toBeGreaterThanOrEqual(1);
        const found = sessions.find((s) => s.sessionId === session.sessionId);
        expect(found).toBeDefined();
        expect(found?.status).toBe("active");
      } finally {
        cleanup();
      }
    });

    test("getSession returns by ID", async () => {
      const { provider, cleanup } = await factory();
      try {
        if (!provider.capabilities.sessions || !isSessionProvider(provider)) {
          return;
        }

        const sessionProvider = provider as TuiDataProvider & TuiSessionProvider;
        const session = await sessionProvider.createSession({ goal: "Lookup test" });

        const fetched = await sessionProvider.getSession(session.sessionId);
        expect(fetched).toBeDefined();
        expect(fetched?.sessionId).toBe(session.sessionId);
        expect(fetched?.status).toBe("active");
      } finally {
        cleanup();
      }
    });

    test("archiveSession archives the session", async () => {
      const { provider, cleanup } = await factory();
      try {
        if (!provider.capabilities.sessions || !isSessionProvider(provider)) {
          return;
        }

        const sessionProvider = provider as TuiDataProvider & TuiSessionProvider;
        const session = await sessionProvider.createSession({ goal: "Archive test" });

        await sessionProvider.archiveSession(session.sessionId);

        // Verify the session is archived
        const fetched = await sessionProvider.getSession(session.sessionId);
        expect(fetched).toBeDefined();
        expect(fetched?.status).toBe("archived");
      } finally {
        cleanup();
      }
    });

    test("listSessions with status filter excludes archived sessions", async () => {
      const { provider, cleanup } = await factory();
      try {
        if (!provider.capabilities.sessions || !isSessionProvider(provider)) {
          return;
        }

        const sessionProvider = provider as TuiDataProvider & TuiSessionProvider;
        const session = await sessionProvider.createSession({ goal: "Filter test" });
        await sessionProvider.archiveSession(session.sessionId);

        const activeSessions = await sessionProvider.listSessions({ status: "active" });
        const found = activeSessions.find((s) => s.sessionId === session.sessionId);
        expect(found).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    test("addContributionToSession links a CID", async () => {
      const { provider, testCid, cleanup } = await factory();
      try {
        if (!provider.capabilities.sessions || !isSessionProvider(provider)) {
          return;
        }

        const sessionProvider = provider as TuiDataProvider & TuiSessionProvider;
        const session = await sessionProvider.createSession({ goal: "Contribution link test" });

        // Should not throw
        await sessionProvider.addContributionToSession(session.sessionId, testCid);

        // Verify contribution count increased
        const fetched = await sessionProvider.getSession(session.sessionId);
        expect(fetched).toBeDefined();
        expect(fetched?.contributionCount).toBeGreaterThanOrEqual(1);
      } finally {
        cleanup();
      }
    });
  });
}

/**
 * Conformance test suite for SessionStore implementations.
 *
 * Any backend that implements SessionStore can validate its behavior
 * by calling `sessionStoreConformance()` with a factory that creates
 * fresh store instances.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionStore } from "./session.js";
import type { AgentTopology } from "./topology.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Minimal topology fixture for tests that need one. */
const SAMPLE_TOPOLOGY: AgentTopology = {
  structure: "flat",
  roles: [{ name: "worker" }],
};

/**
 * Run the full SessionStore conformance test suite.
 *
 * Call this from your backend-specific test file with a factory
 * that creates fresh store instances and an optional cleanup callback.
 */
export function sessionStoreConformance(
  factory: () => SessionStore | Promise<SessionStore>,
  cleanup?: () => void | Promise<void>,
): void {
  describe("SessionStore conformance", () => {
    let store: SessionStore;

    beforeEach(async () => {
      store = await factory();
    });

    afterEach(async () => {
      await cleanup?.();
    });

    // ------------------------------------------------------------------
    // 1. Create and get roundtrip
    // ------------------------------------------------------------------

    test("createSession returns a session with generated ID; getSession returns same data", async () => {
      const session = await store.createSession({ goal: "roundtrip test" });
      expect(session.id).toBeTruthy();
      expect(typeof session.id).toBe("string");
      expect(session.goal).toBe("roundtrip test");
      expect(session.contributionCount).toBe(0);
      expect(typeof session.createdAt).toBe("string");

      const fetched = await store.getSession(session.id);
      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe(session.id);
      expect(fetched?.goal).toBe("roundtrip test");
      expect(fetched?.contributionCount).toBe(0);
    });

    // ------------------------------------------------------------------
    // 2. Create with topology
    // ------------------------------------------------------------------

    test("topology is stored and returned by getSession", async () => {
      const session = await store.createSession({
        goal: "topo test",
        topology: SAMPLE_TOPOLOGY,
      });

      const fetched = await store.getSession(session.id);
      expect(fetched).toBeDefined();
      expect(fetched?.topology).toBeDefined();
      expect(fetched?.topology?.structure).toBe("flat");
      expect(fetched?.topology?.roles.length).toBe(1);
      expect(fetched?.topology?.roles[0]?.name).toBe("worker");
    });

    // ------------------------------------------------------------------
    // 3. Create without topology
    // ------------------------------------------------------------------

    test("topology is undefined when not provided", async () => {
      const session = await store.createSession({ goal: "no topo" });

      const fetched = await store.getSession(session.id);
      expect(fetched).toBeDefined();
      expect(fetched?.topology).toBeUndefined();
    });

    // ------------------------------------------------------------------
    // 4. Get nonexistent
    // ------------------------------------------------------------------

    test("getSession returns undefined for non-existent ID", async () => {
      const result = await store.getSession("non-existent-session-id");
      expect(result).toBeUndefined();
    });

    // ------------------------------------------------------------------
    // 5. List empty
    // ------------------------------------------------------------------

    test("listSessions returns empty array when no sessions exist", async () => {
      const sessions = await store.listSessions();
      expect(sessions).toEqual([]);
    });

    // ------------------------------------------------------------------
    // 6. List returns created sessions — ordered by creation time descending
    // ------------------------------------------------------------------

    test("listSessions returns created sessions ordered by creation time descending", async () => {
      const s1 = await store.createSession({ goal: "first" });
      const s2 = await store.createSession({ goal: "second" });
      const s3 = await store.createSession({ goal: "third" });

      const sessions = await store.listSessions();
      expect(sessions.length).toBe(3);

      // All created sessions must be present
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain(s1.id);
      expect(ids).toContain(s2.id);
      expect(ids).toContain(s3.id);

      // Verify ordering: createdAt must be non-increasing (descending)
      for (let i = 1; i < sessions.length; i++) {
        const prev = new Date(sessions[i - 1]?.createdAt ?? "").getTime();
        const curr = new Date(sessions[i]?.createdAt ?? "").getTime();
        expect(prev).toBeGreaterThanOrEqual(curr);
      }
    });

    // ------------------------------------------------------------------
    // 7. List filters by status
    // ------------------------------------------------------------------

    test("listSessions filters by status", async () => {
      const s1 = await store.createSession({ goal: "will archive" });
      await store.createSession({ goal: "stays active" });
      await store.archiveSession(s1.id);

      const archived = await store.listSessions({ status: "archived" });
      expect(archived.length).toBe(1);
      expect(archived[0]?.id).toBe(s1.id);

      // The non-archived session should be the only active/pending one
      const allSessions = await store.listSessions();
      expect(allSessions.length).toBe(2);
    });

    // ------------------------------------------------------------------
    // 8. List filters by presetName
    // ------------------------------------------------------------------

    test("listSessions filters by presetName", async () => {
      await store.createSession({ goal: "alpha", presetName: "review-loop" });
      await store.createSession({ goal: "beta", presetName: "code-sweep" });
      await store.createSession({ goal: "gamma", presetName: "review-loop" });

      const reviewLoop = await store.listSessions({ presetName: "review-loop" });
      expect(reviewLoop.length).toBe(2);
      for (const s of reviewLoop) {
        expect(s.presetName).toBe("review-loop");
      }

      const codeSweep = await store.listSessions({ presetName: "code-sweep" });
      expect(codeSweep.length).toBe(1);
      expect(codeSweep[0]?.presetName).toBe("code-sweep");
    });

    // ------------------------------------------------------------------
    // 9. Update status
    // ------------------------------------------------------------------

    test("updateSession changes status", async () => {
      const session = await store.createSession({ goal: "update me" });

      await store.updateSession(session.id, { status: "completed" });

      const fetched = await store.getSession(session.id);
      expect(fetched).toBeDefined();
      expect(fetched?.status).toBe("completed");
    });

    // ------------------------------------------------------------------
    // 10. Archive
    // ------------------------------------------------------------------

    test("archiveSession sets status to archived and completedAt", async () => {
      const session = await store.createSession({ goal: "archive me" });
      expect(session.completedAt).toBeUndefined();

      await store.archiveSession(session.id);

      const fetched = await store.getSession(session.id);
      expect(fetched).toBeDefined();
      expect(fetched?.status).toBe("archived");
      expect(fetched?.completedAt).toBeDefined();
      expect(typeof fetched?.completedAt).toBe("string");
    });

    // ------------------------------------------------------------------
    // 11. Add contribution
    // ------------------------------------------------------------------

    test("addContribution increments contributionCount in getSession", async () => {
      const session = await store.createSession({ goal: "contrib test" });

      await store.addContribution(session.id, "blake3:aaa111");
      const after1 = await store.getSession(session.id);
      expect(after1?.contributionCount).toBe(1);

      await store.addContribution(session.id, "blake3:bbb222");
      const after2 = await store.getSession(session.id);
      expect(after2?.contributionCount).toBe(2);
    });

    // ------------------------------------------------------------------
    // 12. Get contributions — returns CIDs in order, deduplicates
    // ------------------------------------------------------------------

    test("getContributions returns CIDs in order and deduplicates", async () => {
      const session = await store.createSession({ goal: "dedup test" });

      await store.addContribution(session.id, "blake3:first");
      await store.addContribution(session.id, "blake3:second");
      await store.addContribution(session.id, "blake3:third");
      // Duplicate — should be ignored
      await store.addContribution(session.id, "blake3:first");

      const cids = await store.getContributions(session.id);
      expect(cids.length).toBe(3);
      expect(cids[0]).toBe("blake3:first");
      expect(cids[1]).toBe("blake3:second");
      expect(cids[2]).toBe("blake3:third");
    });
  });
}

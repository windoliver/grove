/**
 * Conformance test suite for SessionStore implementations.
 *
 * Any backend that implements SessionStore can validate its behavior
 * by calling `sessionStoreConformance()` with a factory that creates
 * fresh store instances.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { expectOk } from "./cas.js";
import { ownerRefsEqual } from "./lifecycle-metadata.js";
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

      // Default call excludes archived sessions
      const liveSessions = await store.listSessions();
      expect(liveSessions.length).toBe(1);
      expect(liveSessions[0]?.id).not.toBe(s1.id);
    });

    test("listSessions({ includeArchived: true }) returns all sessions", async () => {
      const s1 = await store.createSession({ goal: "will archive" });
      await store.createSession({ goal: "stays active" });
      await store.archiveSession(s1.id);

      const all = await store.listSessions({ includeArchived: true });
      expect(all.length).toBe(2);
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

    test("deleteSession removes an unblocked session", async () => {
      const session = await store.createSession({ goal: "delete me" });

      const result = expectOk(await store.deleteSession(session.id));

      expect(result).toEqual({
        sessionId: session.id,
        deleted: true,
        forced: false,
        blockers: [],
      });
      expect(await store.getSession(session.id)).toBeUndefined();
    });

    test("deleteSession is idempotent for a missing session", async () => {
      const result = expectOk(await store.deleteSession("missing-session"));

      expect(result).toEqual({
        sessionId: "missing-session",
        deleted: false,
        forced: false,
        blockers: [{ finalizer: "grove.io/release-slots", message: "session not found" }],
      });
    });

    test("listSessionDeleteBlockers returns no blockers for existing session and release-slots blocker for missing session", async () => {
      const session = await store.createSession({ goal: "blocker metadata" });

      expect(await store.listSessionDeleteBlockers(session.id)).toEqual([]);
      expect(await store.listSessionDeleteBlockers("missing-session")).toEqual([
        { finalizer: "grove.io/release-slots", message: "session not found" },
      ]);
    });

    test("deleteSession force returns forced true and warning", async () => {
      const session = await store.createSession({ goal: "force delete me" });

      const result = expectOk(
        await store.deleteSession(session.id, {
          force: true,
          actor: "test-operator",
        }),
      );

      expect(result).toEqual({
        sessionId: session.id,
        deleted: true,
        forced: true,
        blockers: [],
        warning: `force delete skipped finalizer waits for session ${session.id}`,
      });
      expect(await store.getSession(session.id)).toBeUndefined();
    });

    test("created sessions include uid and default finalizers", async () => {
      const session = await store.createSession({ goal: "metadata" });

      expect(session.uid).toBeTruthy();
      expect(session.finalizers).toEqual([
        "grove.io/release-slots",
        "grove.io/drain-contribs",
        "grove.io/close-runtime",
      ]);
    });

    test("created session uid supports ownerRef equality checks", async () => {
      const session = await store.createSession({ goal: "owner metadata" });
      const ownerRef = { kind: "session" as const, id: session.id, uid: session.uid };

      expect(ownerRefsEqual(ownerRef, { ...ownerRef })).toBe(true);
      expect(ownerRefsEqual(ownerRef, { ...ownerRef, uid: `${session.uid}-other` })).toBe(false);
      expect(ownerRefsEqual(ownerRef, undefined)).toBe(false);
    });

    // ------------------------------------------------------------------
    // CAS (#304, C6 T3b) — updateSession + archiveSession + deleteSession
    // ------------------------------------------------------------------

    describe("CAS (C6 #304) — updateSession", () => {
      test("stale ifMatch → rv-mismatch carries current RV; row unchanged", async () => {
        const session = await store.createSession({ goal: "cas update stale" });
        const result = await store.updateSession(
          session.id,
          { status: "completed" },
          { ifMatch: "999" },
        );
        expect(result.kind).toBe("rv-mismatch");
        if (result.kind === "rv-mismatch") {
          expect(result.current.resourceVersion).not.toBe("999");
        }
        const fetched = await store.getSession(session.id);
        // Status must still be the initial create-time value (NOT "completed")
        expect(fetched?.status).not.toBe("completed");
      });

      test("fresh ifMatch → ok with bumped RV", async () => {
        const session = await store.createSession({ goal: "cas update fresh" });
        const initialRv = String(session.resourceVersion ?? 1);
        const result = await store.updateSession(
          session.id,
          { status: "completed" },
          { ifMatch: initialRv },
        );
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
          expect(result.view).toBeDefined();
          expect(result.view?.status).toBe("completed");
          // Bumped: post-write RV must be strictly greater than the supplied ifMatch
          const newRv = result.view?.resourceVersion ?? 0;
          expect(newRv).toBeGreaterThan(Number(initialRv));
        }
      });

      test("missing ifMatch → ok (back-compat)", async () => {
        const session = await store.createSession({ goal: "cas update legacy" });
        const result = await store.updateSession(session.id, { status: "completed" });
        expect(result.kind).toBe("ok");
        const fetched = await store.getSession(session.id);
        expect(fetched?.status).toBe("completed");
      });

      test("ifMatch against non-existent session → ok with undefined view", async () => {
        const result = await store.updateSession(
          "definitely-not-a-session-id",
          { status: "completed" },
          { ifMatch: "1" },
        );
        // Per the contract: missing-session is idempotent, returns ok/undefined.
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
          expect(result.view).toBeUndefined();
        }
      });
    });

    describe("CAS (C6 #304) — archiveSession", () => {
      test("stale ifMatch → rv-mismatch; session not archived", async () => {
        const session = await store.createSession({ goal: "cas archive stale" });
        const result = await store.archiveSession(session.id, { ifMatch: "999" });
        expect(result.kind).toBe("rv-mismatch");
        const fetched = await store.getSession(session.id);
        expect(fetched?.status).not.toBe("archived");
      });

      test("fresh ifMatch → ok and session is archived", async () => {
        const session = await store.createSession({ goal: "cas archive fresh" });
        const initialRv = String(session.resourceVersion ?? 1);
        const result = await store.archiveSession(session.id, { ifMatch: initialRv });
        expect(result.kind).toBe("ok");
        const fetched = await store.getSession(session.id);
        expect(fetched?.status).toBe("archived");
      });

      test("missing ifMatch → ok (back-compat)", async () => {
        const session = await store.createSession({ goal: "cas archive legacy" });
        const result = await store.archiveSession(session.id);
        expect(result.kind).toBe("ok");
        const fetched = await store.getSession(session.id);
        expect(fetched?.status).toBe("archived");
      });

      test("ifMatch against non-existent session → ok with undefined view", async () => {
        const result = await store.archiveSession("definitely-not-a-session-id", {
          ifMatch: "1",
        });
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
          expect(result.view).toBeUndefined();
        }
      });
    });

    describe("CAS (C6 #304) — deleteSession", () => {
      test("stale ifMatch → rv-mismatch; session not deleted", async () => {
        const session = await store.createSession({ goal: "cas delete stale" });
        const result = await store.deleteSession(session.id, { ifMatch: "999" });
        expect(result.kind).toBe("rv-mismatch");
        // Session must still exist
        expect(await store.getSession(session.id)).toBeDefined();
      });

      test("fresh ifMatch → ok and session is deleted", async () => {
        const session = await store.createSession({ goal: "cas delete fresh" });
        const initialRv = String(session.resourceVersion ?? 1);
        const result = await store.deleteSession(session.id, { ifMatch: initialRv });
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
          expect(result.view.deleted).toBe(true);
        }
        expect(await store.getSession(session.id)).toBeUndefined();
      });

      test("missing ifMatch → ok (back-compat)", async () => {
        const session = await store.createSession({ goal: "cas delete legacy" });
        const result = await store.deleteSession(session.id);
        expect(result.kind).toBe("ok");
        expect(await store.getSession(session.id)).toBeUndefined();
      });

      test("ifMatch against non-existent session → ok with not-found blocker", async () => {
        const result = await store.deleteSession("definitely-not-a-session-id", {
          ifMatch: "1",
        });
        // deleteSession's existing not-found contract returns an "ok" result with
        // `deleted: false` and a release-slots blocker. The CAS check sits BEHIND
        // the not-found guard so a missing record never produces rv-mismatch.
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
          expect(result.view.deleted).toBe(false);
          expect(result.view.blockers.length).toBeGreaterThan(0);
        }
      });
    });
  });
}

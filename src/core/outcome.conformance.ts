/**
 * Conformance test suite for OutcomeStore implementations.
 *
 * Any backend that implements OutcomeStore can validate its behavior
 * by calling `runOutcomeStoreTests()` with a factory that creates
 * fresh store instances.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OutcomeStore } from "./outcome.js";
import { OutcomeStatus } from "./outcome.js";

/** Factory that creates a fresh OutcomeStore and returns a cleanup function. */
export type OutcomeStoreFactory = () => Promise<{
  store: OutcomeStore;
  cleanup: () => Promise<void>;
}>;

/** Run the full OutcomeStore conformance test suite. */
export function runOutcomeStoreTests(factory: OutcomeStoreFactory): void {
  describe("OutcomeStore conformance", () => {
    let store: OutcomeStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const result = await factory();
      store = result.store;
      cleanup = result.cleanup;
    });

    afterEach(async () => {
      store.close();
      await cleanup();
    });

    test("set + get roundtrip", async () => {
      const record = await store.set("blake3:abc123", {
        status: OutcomeStatus.Accepted,
        reason: "Metric improved by 5%",
        evaluatedBy: "auto",
      });

      expect(record.cid).toBe("blake3:abc123");
      expect(record.status).toBe("accepted");
      expect(record.reason).toBe("Metric improved by 5%");
      expect(record.evaluatedBy).toBe("auto");
      expect(typeof record.evaluatedAt).toBe("string");

      const fetched = await store.get("blake3:abc123");
      expect(fetched).toBeDefined();
      expect(fetched?.cid).toBe("blake3:abc123");
      expect(fetched?.status).toBe("accepted");
      expect(fetched?.reason).toBe("Metric improved by 5%");
    });

    test("set overwrites previous outcome for same CID", async () => {
      await store.set("blake3:abc123", {
        status: OutcomeStatus.Accepted,
        evaluatedBy: "auto",
      });

      await store.set("blake3:abc123", {
        status: OutcomeStatus.Rejected,
        reason: "Regression detected",
        evaluatedBy: "human-1",
      });

      const fetched = await store.get("blake3:abc123");
      expect(fetched?.status).toBe("rejected");
      expect(fetched?.reason).toBe("Regression detected");
      expect(fetched?.evaluatedBy).toBe("human-1");
    });

    test("get returns undefined for unknown CID", async () => {
      const result = await store.get("blake3:nonexistent");
      expect(result).toBeUndefined();
    });

    test("set with baselineCid", async () => {
      const record = await store.set("blake3:child", {
        status: OutcomeStatus.Accepted,
        baselineCid: "blake3:parent",
        evaluatedBy: "auto",
      });

      expect(record.baselineCid).toBe("blake3:parent");

      const fetched = await store.get("blake3:child");
      expect(fetched?.baselineCid).toBe("blake3:parent");
    });

    test("list returns all outcomes", async () => {
      await store.set("blake3:a", { status: OutcomeStatus.Accepted, evaluatedBy: "auto" });
      await store.set("blake3:b", { status: OutcomeStatus.Rejected, evaluatedBy: "auto" });
      await store.set("blake3:c", { status: OutcomeStatus.Crashed, evaluatedBy: "auto" });

      const all = await store.list();
      expect(all.length).toBe(3);
    });

    test("list with status filter", async () => {
      await store.set("blake3:a", { status: OutcomeStatus.Accepted, evaluatedBy: "auto" });
      await store.set("blake3:b", { status: OutcomeStatus.Rejected, evaluatedBy: "auto" });
      await store.set("blake3:c", { status: OutcomeStatus.Accepted, evaluatedBy: "auto" });

      const accepted = await store.list({ status: OutcomeStatus.Accepted });
      expect(accepted.length).toBe(2);
      for (const r of accepted) {
        expect(r.status).toBe("accepted");
      }
    });

    test("list with evaluatedBy filter", async () => {
      await store.set("blake3:a", { status: OutcomeStatus.Accepted, evaluatedBy: "auto" });
      await store.set("blake3:b", { status: OutcomeStatus.Rejected, evaluatedBy: "human-1" });

      const autoOnly = await store.list({ evaluatedBy: "auto" });
      expect(autoOnly.length).toBe(1);
      expect(autoOnly[0]?.evaluatedBy).toBe("auto");
    });

    test("list with limit and offset", async () => {
      await store.set("blake3:a", { status: OutcomeStatus.Accepted, evaluatedBy: "auto" });
      await store.set("blake3:b", { status: OutcomeStatus.Rejected, evaluatedBy: "auto" });
      await store.set("blake3:c", { status: OutcomeStatus.Crashed, evaluatedBy: "auto" });

      const page1 = await store.list({ limit: 2 });
      expect(page1.length).toBe(2);

      const page2 = await store.list({ limit: 2, offset: 2 });
      expect(page2.length).toBe(1);
    });

    test("getStats returns correct breakdown", async () => {
      await store.set("blake3:a", { status: OutcomeStatus.Accepted, evaluatedBy: "auto" });
      await store.set("blake3:b", { status: OutcomeStatus.Accepted, evaluatedBy: "auto" });
      await store.set("blake3:c", { status: OutcomeStatus.Rejected, evaluatedBy: "auto" });
      await store.set("blake3:d", { status: OutcomeStatus.Crashed, evaluatedBy: "auto" });
      await store.set("blake3:e", { status: OutcomeStatus.Invalidated, evaluatedBy: "auto" });

      const stats = await store.getStats();
      expect(stats.total).toBe(5);
      expect(stats.accepted).toBe(2);
      expect(stats.rejected).toBe(1);
      expect(stats.crashed).toBe(1);
      expect(stats.invalidated).toBe(1);
      expect(stats.acceptanceRate).toBeCloseTo(0.4, 5);
    });

    test("getStats on empty store", async () => {
      const stats = await store.getStats();
      expect(stats.total).toBe(0);
      expect(stats.accepted).toBe(0);
      expect(stats.acceptanceRate).toBe(0);
    });

    test("getBatch returns outcomes for known CIDs", async () => {
      await store.set("blake3:a", { status: OutcomeStatus.Accepted, evaluatedBy: "auto" });
      await store.set("blake3:b", { status: OutcomeStatus.Rejected, evaluatedBy: "auto" });

      const batch = await store.getBatch(["blake3:a", "blake3:b", "blake3:unknown"]);
      expect(batch.size).toBe(2);
      expect(batch.get("blake3:a")?.status).toBe("accepted");
      expect(batch.get("blake3:b")?.status).toBe("rejected");
      expect(batch.has("blake3:unknown")).toBe(false);
    });

    test("getBatch with empty array returns empty map", async () => {
      const batch = await store.getBatch([]);
      expect(batch.size).toBe(0);
    });

    test("set returns immutable record with evaluatedAt timestamp", async () => {
      const before = new Date().toISOString();
      const record = await store.set("blake3:ts", {
        status: OutcomeStatus.Accepted,
        evaluatedBy: "auto",
      });
      const after = new Date().toISOString();

      expect(record.evaluatedAt >= before).toBe(true);
      expect(record.evaluatedAt <= after).toBe(true);
    });
  });
}

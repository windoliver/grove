/**
 * Conformance test suite for TuiDataProvider implementations.
 *
 * Run the same behavioral tests against both LocalDataProvider
 * and RemoteDataProvider to ensure consistent behavior.
 */

import { describe, expect, test } from "bun:test";
import type { TuiDataProvider } from "./provider.js";

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
        const detail = await provider.getContribution("blake3:nonexistent");
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

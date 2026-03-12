/**
 * Tests for shared provider utilities.
 *
 * Covers outcomeStatsFromStore and diffArtifactsFromBuffers — the shared helpers
 * used by all three provider implementations.
 */

import { describe, expect, test } from "bun:test";
import type { OutcomeStore } from "../core/outcome.js";
import { diffArtifactsFromBuffers, outcomeStatsFromStore } from "./provider-shared.js";

// ---------------------------------------------------------------------------
// outcomeStatsFromStore
// ---------------------------------------------------------------------------

describe("outcomeStatsFromStore", () => {
  test("returns zeros when outcomes is undefined", async () => {
    const stats = await outcomeStatsFromStore(undefined);
    expect(stats.totalContributions).toBe(0);
    expect(stats.outcomeBreakdown).toEqual({
      accepted: 0,
      rejected: 0,
      crashed: 0,
      invalidated: 0,
    });
    expect(stats.acceptanceRate).toBe(0);
    expect(stats.byAgent).toEqual([]);
  });

  test("delegates to OutcomeStore.getStats and maps fields", async () => {
    const mockStore: Pick<OutcomeStore, "getStats"> = {
      getStats: async () => ({
        total: 10,
        accepted: 7,
        rejected: 2,
        crashed: 1,
        invalidated: 0,
        acceptanceRate: 0.7,
      }),
    };

    const stats = await outcomeStatsFromStore(mockStore as OutcomeStore);
    expect(stats.totalContributions).toBe(10);
    expect(stats.outcomeBreakdown.accepted).toBe(7);
    expect(stats.outcomeBreakdown.rejected).toBe(2);
    expect(stats.outcomeBreakdown.crashed).toBe(1);
    expect(stats.outcomeBreakdown.invalidated).toBe(0);
    expect(stats.acceptanceRate).toBe(0.7);
    expect(stats.byAgent).toEqual([]);
  });

  test("handles store with all zeros", async () => {
    const mockStore: Pick<OutcomeStore, "getStats"> = {
      getStats: async () => ({
        total: 0,
        accepted: 0,
        rejected: 0,
        crashed: 0,
        invalidated: 0,
        acceptanceRate: 0,
      }),
    };

    const stats = await outcomeStatsFromStore(mockStore as OutcomeStore);
    expect(stats.totalContributions).toBe(0);
    expect(stats.acceptanceRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// diffArtifactsFromBuffers
// ---------------------------------------------------------------------------

describe("diffArtifactsFromBuffers", () => {
  test("converts buffers to UTF-8 strings", () => {
    const result = diffArtifactsFromBuffers(
      Buffer.from("parent content"),
      Buffer.from("child content"),
    );
    expect(result.parent).toBe("parent content");
    expect(result.child).toBe("child content");
  });

  test("handles empty buffers", () => {
    const result = diffArtifactsFromBuffers(Buffer.alloc(0), Buffer.alloc(0));
    expect(result.parent).toBe("");
    expect(result.child).toBe("");
  });

  test("handles UTF-8 multibyte characters", () => {
    const result = diffArtifactsFromBuffers(
      Buffer.from([0xc3, 0xa9]), // é
      Buffer.from([0xc3, 0xb6]), // ö
    );
    expect(result.parent).toBe("é");
    expect(result.child).toBe("ö");
  });
});

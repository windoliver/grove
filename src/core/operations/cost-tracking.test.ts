import { describe, expect, test } from "bun:test";

import type { ContributionInput } from "../models.js";
import { ContributionKind } from "../models.js";
import { InMemoryContributionStore } from "../testing.js";
import { getSessionCosts, reportUsage } from "./cost-tracking.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple deterministic CID mock for testing. */
function mockComputeCid(input: ContributionInput): string {
  const raw = JSON.stringify(input);
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  return `blake3:${hex.repeat(8)}`;
}

const AGENT_ALICE = { agentId: "alice", agentName: "Alice" };
const AGENT_BOB = { agentId: "bob", agentName: "Bob" };

// ---------------------------------------------------------------------------
// reportUsage
// ---------------------------------------------------------------------------

describe("reportUsage", () => {
  test("creates ephemeral contribution with usage data", async () => {
    const store = new InMemoryContributionStore();
    const result = await reportUsage(
      store,
      AGENT_ALICE,
      { inputTokens: 1000, outputTokens: 500 },
      mockComputeCid,
    );

    expect(result.kind).toBe(ContributionKind.Discussion);
    expect(result.context?.ephemeral).toBe(true);
    expect(result.context?.usage_report).toBeDefined();

    const report = result.context?.usage_report as Record<string, unknown>;
    expect(report.input_tokens).toBe(1000);
    expect(report.output_tokens).toBe(500);
    expect(result.tags).toContain("usage-report");

    // Verify it was stored
    const stored = await store.get(result.cid);
    expect(stored).toBeDefined();
  });

  test("validates report schema — negative tokens rejected", async () => {
    const store = new InMemoryContributionStore();
    await expect(
      reportUsage(store, AGENT_ALICE, { inputTokens: -100, outputTokens: 500 }, mockComputeCid),
    ).rejects.toThrow(/Invalid usage report/);
  });

  test("stores optional fields (model, costUsd)", async () => {
    const store = new InMemoryContributionStore();
    const result = await reportUsage(
      store,
      AGENT_ALICE,
      {
        inputTokens: 2000,
        outputTokens: 800,
        model: "claude-opus-4-6",
        costUsd: 0.045,
        cacheReadTokens: 500,
        contextWindowPercent: 35,
      },
      mockComputeCid,
    );

    const report = result.context?.usage_report as Record<string, unknown>;
    expect(report.model).toBe("claude-opus-4-6");
    expect(report.cost_usd).toBe(0.045);
    expect(report.cache_read_tokens).toBe(500);
    expect(report.context_window_percent).toBe(35);
  });
});

// ---------------------------------------------------------------------------
// getSessionCosts
// ---------------------------------------------------------------------------

describe("getSessionCosts", () => {
  test("aggregates across multiple reports", async () => {
    const store = new InMemoryContributionStore();

    await reportUsage(
      store,
      AGENT_ALICE,
      { inputTokens: 1000, outputTokens: 500, costUsd: 0.01 },
      mockComputeCid,
    );
    await reportUsage(
      store,
      AGENT_ALICE,
      { inputTokens: 2000, outputTokens: 1000, costUsd: 0.02 },
      mockComputeCid,
    );

    const summary = await getSessionCosts(store);
    expect(summary.totalInputTokens).toBe(3000);
    expect(summary.totalOutputTokens).toBe(1500);
    expect(summary.totalCostUsd).toBeCloseTo(0.03);
  });

  test("groups by agent", async () => {
    const store = new InMemoryContributionStore();

    await reportUsage(
      store,
      AGENT_ALICE,
      { inputTokens: 1000, outputTokens: 500, costUsd: 0.01 },
      mockComputeCid,
    );
    await reportUsage(
      store,
      AGENT_BOB,
      { inputTokens: 3000, outputTokens: 1500, costUsd: 0.03 },
      mockComputeCid,
    );

    const summary = await getSessionCosts(store);
    expect(summary.byAgent).toHaveLength(2);

    const aliceSummary = summary.byAgent.find((a) => a.agentId === "alice");
    const bobSummary = summary.byAgent.find((a) => a.agentId === "bob");

    expect(aliceSummary).toBeDefined();
    expect(aliceSummary?.totalInputTokens).toBe(1000);
    expect(aliceSummary?.reportCount).toBe(1);

    expect(bobSummary).toBeDefined();
    expect(bobSummary?.totalInputTokens).toBe(3000);
    expect(bobSummary?.reportCount).toBe(1);
  });

  test("returns zero totals when no reports", async () => {
    const store = new InMemoryContributionStore();
    const summary = await getSessionCosts(store);

    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.byAgent).toHaveLength(0);
  });
});

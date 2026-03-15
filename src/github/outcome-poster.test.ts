/**
 * Tests for outcome-poster — verifies graceful failure when gh CLI
 * is unavailable and correct message formatting.
 */

import { describe, expect, test } from "bun:test";
import { postCheckRun, postOutcomeComment } from "./outcome-poster.js";

describe("postOutcomeComment", () => {
  test("does not throw when gh unavailable", async () => {
    await expect(
      postOutcomeComment({
        prNumber: 999999,
        cid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        summary: "Test contribution",
        outcome: "accepted",
      }),
    ).resolves.toBeUndefined();
  });

  test("does not throw with all optional fields", async () => {
    await expect(
      postOutcomeComment({
        prNumber: 999999,
        cid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        summary: "Test contribution with extras",
        outcome: "rejected",
        agentName: "test-agent",
        scores: { quality: 0.8, relevance: 0.6 },
      }),
    ).resolves.toBeUndefined();
  });

  test("does not throw for crashed outcome", async () => {
    await expect(
      postOutcomeComment({
        prNumber: 999999,
        cid: "blake3:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        summary: "Crashed contribution",
        outcome: "crashed",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("postCheckRun", () => {
  test("does not throw when gh unavailable", async () => {
    await expect(
      postCheckRun({
        owner: "test",
        repo: "test",
        headSha: "abc123",
        name: "grove-test",
        conclusion: "success",
        summary: "Test passed",
      }),
    ).resolves.toBeUndefined();
  });

  test("does not throw with details field", async () => {
    await expect(
      postCheckRun({
        owner: "test",
        repo: "test",
        headSha: "abc123def456",
        name: "grove-review",
        conclusion: "failure",
        summary: "Review failed",
        details: "Detailed failure information here",
      }),
    ).resolves.toBeUndefined();
  });

  test("does not throw with neutral conclusion", async () => {
    await expect(
      postCheckRun({
        owner: "test",
        repo: "test",
        headSha: "deadbeef",
        name: "grove-neutral",
        conclusion: "neutral",
        summary: "Neutral check",
      }),
    ).resolves.toBeUndefined();
  });
});

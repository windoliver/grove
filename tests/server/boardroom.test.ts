/**
 * Tests for the boardroom aggregation endpoint.
 *
 * Validates GET /api/boardroom/summary, POST /api/boardroom/answer,
 * and POST /api/boardroom/message.
 */

import { describe, expect, test } from "bun:test";

import { computeCid } from "../../src/core/manifest.js";
import type { ContributionInput } from "../../src/core/models.js";
import { createTestContext } from "./helpers.js";

/** Create a valid contribution with computed CID. */
function makeContribution(input: ContributionInput) {
  const cid = computeCid(input);
  return { ...input, cid, manifestVersion: 1 };
}

describe("boardroom routes", () => {
  test("GET /api/boardroom/summary returns empty summary", async () => {
    const ctx = await createTestContext();
    try {
      const resp = await ctx.app.request("/api/boardroom/summary");
      expect(resp.status).toBe(200);

      const body = (await resp.json()) as {
        pendingQuestions: unknown[];
        recentMessages: unknown[];
        costSummary: { totalCostUsd: number; totalTokens: number; byAgent: unknown[] };
        activeClaimCount: number;
      };

      expect(body.pendingQuestions).toEqual([]);
      expect(body.recentMessages).toEqual([]);
      expect(body.costSummary.totalCostUsd).toBe(0);
      expect(body.activeClaimCount).toBe(0);
    } finally {
      await ctx.cleanup();
    }
  });

  test("GET /api/boardroom/summary includes messages", async () => {
    const ctx = await createTestContext();
    try {
      const input: ContributionInput = {
        kind: "discussion",
        mode: "exploration",
        summary: "Test message",
        artifacts: {},
        relations: [],
        tags: ["message"],
        context: {
          ephemeral: true,
          recipients: ["@claude-eng"],
          message_body: "Hello from test",
        },
        agent: { agentId: "test-agent", agentName: "@test" },
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      await ctx.contributionStore.put(makeContribution(input));

      const resp = await ctx.app.request("/api/boardroom/summary");
      expect(resp.status).toBe(200);

      const body = (await resp.json()) as {
        recentMessages: readonly { body: string; fromAgentId: string }[];
      };

      expect(body.recentMessages).toHaveLength(1);
      expect(body.recentMessages[0]?.body).toBe("Hello from test");
      expect(body.recentMessages[0]?.fromAgentId).toBe("test-agent");
    } finally {
      await ctx.cleanup();
    }
  });

  test("GET /api/boardroom/summary includes pending questions", async () => {
    const ctx = await createTestContext();
    try {
      const input: ContributionInput = {
        kind: "discussion",
        mode: "exploration",
        summary: "Question: Should I proceed?",
        artifacts: {},
        relations: [],
        tags: ["ask-user", "question"],
        context: {
          ephemeral: true,
          ask_user_question: true,
          question_text: "Should I proceed with the refactor?",
          question_options: ["Yes", "No"],
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        },
        agent: { agentId: "claude-1", agentName: "@claude" },
        createdAt: "2026-01-01T00:00:01.000Z",
      };
      await ctx.contributionStore.put(makeContribution(input));

      const resp = await ctx.app.request("/api/boardroom/summary");
      const body = (await resp.json()) as {
        pendingQuestions: readonly { question: string; agentName?: string }[];
      };

      expect(body.pendingQuestions).toHaveLength(1);
      expect(body.pendingQuestions[0]?.question).toBe("Should I proceed with the refactor?");
    } finally {
      await ctx.cleanup();
    }
  });

  test("POST /api/boardroom/answer creates answer contribution", async () => {
    const ctx = await createTestContext();
    try {
      // Insert a question first
      const qInput: ContributionInput = {
        kind: "discussion",
        mode: "exploration",
        summary: "Question: Fix now?",
        artifacts: {},
        relations: [],
        tags: ["ask-user", "question"],
        context: {
          ephemeral: true,
          ask_user_question: true,
          question_text: "Fix now?",
        },
        agent: { agentId: "agent-1" },
        createdAt: "2026-01-01T00:00:02.000Z",
      };
      const question = makeContribution(qInput);
      await ctx.contributionStore.put(question);

      const resp = await ctx.app.request("/api/boardroom/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionCid: question.cid,
          answer: "Yes, fix now",
        }),
      });

      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { cid: string; answer: string };
      expect(body.answer).toBe("Yes, fix now");
      expect(body.cid).toMatch(/^blake3:/);
    } finally {
      await ctx.cleanup();
    }
  });

  test("POST /api/boardroom/answer rejects missing fields", async () => {
    const ctx = await createTestContext();
    try {
      const resp = await ctx.app.request("/api/boardroom/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionCid: "blake3:abcd" }),
      });
      expect(resp.status).toBe(400);
    } finally {
      await ctx.cleanup();
    }
  });

  test("POST /api/boardroom/message sends message", async () => {
    const ctx = await createTestContext();
    try {
      const resp = await ctx.app.request("/api/boardroom/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "Team update: deployment complete",
          recipients: ["@all"],
        }),
      });

      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { cid: string; summary: string };
      expect(body.cid).toMatch(/^blake3:/);
      expect(body.summary).toContain("Team update");
    } finally {
      await ctx.cleanup();
    }
  });

  test("POST /api/boardroom/message rejects missing fields", async () => {
    const ctx = await createTestContext();
    try {
      const resp = await ctx.app.request("/api/boardroom/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "hello" }),
      });
      expect(resp.status).toBe(400);
    } finally {
      await ctx.cleanup();
    }
  });
});

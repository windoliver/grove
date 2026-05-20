/**
 * Tests for the boardroom aggregation endpoint.
 *
 * Validates GET /api/boardroom/summary, POST /api/boardroom/answer,
 * and POST /api/boardroom/message.
 */

import { describe, expect, test } from "bun:test";

import { AgentTaskPhase } from "../../src/core/agent-task.js";
import {
  type HandoffOperatorProjection,
  HandoffOperatorState,
} from "../../src/core/handoff-operator-state.js";
import { InMemoryHandoffStore } from "../../src/core/in-memory-handoff-store.js";
import { computeCid } from "../../src/core/manifest.js";
import type { ContributionInput } from "../../src/core/models.js";
import type { DeliveredInboxMessage } from "../../src/core/operations/inbox-delegation.js";
import type { AgentTaskStore } from "../../src/core/store.js";
import { createApp } from "../../src/server/app.js";
import { createTestContext, TEST_AUTH_HEADERS, TEST_KEY, TEST_NAMESPACE } from "./helpers.js";

/** Create a valid contribution with computed CID. */
function makeContribution(input: ContributionInput) {
  const cid = computeCid(input);
  return { ...input, cid, manifestVersion: 1 };
}

describe("boardroom routes", () => {
  test("GET /api/boardroom/summary returns empty summary", async () => {
    const ctx = await createTestContext();
    try {
      const resp = await ctx.app.request("/api/boardroom/summary", { headers: TEST_AUTH_HEADERS });
      expect(resp.status).toBe(200);

      const body = (await resp.json()) as {
        pendingQuestions: unknown[];
        recentMessages: unknown[];
        costSummary: { totalCostUsd: number; totalTokens: number; byAgent: unknown[] };
        activeClaimCount: number;
        handoffs: {
          pending: number;
          overdue: number;
          blocked: number;
          deadLettered: number;
          items: unknown[];
        };
      };

      expect(body.pendingQuestions).toEqual([]);
      expect(body.recentMessages).toEqual([]);
      expect(body.costSummary.totalCostUsd).toBe(0);
      expect(body.activeClaimCount).toBe(0);
      expect(body.handoffs).toEqual({
        pending: 0,
        overdue: 0,
        blocked: 0,
        deadLettered: 0,
        items: [],
      });
    } finally {
      await ctx.cleanup();
    }
  });

  test("GET /api/boardroom/summary includes handoff operator counts", async () => {
    const ctx = await createTestContext();
    const handoffStore = new InMemoryHandoffStore();
    try {
      await handoffStore.create({
        handoffId: "handoff-pending",
        sourceCid: "blake3:pending",
        fromRole: "coder",
        toRole: "reviewer",
        requiresReply: true,
      });
      await handoffStore.create({
        handoffId: "handoff-overdue",
        sourceCid: "blake3:overdue",
        fromRole: "coder",
        toRole: "reviewer",
        requiresReply: true,
        replyDueAt: "2026-01-01T00:00:00.000Z",
      });
      const deadLettered = await handoffStore.create({
        handoffId: "handoff-dead-lettered",
        sourceCid: "blake3:dead-lettered",
        fromRole: "coder",
        toRole: "reviewer",
        requiresReply: true,
      });
      await handoffStore.markDeadLettered(deadLettered.handoffId);

      const app = createApp({ ...ctx.deps, handoffStore }, new Map([[TEST_KEY, TEST_NAMESPACE]]));

      const resp = await app.request("/api/boardroom/summary", { headers: TEST_AUTH_HEADERS });
      expect(resp.status).toBe(200);

      const body = (await resp.json()) as {
        handoffs: {
          pending: number;
          overdue: number;
          deadLettered: number;
        };
      };

      expect(body.handoffs.pending).toBe(1);
      expect(body.handoffs.overdue).toBe(1);
      expect(body.handoffs.deadLettered).toBe(1);
    } finally {
      handoffStore.close();
      await ctx.cleanup();
    }
  });

  test("GET /api/boardroom/summary counts actionable handoffs beyond old terminal rows", async () => {
    const ctx = await createTestContext();
    const handoffStore = new InMemoryHandoffStore();
    try {
      for (let index = 0; index < 201; index += 1) {
        const cancelled = await handoffStore.create({
          handoffId: `handoff-cancelled-${index}`,
          sourceCid: `blake3:cancelled-${index}`,
          fromRole: "coder",
          toRole: "reviewer",
          requiresReply: true,
        });
        await handoffStore.markCancelled(cancelled.handoffId);
      }
      await handoffStore.create({
        handoffId: "handoff-pending-after-cap",
        sourceCid: "blake3:pending-after-cap",
        fromRole: "coder",
        toRole: "reviewer",
        requiresReply: true,
      });
      const deadLettered = await handoffStore.create({
        handoffId: "handoff-dead-lettered-after-cap",
        sourceCid: "blake3:dead-lettered-after-cap",
        fromRole: "coder",
        toRole: "reviewer",
        requiresReply: true,
      });
      await handoffStore.markDeadLettered(deadLettered.handoffId);

      const app = createApp({ ...ctx.deps, handoffStore }, new Map([[TEST_KEY, TEST_NAMESPACE]]));

      const resp = await app.request("/api/boardroom/summary", { headers: TEST_AUTH_HEADERS });
      expect(resp.status).toBe(200);

      const body = (await resp.json()) as {
        handoffs: {
          pending: number;
          deadLettered: number;
        };
      };

      expect(body.handoffs.pending).toBe(1);
      expect(body.handoffs.deadLettered).toBe(1);
    } finally {
      handoffStore.close();
      await ctx.cleanup();
    }
  });

  test("GET /api/boardroom/summary marks handoff blocked by failed agent task", async () => {
    const ctx = await createTestContext();
    const handoffStore = new InMemoryHandoffStore();
    try {
      await handoffStore.create({
        handoffId: "handoff-blocked",
        sourceCid: "blake3:blocked",
        fromRole: "coder",
        toRole: "reviewer",
        requiresReply: true,
      });
      await ctx.agentTaskStore.putAgentTaskSpec({
        id: "task-reviewer",
        worktree: "/tmp/worktree",
        runtime: "codex",
        role: "reviewer",
        prompt: "Review the handoff",
        dependsOn: [],
        generation: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await ctx.agentTaskStore.patchAgentTaskStatus("task-reviewer", {
        phase: AgentTaskPhase.Failed,
      });

      const app = createApp({ ...ctx.deps, handoffStore }, new Map([[TEST_KEY, TEST_NAMESPACE]]));

      const resp = await app.request("/api/boardroom/summary", { headers: TEST_AUTH_HEADERS });
      expect(resp.status).toBe(200);

      const body = (await resp.json()) as {
        handoffs: {
          blocked: number;
          items: readonly HandoffOperatorProjection[];
        };
      };

      expect(body.handoffs.blocked).toBe(1);
      expect(body.handoffs.items[0]?.state).toBe(HandoffOperatorState.Blocked);
      expect(body.handoffs.items[0]?.reason).toBe("agent task failed");
    } finally {
      handoffStore.close();
      await ctx.cleanup();
    }
  });

  test("GET /api/boardroom/summary ignores failed agent tasks from other sessions", async () => {
    const ctx = await createTestContext();
    const sessionHandoffStore = new InMemoryHandoffStore();
    try {
      await sessionHandoffStore.create({
        handoffId: "handoff-session-a",
        sourceCid: "blake3:session-a",
        fromRole: "coder",
        toRole: "reviewer",
        requiresReply: true,
      });
      await ctx.agentTaskStore.putAgentTaskSpec({
        id: "task-reviewer-session-b",
        worktree: "/tmp/worktree",
        runtime: "codex",
        role: "reviewer",
        prompt: "Review another session",
        dependsOn: [],
        generation: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await ctx.agentTaskStore.patchAgentTaskStatus("task-reviewer-session-b", {
        phase: AgentTaskPhase.Failed,
        sessionId: "session-b",
      });

      const app = createApp(
        {
          ...ctx.deps,
          handoffStoreForSession: (sessionId) =>
            sessionId === "session-a" ? sessionHandoffStore : undefined,
        },
        new Map([[TEST_KEY, TEST_NAMESPACE]]),
      );

      const resp = await app.request("/api/boardroom/summary?sessionId=session-a", {
        headers: TEST_AUTH_HEADERS,
      });
      expect(resp.status).toBe(200);

      const body = (await resp.json()) as {
        handoffs: {
          pending: number;
          blocked: number;
          items: readonly HandoffOperatorProjection[];
        };
      };

      expect(body.handoffs.pending).toBe(1);
      expect(body.handoffs.blocked).toBe(0);
      expect(body.handoffs.items[0]?.state).toBe(HandoffOperatorState.Pending);
    } finally {
      sessionHandoffStore.close();
      await ctx.cleanup();
    }
  });

  test("GET /api/boardroom/summary keeps handoffs visible when task health read fails", async () => {
    const ctx = await createTestContext();
    const handoffStore = new InMemoryHandoffStore();
    try {
      await handoffStore.create({
        handoffId: "handoff-pending",
        sourceCid: "blake3:pending",
        fromRole: "coder",
        toRole: "reviewer",
        requiresReply: true,
      });
      const throwingAgentTaskStore: AgentTaskStore = {
        storeIdentity: ctx.agentTaskStore.storeIdentity,
        putAgentTaskSpec: (spec, opts) => ctx.agentTaskStore.putAgentTaskSpec(spec, opts),
        getAgentTask: (taskId) => ctx.agentTaskStore.getAgentTask(taskId),
        listAgentTasks: async () => {
          throw new Error("agent task store unavailable");
        },
        patchAgentTaskStatus: (taskId, patch, opts) =>
          ctx.agentTaskStore.patchAgentTaskStatus(taskId, patch, opts),
        listAgentTaskEntities: (query) => ctx.agentTaskStore.listAgentTaskEntities(query),
        close: () => undefined,
      };
      const app = createApp(
        { ...ctx.deps, handoffStore, agentTaskStore: throwingAgentTaskStore },
        new Map([[TEST_KEY, TEST_NAMESPACE]]),
      );

      const resp = await app.request("/api/boardroom/summary", { headers: TEST_AUTH_HEADERS });
      expect(resp.status).toBe(200);

      const body = (await resp.json()) as {
        handoffs: {
          pending: number;
          blocked: number;
        };
      };

      expect(body.handoffs.pending).toBe(1);
      expect(body.handoffs.blocked).toBe(0);
    } finally {
      handoffStore.close();
      await ctx.cleanup();
    }
  });

  test("GET /api/boardroom/summary does not fall back to global handoffs for missing session scope", async () => {
    const ctx = await createTestContext();
    const globalHandoffStore = new InMemoryHandoffStore();
    try {
      await globalHandoffStore.create({
        handoffId: "global-handoff",
        sourceCid: "blake3:global",
        fromRole: "coder",
        toRole: "reviewer",
        requiresReply: true,
      });
      const app = createApp(
        {
          ...ctx.deps,
          handoffStore: globalHandoffStore,
          handoffStoreForSession: () => undefined,
        },
        new Map([[TEST_KEY, TEST_NAMESPACE]]),
      );

      const resp = await app.request("/api/boardroom/summary?sessionId=missing-session", {
        headers: TEST_AUTH_HEADERS,
      });
      expect(resp.status).toBe(200);

      const body = (await resp.json()) as {
        handoffs: {
          pending: number;
          overdue: number;
          blocked: number;
          deadLettered: number;
          items: unknown[];
        };
      };

      expect(body.handoffs).toEqual({
        pending: 0,
        overdue: 0,
        blocked: 0,
        deadLettered: 0,
        items: [],
      });
    } finally {
      globalHandoffStore.close();
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

      const resp = await ctx.app.request("/api/boardroom/summary", { headers: TEST_AUTH_HEADERS });
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

      const resp = await ctx.app.request("/api/boardroom/summary", { headers: TEST_AUTH_HEADERS });
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
        headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
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
        headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
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
        headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
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

  test("POST /api/boardroom/message delivers through injected messageDelivery", async () => {
    const ctx = await createTestContext();
    try {
      const delivered: DeliveredInboxMessage[] = [];
      const app = createApp(
        {
          ...ctx.deps,
          messageDelivery: {
            deliverMessage: async (message) => {
              delivered.push(message);
            },
          },
        },
        new Map([[TEST_KEY, TEST_NAMESPACE]]),
      );

      const resp = await app.request("/api/boardroom/message", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
        body: JSON.stringify({
          body: "boardroom delivery",
          recipients: ["@bob"],
        }),
      });

      const body = (await resp.json()) as { readonly cid: string };

      expect(resp.status).toBe(200);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.cid).toBe(body.cid);
      expect(delivered[0]?.body).toBe("boardroom delivery");
      expect(delivered[0]?.recipients).toEqual(["@bob"]);
      expect(delivered[0]?.from).toEqual({ agentId: "tui-operator", agentName: "operator" });
      expect(delivered[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await ctx.cleanup();
    }
  });

  test("POST /api/boardroom/message uses session-scoped delivery factory", async () => {
    const ctx = await createTestContext();
    try {
      const delivered: DeliveredInboxMessage[] = [];
      let capturedSessionId: string | undefined;
      const app = createApp(
        {
          ...ctx.deps,
          messageDelivery: {
            deliverMessage: async () => {
              throw new Error("default delivery should not run");
            },
          },
          messageDeliveryForSession: (sessionId) => {
            capturedSessionId = sessionId;
            return {
              deliverMessage: async (message) => {
                delivered.push(message);
              },
            };
          },
        },
        new Map([[TEST_KEY, TEST_NAMESPACE]]),
      );

      const resp = await app.request("/api/boardroom/message", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
        body: JSON.stringify({
          body: "session delivery",
          recipients: ["@bob"],
          sessionId: "session-123",
        }),
      });

      const body = (await resp.json()) as { readonly cid: string };

      expect(resp.status).toBe(200);
      expect(capturedSessionId).toBe("session-123");
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.cid).toBe(body.cid);
      expect(delivered[0]?.body).toBe("session delivery");
      expect(delivered[0]?.recipients).toEqual(["@bob"]);
      expect(delivered[0]?.from).toEqual({ agentId: "tui-operator", agentName: "operator" });
      expect(delivered[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await ctx.cleanup();
    }
  });

  test("POST /api/boardroom/message rejects missing fields", async () => {
    const ctx = await createTestContext();
    try {
      const resp = await ctx.app.request("/api/boardroom/message", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
        body: JSON.stringify({ body: "hello" }),
      });
      expect(resp.status).toBe(400);
    } finally {
      await ctx.cleanup();
    }
  });
});

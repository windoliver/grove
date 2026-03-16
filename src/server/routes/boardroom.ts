/**
 * Boardroom aggregation endpoint.
 *
 * Single endpoint that returns hot data for the TUI boardroom:
 * - Pending ask-user questions
 * - Recent inbox messages
 * - Agent cost summaries
 * - Active agent claims
 *
 * Reduces N separate polling requests to 1 (Issue #90, Decision 13A).
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { computeCid } from "../../core/manifest.js";
import { ContributionKind, RelationType } from "../../core/models.js";
import { answerQuestion } from "../../core/operations/ask-user-bus.js";
import { sendMessage } from "../../core/operations/messaging.js";
import type { ServerEnv } from "../deps.js";

// ---------------------------------------------------------------------------
// File-local schemas (not exported — avoids isolatedDeclarations issues)
// ---------------------------------------------------------------------------

const answerBodySchema = z.object({
  questionCid: z.string().min(1),
  answer: z.string().min(1),
});

const messageBodySchema = z.object({
  body: z.string().min(1),
  recipients: z.array(z.string().min(1)).min(1),
  inReplyTo: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BoardroomSummary {
  readonly pendingQuestions: readonly {
    readonly cid: string;
    readonly agentId: string;
    readonly agentName?: string;
    readonly question: string;
    readonly options?: readonly string[];
    readonly createdAt: string;
  }[];
  readonly recentMessages: readonly {
    readonly cid: string;
    readonly fromAgentId: string;
    readonly fromAgentName?: string;
    readonly body: string;
    readonly recipients: readonly string[];
    readonly createdAt: string;
  }[];
  readonly costSummary: {
    readonly totalCostUsd: number;
    readonly totalTokens: number;
    readonly byAgent: readonly {
      readonly agentId: string;
      readonly agentName?: string;
      readonly costUsd: number;
      readonly tokens: number;
    }[];
  };
  readonly activeClaimCount: number;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const boardroom: Hono<ServerEnv> = new Hono<ServerEnv>();

/**
 * GET /api/boardroom/summary
 *
 * Aggregated hot data for the TUI boardroom.
 * Replaces multiple polling requests with a single call.
 */
boardroom.get("/summary", async (c) => {
  const deps = c.get("deps");
  const store = deps.contributionStore;
  const claimStore = deps.claimStore;

  // Fetch ephemeral discussions in a single query
  const discussions = await store.list({
    kind: ContributionKind.Discussion,
    limit: 200,
  });

  const ephemeral = discussions.filter((d) => d.context?.ephemeral === true);

  // Partition into questions, answers, messages, and usage reports
  const questions = ephemeral.filter((d) => d.context?.ask_user_question === true);
  const answers = ephemeral.filter((d) => d.context?.ask_user_answer === true);
  const messages = ephemeral.filter(
    (d) => Array.isArray(d.context?.recipients) && d.context?.ask_user_question !== true,
  );
  const usageReports = ephemeral.filter((d) => d.context?.usage_report !== undefined);

  // Find answered question CIDs
  const answeredCids = new Set<string>();
  for (const a of answers) {
    for (const rel of a.relations) {
      if (rel.relationType === RelationType.RespondsTo) {
        answeredCids.add(rel.targetCid);
      }
    }
  }

  const now = Date.now();

  // Pending questions (unanswered, not expired)
  const pendingQuestions = questions
    .filter((q) => {
      if (answeredCids.has(q.cid)) return false;
      const expiresAt = q.context?.expires_at as string | undefined;
      if (expiresAt !== undefined && Date.parse(expiresAt) < now) return false;
      return true;
    })
    .map((q) => ({
      cid: q.cid,
      agentId: q.agent.agentId,
      ...(q.agent.agentName !== undefined ? { agentName: q.agent.agentName } : {}),
      question: (q.context?.question_text as string) ?? q.summary,
      ...(q.context?.question_options !== undefined
        ? { options: q.context.question_options as readonly string[] }
        : {}),
      createdAt: q.createdAt,
    }));

  // Recent messages (last 20)
  const recentMessages = messages
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 20)
    .map((m) => ({
      cid: m.cid,
      fromAgentId: m.agent.agentId,
      ...(m.agent.agentName !== undefined ? { fromAgentName: m.agent.agentName } : {}),
      body: (m.context?.message_body as string) ?? m.summary,
      recipients: (m.context?.recipients as readonly string[]) ?? [],
      createdAt: m.createdAt,
    }));

  // Aggregate cost data
  const agentCosts = new Map<
    string,
    { agentId: string; agentName?: string; costUsd: number; tokens: number }
  >();
  for (const r of usageReports) {
    const report = r.context?.usage_report as Record<string, unknown>;
    const inputTokens = (report?.input_tokens as number) ?? 0;
    const outputTokens = (report?.output_tokens as number) ?? 0;
    const costUsd = (report?.cost_usd as number) ?? 0;
    const tokens = inputTokens + outputTokens;

    const existing = agentCosts.get(r.agent.agentId);
    if (existing) {
      existing.costUsd += costUsd;
      existing.tokens += tokens;
    } else {
      agentCosts.set(r.agent.agentId, {
        agentId: r.agent.agentId,
        ...(r.agent.agentName !== undefined ? { agentName: r.agent.agentName } : {}),
        costUsd,
        tokens,
      });
    }
  }

  const byAgent = [...agentCosts.values()];

  // Active claim count (use countActiveClaims to avoid materializing all claim objects)
  const activeClaimCount = await claimStore.countActiveClaims();

  const summary: BoardroomSummary = {
    pendingQuestions,
    recentMessages,
    costSummary: {
      totalCostUsd: byAgent.reduce((s, a) => s + a.costUsd, 0),
      totalTokens: byAgent.reduce((s, a) => s + a.tokens, 0),
      byAgent,
    },
    activeClaimCount,
  };

  return c.json(summary);
});

/**
 * POST /api/boardroom/answer
 *
 * Answer a pending ask-user question from the TUI.
 * Body: { questionCid: string, answer: string }
 */
boardroom.post("/answer", zValidator("json", answerBodySchema), async (c) => {
  const deps = c.get("deps");
  const store = deps.contributionStore;

  const body = c.req.valid("json");

  const operator = { agentId: "tui-operator", agentName: "operator" };
  const contribution = await answerQuestion(
    store,
    { questionCid: body.questionCid, answer: body.answer, operator },
    computeCid,
  );

  return c.json({ cid: contribution.cid, answer: body.answer });
});

/**
 * POST /api/boardroom/message
 *
 * Send a message from the TUI operator.
 * Body: { body: string, recipients: string[], inReplyTo?: string }
 */
boardroom.post("/message", zValidator("json", messageBodySchema), async (c) => {
  const deps = c.get("deps");
  const store = deps.contributionStore;

  const body = c.req.valid("json");

  const operator = { agentId: "tui-operator", agentName: "operator" };
  const contribution = await sendMessage(
    store,
    { agent: operator, body: body.body, recipients: body.recipients, inReplyTo: body.inReplyTo },
    computeCid,
  );

  return c.json({ cid: contribution.cid, summary: contribution.summary });
});

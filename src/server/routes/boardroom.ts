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

import { contributionToEntity } from "../../core/entity.js";
import { HandoffStatus, type HandoffStore } from "../../core/handoff.js";
import {
  countHandoffOperatorStates,
  deriveHandoffOperatorProjection,
  type HandoffOperatorProjection,
  healthSignalsFromAgentTasks,
} from "../../core/handoff-operator-state.js";
import { computeCid } from "../../core/manifest.js";
import { ContributionKind, RelationType } from "../../core/models.js";
import { answerQuestion } from "../../core/operations/ask-user-bus.js";
import { sendMessageWithDelivery } from "../../core/operations/inbox-delegation.js";
import type { AgentTaskStore } from "../../core/store.js";
import type { ServerDeps, ServerEnv } from "../deps.js";
import { toOperationDeps } from "../operation-adapter.js";
import { contributionStoreForSession } from "./shared.js";

// ---------------------------------------------------------------------------
// File-local schemas (not exported — avoids isolatedDeclarations issues)
// ---------------------------------------------------------------------------

const summaryQuerySchema = z.object({
  sessionId: z.string().optional(),
});

const answerBodySchema = z.object({
  questionCid: z.string().min(1),
  answer: z.string().min(1),
  /** Optional session ID — attaches the answer contribution to the session. */
  sessionId: z.string().optional(),
});

const messageBodySchema = z.object({
  body: z.string().min(1),
  recipients: z.array(z.string().min(1)).min(1),
  inReplyTo: z.string().optional(),
  /** Optional session ID — attaches the message contribution to the session. */
  sessionId: z.string().optional(),
});

const ACTIONABLE_HANDOFF_STATUSES: readonly HandoffStatus[] = [
  HandoffStatus.PendingPickup,
  HandoffStatus.Delivered,
  HandoffStatus.Processed,
  HandoffStatus.Expired,
  HandoffStatus.DeadLettered,
];

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
  readonly handoffs: {
    readonly pending: number;
    readonly overdue: number;
    readonly blocked: number;
    readonly deadLettered: number;
    readonly items: readonly HandoffOperatorProjection[];
  };
}

function resolveHandoffStore(
  deps: ServerDeps,
  sessionId: string | undefined,
): HandoffStore | undefined {
  if (sessionId !== undefined) {
    const scoped = deps.handoffStoreForSession?.(sessionId);
    if (scoped !== undefined) return scoped;
  }

  return deps.handoffStore;
}

async function buildHandoffSummary(
  deps: ServerDeps,
  sessionId: string | undefined,
): Promise<BoardroomSummary["handoffs"]> {
  const handoffStore = resolveHandoffStore(deps, sessionId);
  if (handoffStore === undefined) {
    return { pending: 0, overdue: 0, blocked: 0, deadLettered: 0, items: [] };
  }

  await handoffStore.expireStale();
  const [handoffs, agentTasks] = await Promise.all([
    handoffStore.list({ status: ACTIONABLE_HANDOFF_STATUSES }),
    listAgentTasksForHandoffHealth(deps.agentTaskStore),
  ]);
  const healthSignalTasks =
    sessionId === undefined
      ? agentTasks
      : agentTasks.filter((task) => task.status.sessionId === sessionId);
  const healthSignals = healthSignalsFromAgentTasks(healthSignalTasks);
  const projections = handoffs.map((handoff) =>
    deriveHandoffOperatorProjection(handoff, { healthSignals }),
  );
  const counts = countHandoffOperatorStates(projections);

  return {
    ...counts,
    items: projections.slice(0, 20),
  };
}

async function listAgentTasksForHandoffHealth(
  agentTaskStore: AgentTaskStore | undefined,
): Promise<readonly import("../../core/agent-task.js").AgentTaskView[]> {
  if (agentTaskStore === undefined) return [];
  try {
    return await agentTaskStore.listAgentTasks();
  } catch {
    return [];
  }
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
boardroom.get("/summary", zValidator("query", summaryQuerySchema), async (c) => {
  const deps = c.get("deps");
  const claimStore = deps.claimStore;
  const { sessionId } = c.req.valid("query");
  const store = contributionStoreForSession(deps, sessionId);

  // Fetch ephemeral discussions in a single query, optionally scoped to a session
  const discussions = await store.list({
    kind: ContributionKind.Discussion,
    limit: 200,
    ...(sessionId !== undefined ? { sessionId } : {}),
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
  const handoffs = await buildHandoffSummary(deps, sessionId);

  const summary: BoardroomSummary = {
    pendingQuestions,
    recentMessages,
    costSummary: {
      totalCostUsd: byAgent.reduce((s, a) => s + a.costUsd, 0),
      totalTokens: byAgent.reduce((s, a) => s + a.tokens, 0),
      byAgent,
    },
    activeClaimCount,
    handoffs,
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
  const namespace = c.get("namespace");
  const { watchHub, watchSubscriber } = deps;
  const body = c.req.valid("json");
  const store = contributionStoreForSession(deps, body.sessionId);

  const operator = { agentId: "tui-operator", agentName: "operator" };
  const contribution = await answerQuestion(
    store,
    { questionCid: body.questionCid, answer: body.answer, operator },
    computeCid,
  );

  // Watch fan-out (#292). answerQuestion writes the contribution directly to
  // the store, bypassing the operations layer's onEntityWrite hook, so we
  // advance the WatchHub manually.
  //
  // Only fan out for non-session writes. When `sessionId` is set, the
  // write lands in the session-scoped store but `/api/list` reads the
  // process-global store, so emitting a watch event the lister can't
  // mirror would break the list→watch RV invariant. Session-scoped
  // watch is tracked as a follow-up.
  if (body.sessionId === undefined) {
    try {
      // Until T2/T3 lands per-mutation RV bump and threading through
      // write events, this projects RV=0 (matching the other
      // contribution-broadcast paths: watch-hub-recorder, serve.ts,
      // routes/watch.ts, nexus-contribution-store). Uniform 0 is
      // strictly better than asymmetric 0/1. Tracked in C6 (#304).
      const entity = contributionToEntity(contribution, namespace);
      watchHub.recordWrite({ kind: "Contribution", namespace, op: "ADDED", entity });
      watchSubscriber?.markSeen({
        kind: "Contribution",
        entityId: entity.id,
        generation: entity.metadata.generation,
      });
    } catch (err) {
      process.stderr.write(
        `[grove] Warning: watch fan-out threw after POST /api/boardroom/answer: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  // Link the answer contribution to the session so it is visible in scoped reads
  if (body.sessionId && deps.goalSessionStore) {
    await deps.goalSessionStore
      .addContributionToSession(body.sessionId, contribution.cid)
      .catch(() => {
        /* best-effort */
      });
  }

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
  const namespace = c.get("namespace");
  const body = c.req.valid("json");
  const store = contributionStoreForSession(deps, body.sessionId);

  // Inject namespace only for non-session writes (#292). When `sessionId`
  // is set, the write lands in the session-scoped store but `/api/list`
  // reads the process-global store, so firing a watch event the lister
  // can't mirror would violate the list→watch RV invariant. Session-scoped
  // watch is tracked as a follow-up.
  const baseOpDeps = toOperationDeps({ ...deps, contributionStore: store });
  const opDeps = body.sessionId === undefined ? { ...baseOpDeps, namespace } : baseOpDeps;
  const messageDelivery = deps.messageDeliveryForSession?.(body.sessionId) ?? deps.messageDelivery;
  const result = await sendMessageWithDelivery(
    {
      agent: { agentId: "tui-operator", agentName: "operator" },
      body: body.body,
      recipients: body.recipients,
      ...(body.inReplyTo !== undefined ? { inReplyTo: body.inReplyTo } : {}),
    },
    opDeps,
    messageDelivery,
  );

  if (!result.ok) {
    return c.json({ error: result.error.message }, 400);
  }

  // Link the message contribution to the session so it is visible in scoped reads
  if (body.sessionId && deps.goalSessionStore) {
    await deps.goalSessionStore
      .addContributionToSession(body.sessionId, result.value.cid)
      .catch(() => {
        /* best-effort */
      });
  }

  return c.json({ cid: result.value.cid, summary: result.value.summary });
});

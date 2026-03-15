/**
 * Cost tracking operations — structured agent token/cost reporting.
 *
 * Agents report usage via the `grove_report_usage` MCP tool. Reports
 * are stored as `discussion`-kind contributions with `ephemeral: true`
 * and `context.usage_report` structured data.
 *
 * This avoids fragile terminal output parsing (Issue #90, Decision 7A)
 * in favor of explicit, Zod-validated structured data.
 */

import { z } from "zod";

import type { AgentIdentity, Contribution, ContributionInput } from "../models.js";
import { ContributionKind, ContributionMode } from "../models.js";
import type { ContributionStore } from "../store.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Schema for a single usage report. */
export const UsageReportSchema: z.ZodObject<{
  input_tokens: z.ZodNumber;
  output_tokens: z.ZodNumber;
  model: z.ZodOptional<z.ZodString>;
  cost_usd: z.ZodOptional<z.ZodNumber>;
  cache_read_tokens: z.ZodOptional<z.ZodNumber>;
  cache_write_tokens: z.ZodOptional<z.ZodNumber>;
  context_window_percent: z.ZodOptional<z.ZodNumber>;
}> = z
  .object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    model: z.string().max(128).optional(),
    cost_usd: z.number().min(0).optional(),
    cache_read_tokens: z.number().int().min(0).optional(),
    cache_write_tokens: z.number().int().min(0).optional(),
    context_window_percent: z.number().min(0).max(100).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single usage report from an agent. */
export interface UsageReport {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model?: string | undefined;
  readonly costUsd?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
  readonly contextWindowPercent?: number | undefined;
}

/** Aggregated cost data for display. */
export interface AgentCostSummary {
  readonly agentId: string;
  readonly agentName?: string | undefined;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostUsd: number;
  readonly reportCount: number;
  readonly latestContextPercent?: number | undefined;
  readonly model?: string | undefined;
}

/** Session-wide cost totals. */
export interface SessionCostSummary {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostUsd: number;
  readonly byAgent: readonly AgentCostSummary[];
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Report agent usage as an ephemeral contribution.
 */
export async function reportUsage(
  store: ContributionStore,
  agent: AgentIdentity,
  report: UsageReport,
  computeCid: (input: ContributionInput) => string,
): Promise<Contribution> {
  const wireReport = {
    input_tokens: report.inputTokens,
    output_tokens: report.outputTokens,
    ...(report.model !== undefined && { model: report.model }),
    ...(report.costUsd !== undefined && { cost_usd: report.costUsd }),
    ...(report.cacheReadTokens !== undefined && { cache_read_tokens: report.cacheReadTokens }),
    ...(report.cacheWriteTokens !== undefined && { cache_write_tokens: report.cacheWriteTokens }),
    ...(report.contextWindowPercent !== undefined && {
      context_window_percent: report.contextWindowPercent,
    }),
  };

  // Validate the report
  const result = UsageReportSchema.safeParse(wireReport);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid usage report: ${issues}`);
  }

  const totalTokens = report.inputTokens + report.outputTokens;
  const costLabel = report.costUsd !== undefined ? ` $${report.costUsd.toFixed(4)}` : "";

  const contributionInput: ContributionInput = {
    kind: ContributionKind.Discussion,
    mode: ContributionMode.Exploration,
    summary: `Usage: ${formatTokenCount(totalTokens)} tokens${costLabel}`,
    artifacts: {},
    relations: [],
    tags: ["usage-report"],
    context: {
      ephemeral: true,
      usage_report: wireReport,
    },
    agent,
    createdAt: new Date().toISOString(),
  };

  const cid = computeCid(contributionInput);
  const contribution: Contribution = {
    ...contributionInput,
    cid,
    manifestVersion: 1,
  };

  await store.put(contribution);
  return contribution;
}

/**
 * Query aggregated cost data across agents.
 */
export async function getSessionCosts(store: ContributionStore): Promise<SessionCostSummary> {
  const contributions = await store.list({
    kind: ContributionKind.Discussion,
  });

  const usageContributions = contributions.filter(
    (c) => c.context?.ephemeral === true && c.context?.usage_report !== undefined,
  );

  const agentMap = new Map<string, AgentCostSummary>();

  for (const c of usageContributions) {
    const report = c.context?.usage_report as Record<string, unknown>;
    const inputTokens = (report.input_tokens as number) ?? 0;
    const outputTokens = (report.output_tokens as number) ?? 0;
    const costUsd = (report.cost_usd as number) ?? 0;
    const contextPercent = report.context_window_percent as number | undefined;
    const model = report.model as string | undefined;

    const existing = agentMap.get(c.agent.agentId);
    if (existing) {
      agentMap.set(c.agent.agentId, {
        ...existing,
        totalInputTokens: existing.totalInputTokens + inputTokens,
        totalOutputTokens: existing.totalOutputTokens + outputTokens,
        totalCostUsd: existing.totalCostUsd + costUsd,
        reportCount: existing.reportCount + 1,
        latestContextPercent: contextPercent ?? existing.latestContextPercent,
        model: model ?? existing.model,
      });
    } else {
      agentMap.set(c.agent.agentId, {
        agentId: c.agent.agentId,
        agentName: c.agent.agentName,
        totalInputTokens: inputTokens,
        totalOutputTokens: outputTokens,
        totalCostUsd: costUsd,
        reportCount: 1,
        latestContextPercent: contextPercent,
        model,
      });
    }
  }

  const byAgent = [...agentMap.values()];
  return {
    totalInputTokens: byAgent.reduce((sum, a) => sum + a.totalInputTokens, 0),
    totalOutputTokens: byAgent.reduce((sum, a) => sum + a.totalOutputTokens, 0),
    totalCostUsd: byAgent.reduce((sum, a) => sum + a.totalCostUsd, 0),
    byAgent,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format token count with K/M suffixes. */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

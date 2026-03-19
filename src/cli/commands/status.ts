/**
 * `grove status` — composite overview of agent state.
 *
 * Shows: agent identity, active claims, frontier top 3, latest plan progress.
 * Uses the `withCliDeps` pattern for store access.
 */

import { parseArgs } from "node:util";

import { ContributionKind } from "../../core/models.js";
import { resolveAgent } from "../../core/operations/agent.js";
import type { CliDeps } from "../context.js";
import { formatTimestamp, outputJson, truncateCid } from "../format.js";

export function parseStatusArgs(args: readonly string[]): { json: boolean } {
  const { values } = parseArgs({
    args: args as string[],
    options: {
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  return { json: values.json ?? false };
}

export async function runStatus(opts: { json: boolean }, deps: CliDeps): Promise<void> {
  const agent = resolveAgent();

  // Active claims for this agent
  const allClaims = await deps.claimStore.activeClaims();
  const myClaims = allClaims.filter((c) => c.agent.agentId === agent.agentId);

  // Frontier top 3 — collect from byRecency signal
  const frontier = await deps.frontier.compute({ limit: 3 });
  const topEntries = frontier.byRecency.slice(0, 3);

  // Latest plan — list() returns ASC order, so take the last entry
  const planContributions = await deps.store.list({
    kind: ContributionKind.Plan,
  });
  const latestPlan =
    planContributions.length > 0 ? planContributions[planContributions.length - 1] : undefined;

  if (opts.json) {
    const planTasks = latestPlan?.context?.tasks as
      | Array<{ id: string; title: string; status: string; assignee?: string }>
      | undefined;
    const done = planTasks?.filter((t) => t.status === "done").length ?? 0;
    outputJson({
      agent,
      claims: myClaims.map((c) => ({
        claimId: c.claimId,
        targetRef: c.targetRef,
        status: c.status,
      })),
      frontier: topEntries.map((e) => ({
        cid: e.cid,
        summary: e.summary,
        value: e.value,
      })),
      plan: latestPlan
        ? {
            cid: latestPlan.cid,
            title: latestPlan.context?.plan_title,
            taskCount: planTasks?.length ?? 0,
            done,
          }
        : null,
    });
    return;
  }

  // Agent identity
  console.log(`Agent: ${agent.agentId}${agent.role ? ` (${agent.role})` : ""}`);
  console.log();

  // Claims
  if (myClaims.length > 0) {
    console.log(`Active claims (${myClaims.length}):`);
    for (const c of myClaims) {
      console.log(`  ${c.claimId.slice(0, 8)}  ${c.targetRef}  ${c.intentSummary}`);
    }
  } else {
    console.log("Active claims: none");
  }
  console.log();

  // Frontier
  if (topEntries.length > 0) {
    console.log("Frontier (top 3):");
    for (const e of topEntries) {
      const cid = truncateCid(e.cid);
      const summary = e.summary.length > 40 ? `${e.summary.slice(0, 38)}..` : e.summary;
      console.log(`  ${cid}  ${summary}  [${e.value}]`);
    }
  } else {
    console.log("Frontier: empty");
  }
  console.log();

  // Plan
  if (latestPlan) {
    const title = (latestPlan.context?.plan_title as string) ?? "Untitled";
    const tasks = (latestPlan.context?.tasks as Array<{ status: string }>) ?? [];
    const done = tasks.filter((t) => t.status === "done").length;
    console.log(
      `Plan: ${title} — ${done}/${tasks.length} done  (${formatTimestamp(latestPlan.createdAt)})`,
    );
  } else {
    console.log("Plan: none");
  }
}

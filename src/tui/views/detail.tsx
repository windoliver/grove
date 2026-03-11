/**
 * Contribution detail view — full manifest, relations, artifacts, thread.
 *
 * Includes outcome annotation when available (Phase 5).
 */

import React, { useCallback } from "react";
import type { OutcomeRecord } from "../../core/outcome.js";
import { formatScore, formatTimestamp, truncateCid } from "../../shared/format.js";
import { OutcomeBadge } from "../components/outcome-badge.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { ContributionDetail, TuiDataProvider, TuiOutcomeProvider } from "../provider.js";

/** Props for the Detail view. */
export interface DetailProps {
  readonly provider: TuiDataProvider;
  readonly cid: string;
  readonly intervalMs: number;
}

/** Contribution detail view component. */
export const DetailView: React.NamedExoticComponent<DetailProps> = React.memo(function DetailView({
  provider,
  cid,
  intervalMs,
}: DetailProps): React.ReactNode {
  const fetcher = useCallback(() => provider.getContribution(cid), [provider, cid]);
  const { data, loading } = usePolledData<ContributionDetail | undefined>(
    fetcher,
    intervalMs,
    true,
  );

  // Fetch outcome for this CID if available
  const outcomeProvider = provider.capabilities.outcomes
    ? (provider as unknown as TuiOutcomeProvider)
    : undefined;

  const outcomeFetcher = useCallback(
    () => outcomeProvider?.getOutcome(cid) ?? Promise.resolve(undefined),
    [outcomeProvider, cid],
  );
  const { data: outcome } = usePolledData<OutcomeRecord | undefined>(
    outcomeFetcher,
    intervalMs,
    true,
  );

  if (loading && !data) {
    return (
      <box>
        <text opacity={0.5}>Loading {truncateCid(cid)}...</text>
      </box>
    );
  }

  if (!data) {
    return (
      <box>
        <text color="#ff0000">Contribution not found: {cid}</text>
      </box>
    );
  }

  const { contribution: c, ancestors, children, thread } = data;

  return (
    <box flexDirection="column">
      <box marginBottom={1}>
        <text color="#00cccc">{c.cid}</text>
        {outcome && (
          <>
            <text> </text>
            <OutcomeBadge status={outcome.status} />
          </>
        )}
      </box>

      <box flexDirection="column" marginBottom={1}>
        <text>
          Kind: {c.kind} Mode: {c.mode} Created: {formatTimestamp(c.createdAt)}
        </text>
        <text>
          Agent: {c.agent.agentName ?? c.agent.agentId}
          {c.agent.model ? ` (${c.agent.model})` : ""}
          {c.agent.platform ? ` on ${c.agent.platform}` : ""}
        </text>
        {c.tags.length > 0 && <text>Tags: {c.tags.join(", ")}</text>}
      </box>

      {/* Outcome annotation */}
      {outcome && (
        <box flexDirection="column" marginBottom={1}>
          <text>Outcome</text>
          <text>
            Status: {outcome.status} By: {outcome.evaluatedBy} At:{" "}
            {formatTimestamp(outcome.evaluatedAt)}
          </text>
          {outcome.reason && <text opacity={0.5}>Reason: {outcome.reason}</text>}
          {outcome.baselineCid && (
            <text opacity={0.5}>Baseline: {truncateCid(outcome.baselineCid)}</text>
          )}
        </box>
      )}

      <box flexDirection="column" marginBottom={1}>
        <text>Summary</text>
        <text>{c.summary}</text>
        {c.description && (
          <box marginTop={1}>
            <text opacity={0.5}>{c.description.slice(0, 500)}</text>
          </box>
        )}
      </box>

      {c.scores && Object.keys(c.scores).length > 0 && (
        <box flexDirection="column" marginBottom={1}>
          <text>Scores</text>
          {Object.entries(c.scores).map(([name, score]) => (
            <text key={name}>
              {name}: {formatScore(score)} ({score.direction})
            </text>
          ))}
        </box>
      )}

      {c.relations.length > 0 && (
        <box flexDirection="column" marginBottom={1}>
          <text>Relations ({c.relations.length})</text>
          {c.relations.map((r, i) => (
            <text key={`rel-${String(i)}`}>
              {r.relationType} → {truncateCid(r.targetCid)}
            </text>
          ))}
        </box>
      )}

      {Object.keys(c.artifacts).length > 0 && (
        <box flexDirection="column" marginBottom={1}>
          <text>Artifacts ({Object.keys(c.artifacts).length})</text>
          {Object.entries(c.artifacts).map(([name, hash]) => (
            <text key={name}>
              {name}: {truncateCid(hash)}
            </text>
          ))}
        </box>
      )}

      {ancestors.length > 0 && (
        <box flexDirection="column" marginBottom={1}>
          <text>Ancestors ({ancestors.length})</text>
          {ancestors.map((a) => (
            <text key={a.cid}>
              {truncateCid(a.cid)} [{a.kind}] {a.summary.slice(0, 50)}
            </text>
          ))}
        </box>
      )}

      {children.length > 0 && (
        <box flexDirection="column" marginBottom={1}>
          <text>Children ({children.length})</text>
          {children.map((ch) => (
            <text key={ch.cid}>
              {truncateCid(ch.cid)} [{ch.kind}] {ch.summary.slice(0, 50)}
            </text>
          ))}
        </box>
      )}

      {thread.length > 1 && (
        <box flexDirection="column">
          <text>Discussion ({thread.length - 1} replies)</text>
          {thread.slice(1).map((node) => (
            <text key={node.contribution.cid}>
              {"  ".repeat(node.depth)}
              {truncateCid(node.contribution.cid)} {node.contribution.summary.slice(0, 40)} [
              {node.contribution.agent.agentName ?? node.contribution.agent.agentId}]{" "}
              {formatTimestamp(node.contribution.createdAt)}
            </text>
          ))}
        </box>
      )}

      {c.context && Object.keys(c.context).length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <text>Context</text>
          <text opacity={0.5}>{JSON.stringify(c.context, null, 2).slice(0, 300)}</text>
        </box>
      )}
    </box>
  );
});

/**
 * Contribution detail view — full manifest, relations, artifacts, thread.
 *
 * Includes outcome annotation when available (Phase 5).
 *
 * PR2 (#388): the contribution body subscription migrates to
 * `useEntity("Contribution", cid)` when a factory is mounted. Ancestors,
 * children, thread, and outcome read via `useEventDrivenData` — those
 * fields aren't on the Entity envelope (they're a relation graph the
 * server computes on demand). A future PR may lift the relation graph
 * into `useDerived`.
 */

import React, { useCallback } from "react";
import { contributionToEntity } from "../../core/entity.js";
import type { OutcomeRecord } from "../../core/outcome.js";
import { formatScore, formatTimestamp, truncateCid } from "../../shared/format.js";
import { ConditionChips } from "../components/condition-chips.js";
import { DataStatus } from "../components/data-status.js";
import { OutcomeBadge } from "../components/outcome-badge.js";
import { useEntityWatchEnabled } from "../hooks/informer-context.js";
import { useEntity } from "../hooks/use-entity.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import type { ContributionDetail, TuiDataProvider, TuiOutcomeProvider } from "../provider.js";
import { theme } from "../theme.js";

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
  const useInformerPath = useEntityWatchEnabled(provider, "Contribution");

  // useEntity for the body — fast subscribe to the cache. The relation
  // graph still needs the full ContributionDetail fetch below.
  const entityResult = useEntity("Contribution", cid);

  const fetcher = useCallback(() => provider.getContribution(cid), [provider, cid]);
  const {
    data: detail,
    loading,
    isStale,
    error,
  } = useEventDrivenData<ContributionDetail | undefined>(fetcher, undefined, undefined, true);

  // Fetch outcome for this CID if available
  const outcomeProvider = provider.capabilities.outcomes
    ? (provider as unknown as TuiOutcomeProvider)
    : undefined;

  const outcomeFetcher = useCallback(
    () => outcomeProvider?.getOutcome(cid) ?? Promise.resolve(undefined),
    [outcomeProvider, cid],
  );
  const { data: outcome } = useEventDrivenData<OutcomeRecord | undefined>(
    outcomeFetcher,
    undefined,
    undefined,
    true,
  );

  // Body source: prefer the informer-cached entity when available, else
  // project from the polled detail.
  const bodyEntity =
    useInformerPath && entityResult.data
      ? entityResult.data
      : detail
        ? contributionToEntity(detail.contribution, "default")
        : undefined;

  if (loading && !detail && !bodyEntity) {
    return (
      <box>
        <text opacity={0.5}>Loading {truncateCid(cid)}...</text>
      </box>
    );
  }

  if (!detail && !bodyEntity) {
    return (
      <box>
        <text color={theme.error}>Contribution not found: {cid}</text>
      </box>
    );
  }

  const ancestors = detail?.ancestors ?? [];
  const children = detail?.children ?? [];
  const thread = detail?.thread ?? [];
  // Narrowed: the early return above ensures bodyEntity is defined when
  // we reach this point. Use a runtime-asserted alias to satisfy strict
  // null checks without a non-null assertion (biome-disallowed).
  if (!bodyEntity) return null;
  const entity = bodyEntity;
  const cidStr = entity.id;
  const kind = entity.spec.contributionKind;
  const mode = entity.spec.mode;
  const summary = entity.spec.summary;
  const description = entity.spec.description;
  const tags = entity.spec.tags;
  const scores = entity.spec.scores;
  const relations = entity.spec.relations;
  const artifacts = entity.spec.artifacts;
  const context = entity.spec.context;
  const agent = entity.spec.agent;
  const createdAt = entity.metadata.creationTimestamp ?? "";

  return (
    <box flexDirection="column">
      <ConditionChips conditions={entity.conditions} />
      <box marginBottom={1} flexDirection="row">
        <text color={theme.focus}>{cidStr}</text>
        <DataStatus loading={loading && !detail} isStale={isStale} error={error?.message} />
        {outcome && (
          <>
            <text> </text>
            <OutcomeBadge status={outcome.status} />
          </>
        )}
      </box>

      <box flexDirection="column" marginBottom={1}>
        <text>
          Kind: {kind} Mode: {mode} Created: {formatTimestamp(createdAt)}
        </text>
        <text>
          Agent: {agent?.agentName ?? agent?.agentId ?? "unknown"}
          {agent?.model ? ` (${agent.model})` : ""}
          {agent?.platform ? ` on ${agent.platform}` : ""}
        </text>
        {(tags ?? []).length > 0 && <text>Tags: {(tags ?? []).join(", ")}</text>}
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
        <markdown>{summary}</markdown>
        {description && (
          <box marginTop={1}>
            <markdown>{description.slice(0, 500)}</markdown>
          </box>
        )}
      </box>

      {scores && Object.keys(scores).length > 0 && (
        <box flexDirection="column" marginBottom={1}>
          <text>Scores</text>
          {Object.entries(scores).map(([name, score]) => (
            <text key={name}>
              {name}: {formatScore(score)} ({score.direction})
            </text>
          ))}
        </box>
      )}

      {(relations ?? []).length > 0 && (
        <box flexDirection="column" marginBottom={1}>
          <text>{`Relations (${(relations ?? []).length})`}</text>
          {(relations ?? []).map((r, i) => (
            <text key={`rel-${String(i)}`}>
              {r.relationType} → {truncateCid(r.targetCid)}
            </text>
          ))}
        </box>
      )}

      {Object.keys(artifacts).length > 0 && (
        <box flexDirection="column" marginBottom={1}>
          <text>{`Artifacts (${Object.keys(artifacts).length})`}</text>
          {Object.entries(artifacts).map(([name, hash]) => (
            <text key={name}>
              {name}: {truncateCid(hash)}
            </text>
          ))}
        </box>
      )}

      {ancestors.length > 0 && (
        <box flexDirection="column" marginBottom={1}>
          <text>{`Ancestors (${ancestors.length})`}</text>
          {ancestors.map((a) => (
            <text key={a.cid}>
              {truncateCid(a.cid)} [{a.kind}] {a.summary.slice(0, 50)}
            </text>
          ))}
        </box>
      )}

      {children.length > 0 && (
        <box flexDirection="column" marginBottom={1}>
          <text>{`Children (${children.length})`}</text>
          {children.map((ch) => (
            <text key={ch.cid}>
              {truncateCid(ch.cid)} [{ch.kind}] {ch.summary.slice(0, 50)}
            </text>
          ))}
        </box>
      )}

      {thread.length > 1 && (
        <box flexDirection="column">
          <text>{`Discussion (${thread.length - 1} replies)`}</text>
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

      {context && Object.keys(context).length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <text>Context</text>
          <text opacity={0.5}>{JSON.stringify(context, null, 2).slice(0, 300)}</text>
        </box>
      )}
    </box>
  );
});

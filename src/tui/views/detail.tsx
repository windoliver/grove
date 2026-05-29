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
import { useAccentPulse } from "../hooks/use-accent-pulse.js";
import { useEntity } from "../hooks/use-entity.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import type { ContributionDetail, TuiDataProvider, TuiOutcomeProvider } from "../provider.js";
import { theme } from "../theme.js";

/** Props for the Detail view. */
export interface DetailProps {
  readonly provider: TuiDataProvider;
  readonly cid: string;
  readonly intervalMs: number;
  /**
   * Raw focused-section index. The view maps it onto the list of
   * *present* sections via modulo, so the parent reducer can advance it
   * freely (positive or negative) without knowing which sections have
   * data. See {@link SECTION_ORDER}.
   */
  readonly focusedSectionRaw?: number | undefined;
}

/**
 * Focus-ring order for detail sections. The focus cursor iterates only
 * the sections that currently have data (see `present` below).
 */
const SECTION_ORDER = [
  "summary",
  "scores",
  "relations",
  "artifacts",
  "ancestors",
  "children",
  "discussion",
  "context",
] as const;
type SectionKey = (typeof SECTION_ORDER)[number];

/** Contribution detail view component. */
export const DetailView: React.NamedExoticComponent<DetailProps> = React.memo(function DetailView({
  provider,
  cid,
  intervalMs,
  focusedSectionRaw,
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

  // Focus-change accent pulse (#192): a brief (~150ms) warning-colored flash
  // on the focused section border each time the focused section changes.
  const pulse = useAccentPulse(focusedSectionRaw);

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

  // Which sections currently carry data — mirrors each block's render
  // guard below. Drives the focus ring and the scroll-into-view offset.
  const sectionHasData = (key: SectionKey): boolean => {
    switch (key) {
      case "summary":
        return true;
      case "scores":
        return !!scores && Object.keys(scores).length > 0;
      case "relations":
        return (relations ?? []).length > 0;
      case "artifacts":
        return Object.keys(artifacts).length > 0;
      case "ancestors":
        return ancestors.length > 0;
      case "children":
        return children.length > 0;
      case "discussion":
        return thread.length > 1;
      case "context":
        return !!context && Object.keys(context).length > 0;
    }
  };
  const present = SECTION_ORDER.filter(sectionHasData);
  const raw = focusedSectionRaw ?? 0;
  const focusedIndexAmongPresent = present.length
    ? ((raw % present.length) + present.length) % present.length
    : 0;
  const focusedKey: SectionKey | undefined = present.length
    ? present[focusedIndexAmongPresent]
    : undefined;

  // Scroll-into-view: sum the ESTIMATED rendered height of every present
  // section ABOVE the focused one, so the focused section is scrolled to the
  // top of the viewport. A fixed per-section estimate fails here because this
  // view renders full (untruncated) descriptions/context — a long Summary can
  // be hundreds of rows, so a constant offset would leave the focused section
  // far offscreen. Line counts are a cheap proxy for rendered height (markdown
  // may wrap longer, but the offset stays proportional to content above).
  const countLines = (s: string | undefined): number => (s ? s.split("\n").length : 0);
  const estimateSectionRows = (key: SectionKey): number => {
    const TITLE_AND_MARGIN = 2;
    switch (key) {
      case "summary":
        return (
          TITLE_AND_MARGIN + countLines(summary) + (description ? countLines(description) + 1 : 0)
        );
      case "scores":
        return TITLE_AND_MARGIN + Object.keys(scores ?? {}).length;
      case "relations":
        return TITLE_AND_MARGIN + (relations ?? []).length;
      case "artifacts":
        return TITLE_AND_MARGIN + Object.keys(artifacts).length;
      case "ancestors":
        return TITLE_AND_MARGIN + ancestors.length;
      case "children":
        return TITLE_AND_MARGIN + children.length;
      case "discussion":
        return TITLE_AND_MARGIN + Math.max(0, thread.length - 1);
      case "context":
        return (
          TITLE_AND_MARGIN + countLines(context ? JSON.stringify(context, null, 2) : undefined)
        );
    }
  };
  const scrollTop = present
    .slice(0, focusedIndexAmongPresent)
    .reduce((sum, key) => sum + estimateSectionRows(key), 0);

  // Accent treatment for the focused section: a single-line border in the
  // focus color plus a ">" title marker. During the focus-change pulse the
  // border flashes to the warning accent. `border` is controlled EXPLICITLY
  // (true/false) on every section: OpenTUI's BoxRenderable keeps its internal
  // `border` flag set once a box has been bordered, and clearing only
  // borderStyle/borderColor does not unset it — so omitting border props on
  // unfocused sections would leave stale borders accumulating as focus moves.
  const focusBorderColor = pulse ? theme.warning : theme.focus;
  const sectionProps = (
    key: SectionKey,
  ): { border: boolean; borderStyle?: "single"; borderColor?: string } =>
    key === focusedKey
      ? { border: true, borderStyle: "single", borderColor: focusBorderColor }
      : { border: false };
  const titlePrefix = (key: SectionKey): string => (key === focusedKey ? "> " : "");

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

      {React.createElement(
        "scrollbox" as string,
        { flexGrow: 1, scrollTop },
        <box flexDirection="column">
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

          <box flexDirection="column" marginBottom={1} {...sectionProps("summary")}>
            <text>{`${titlePrefix("summary")}Summary`}</text>
            <markdown>{summary}</markdown>
            {description && (
              <box marginTop={1}>
                <markdown>{description}</markdown>
              </box>
            )}
          </box>

          {scores && Object.keys(scores).length > 0 && (
            <box flexDirection="column" marginBottom={1} {...sectionProps("scores")}>
              <text>{`${titlePrefix("scores")}Scores`}</text>
              {Object.entries(scores).map(([name, score]) => (
                <text key={name}>
                  {name}: {formatScore(score)} ({score.direction})
                </text>
              ))}
            </box>
          )}

          {(relations ?? []).length > 0 && (
            <box flexDirection="column" marginBottom={1} {...sectionProps("relations")}>
              <text>{`${titlePrefix("relations")}Relations (${(relations ?? []).length})`}</text>
              {(relations ?? []).map((r, i) => (
                <text key={`rel-${String(i)}`}>
                  {r.relationType} → {truncateCid(r.targetCid)}
                </text>
              ))}
            </box>
          )}

          {Object.keys(artifacts).length > 0 && (
            <box flexDirection="column" marginBottom={1} {...sectionProps("artifacts")}>
              <text>{`${titlePrefix("artifacts")}Artifacts (${Object.keys(artifacts).length})`}</text>
              {Object.entries(artifacts).map(([name, hash]) => (
                <text key={name}>
                  {name}: {truncateCid(hash)}
                </text>
              ))}
            </box>
          )}

          {ancestors.length > 0 && (
            <box flexDirection="column" marginBottom={1} {...sectionProps("ancestors")}>
              <text>{`${titlePrefix("ancestors")}Ancestors (${ancestors.length})`}</text>
              {ancestors.map((a) => (
                <text key={a.cid}>
                  {truncateCid(a.cid)} [{a.kind}] {a.summary}
                </text>
              ))}
            </box>
          )}

          {children.length > 0 && (
            <box flexDirection="column" marginBottom={1} {...sectionProps("children")}>
              <text>{`${titlePrefix("children")}Children (${children.length})`}</text>
              {children.map((ch) => (
                <text key={ch.cid}>
                  {truncateCid(ch.cid)} [{ch.kind}] {ch.summary}
                </text>
              ))}
            </box>
          )}

          {thread.length > 1 && (
            <box flexDirection="column" {...sectionProps("discussion")}>
              <text>{`${titlePrefix("discussion")}Discussion (${thread.length - 1} replies)`}</text>
              {thread.slice(1).map((node) => (
                <text key={node.contribution.cid}>
                  {"  ".repeat(node.depth)}
                  {truncateCid(node.contribution.cid)} {node.contribution.summary} [
                  {node.contribution.agent.agentName ?? node.contribution.agent.agentId}]{" "}
                  {formatTimestamp(node.contribution.createdAt)}
                </text>
              ))}
            </box>
          )}

          {context && Object.keys(context).length > 0 && (
            <box flexDirection="column" marginTop={1} {...sectionProps("context")}>
              <text>{`${titlePrefix("context")}Context`}</text>
              <text opacity={0.5}>{JSON.stringify(context, null, 2)}</text>
            </box>
          )}
        </box>,
      )}
    </box>
  );
});

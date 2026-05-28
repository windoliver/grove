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

import * as OpenTuiReact from "@opentui/react";
import React, { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * Resolve `useTimeline` once at module load. In production the real
 * `@opentui/react` always exports it; under tests a leaked `mock.module`
 * (process-wide, not auto-restored) may replace the module with one that omits
 * `useTimeline`, which would make the call below `undefined(...)` and crash
 * render. Fall back to a no-op chainable so the pulse degrades to a static
 * accent rather than throwing — the hook is still called unconditionally.
 */
const useTimeline: typeof OpenTuiReact.useTimeline =
  OpenTuiReact.useTimeline ??
  (((): { add: () => unknown; play: () => unknown } => ({
    add: () => ({ add: () => ({ play: () => undefined }), play: () => undefined }),
    play: () => undefined,
  })) as unknown as typeof OpenTuiReact.useTimeline);

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

/**
 * Coarse per-section row estimate used to derive a scroll offset that
 * keeps the focused section on screen. Need not be pixel-exact — it only
 * has to advance the scroll surface as focus moves down the ring.
 */
const APPROX_SECTION_ROWS = 6;

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
  // Driven entirely from inside useEffect so a plain react-test-renderer
  // mount/update is a no-op (no throw, no timer leak). Degrades to a static
  // accent if useTimeline is unavailable at runtime.
  const PULSE_MS = 150;
  const timeline = useTimeline({ duration: PULSE_MS });
  const [pulse, setPulse] = useState(false);
  const prevFocusRef = useRef<number | undefined>(focusedSectionRaw);
  useEffect(() => {
    const next = focusedSectionRaw;
    // Skip the initial mount / no-change re-renders: only pulse when the
    // focused section actually changes.
    if (prevFocusRef.current === next) return;
    prevFocusRef.current = next;
    setPulse(true);
    let cleared = false;
    const clear = (): void => {
      if (!cleared) {
        cleared = true;
        setPulse(false);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Drive a throwaway target so the renderer's animation engine runs the
      // clock; clear the accent when the tween completes.
      const target = { t: 0 };
      timeline
        .add(target, {
          t: 1,
          duration: PULSE_MS,
          onUpdate: (anim: { targets: object[] }) => {
            const v = (anim.targets[0] as { t: number }).t;
            if (v >= 1) clear();
          },
        })
        .play();
    } catch {
      // useTimeline/engine unavailable — fall through to the timer fallback.
    }
    // Timer fallback guarantees the accent clears even without a live engine.
    timer = setTimeout(clear, PULSE_MS + 20);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [focusedSectionRaw, timeline]);

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

  // Coarse scroll offset: advance the surface as the focused section moves
  // down the ring so the active section stays visible. Need not be exact.
  const scrollTop = focusedIndexAmongPresent * APPROX_SECTION_ROWS;

  // Accent treatment for the focused section: a single-line border in the
  // focus color plus a ">" title marker. Non-focused sections get nothing.
  // During the focus-change pulse the border flashes to the warning accent.
  const focusBorderColor = pulse ? theme.warning : theme.focus;
  const sectionProps = (key: SectionKey): { borderStyle?: "single"; borderColor?: string } =>
    key === focusedKey ? { borderStyle: "single", borderColor: focusBorderColor } : {};
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

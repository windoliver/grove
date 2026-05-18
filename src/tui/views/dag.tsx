/**
 * Xray-style collapsible DAG view (issue #311 C5).
 *
 * Replaces the git-style multi-lane renderer with a hierarchical tree
 * rooted at the focused contribution (or all roots if no focus). Each
 * row shows a status icon (running/done/failed/blocked/awaiting-review/
 * idle), the contribution summary, and a relation-type tag when the
 * incoming edge is not a plain derives_from.
 *
 * Expansion state lives in DagStateStore (above the view), so it
 * survives mount/unmount across page switches. Highlight applies
 * model-layer foreground color without filtering rows out.
 *
 * Live updates: useInformerOptional("Contribution") and ("Claim")
 * deliver push updates within the informer's emit window (<200ms in
 * practice; gated only by the underlying RV propagation). When the
 * informer path is unavailable the view falls back to polling
 * provider.getDag() / provider.getClaims({ status: "active" }).
 */

import { useKeyboard } from "@opentui/react";
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import type { ClaimEntity, ContributionEntity } from "../../core/entity.js";
import type { Claim, Contribution } from "../../core/models.js";
import type { OutcomeRecord } from "../../core/outcome.js";
import { compareTimestampsDesc } from "../../shared/format.js";
import { DagStatusIcon } from "../components/dag-status-icon.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { useDagState } from "../hooks/dag-state-context.js";
import {
  useEntityWatchEnabled,
  useInformerOptional,
  useProviderScoped,
} from "../hooks/informer-context.js";
import { useDerived } from "../hooks/use-derived.js";
import { shallowArraysEqual } from "../hooks/use-entities.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import { useNowTicker } from "../hooks/use-now-ticker.js";
import type { DagData, TuiDataProvider, TuiOutcomeProvider } from "../provider.js";
import { theme } from "../theme.js";
import { projectDagTree, type RenderRow } from "./dag-tree-projection.js";

/** Cap on newest "head" contributions seeded into the DAG; matches the
 *  polled `dagFromStore` cap (`store.list({ limit: 200 })`). */
const DAG_CONTRIBUTION_LIMIT = 200;

/** Hard upper bound after BFS-including ancestors of the head set. */
const DAG_TOTAL_CAP = 500;

/** Project a ContributionEntity back to the flat Contribution shape the
 *  projection renderer reads. */
function entityToContribution(e: ContributionEntity): Contribution {
  return {
    cid: e.id,
    manifestVersion: 0,
    kind: e.spec.contributionKind,
    mode: e.spec.mode,
    summary: e.spec.summary,
    description: e.spec.description,
    artifacts: e.spec.artifacts,
    relations: e.spec.relations,
    scores: e.spec.scores,
    tags: e.spec.tags,
    context: e.spec.context,
    agent: e.spec.agent,
    createdAt: e.metadata.creationTimestamp ?? "",
  };
}

/** Project a ClaimEntity back to the flat Claim shape that
 *  `projectDagTree` consumes. Uses `persistedPhase` (raw store state)
 *  rather than the lease-aware `phase` so a still-persisted-active claim
 *  whose lease has just expired reaches `deriveDagStatus` as
 *  `status: "active"` — the status helper itself then compares
 *  `leaseExpiresAt` against `now` and returns `blocked`. If we mapped
 *  the lease-collapsed `phase` here instead, expired-but-not-yet-purged
 *  claims would render as `awaiting-review`/`idle` after a relist. */
function entityToClaim(e: ClaimEntity): Claim {
  // Always uses `persistedPhase` (raw store state); the derivedClaims
  // projector throws when the field is missing so this helper only
  // runs on modern payloads. Mapping `persistedPhase` ensures an active
  // claim whose lease just expired reaches `deriveDagStatus` with
  // `status: "active"`, which then flips it to `blocked` via the lease
  // check.
  const persisted = e.status.persistedPhase;
  return {
    claimId: e.id,
    targetRef: e.spec.targetRef,
    agent: e.spec.agent,
    status: persisted,
    intentSummary: e.spec.intentSummary,
    createdAt: e.metadata.creationTimestamp ?? e.status.heartbeatAt,
    heartbeatAt: e.status.heartbeatAt,
    leaseExpiresAt: e.status.leaseExpiresAt,
    context: e.spec.context,
    attemptCount: e.status.attemptCount,
  };
}

const KIND_COLORS: Record<string, string> = {
  work: theme.work,
  review: theme.review,
  discussion: theme.discussion,
  adoption: theme.adoption,
  reproduction: theme.reproduction,
};

const EDGE_LABEL: Record<string, string> = {
  reviews: "rev",
  reproduces: "rep",
  adopts: "adopt",
  // derives_from rendered without a label.
};

/** Props for the xray DagView. */
export interface DagProps {
  readonly provider: TuiDataProvider;
  readonly active: boolean;
  readonly cursor: number;
  readonly onContributionsLoaded?: (contributions: readonly Contribution[]) => void;
  /** #311: model-layer match string. Highlights matching rows; does NOT
   *  filter non-matches. Renamed from `filterText` (C2) to reflect the
   *  new no-filter semantics in the xray view. */
  readonly highlightText?: string | undefined;
  /** When true, DAG-local keyboard shortcuts (space / Shift+A / Shift+Z)
   *  are armed. Parents MUST keep this false during modal input — command
   *  palette, prompt mode, `/` filter, help overlay — so a space typed
   *  into a text field does not silently toggle the focused DAG row.
   *  Default `false`. */
  readonly keysEnabled?: boolean;
  /** Optional: when set, the DAG biases focus toward this agent. Plumbed
   *  for supervision drill-down (#193); narrowing behavior is a follow-up.
   *  Default (unfiltered) behavior is preserved when omitted. */
  readonly filterAgentId?: string | undefined;
}

/** Xray-style DAG view (issue #311 C5). */
export const DagView: React.NamedExoticComponent<DagProps> = React.memo(function DagView({
  provider,
  active,
  cursor,
  onContributionsLoaded,
  highlightText,
  keysEnabled = false,
}: DagProps): React.ReactNode {
  const { store, snapshot } = useDagState();
  const effectiveHighlight = (highlightText ?? snapshot.highlight).trim().toLowerCase();

  // Keep store.highlight in sync with the prop so command-mode /foo flows
  // remain canonical even when other consumers also read from the store.
  useEffect(() => {
    if (highlightText !== undefined && highlightText !== snapshot.highlight) {
      store.setHighlight(highlightText);
    }
  }, [highlightText, snapshot.highlight, store]);

  const useContribWatch = useEntityWatchEnabled(provider, "Contribution");
  const useClaimWatch = useEntityWatchEnabled(provider, "Claim");
  // Scoped sessions: `provider.getClaims` is namespace-global (no session
  // filter), so unconditionally feeding it into status derivation would
  // surface running/blocked icons sourced from OTHER sessions' claims.
  // Mirror the agent-list/claims-view short-circuit until session-scoped
  // claim filtering lands.
  const isScopedForClaims = useProviderScoped(provider);

  const contribInformer = useInformerOptional("Contribution");
  const claimInformer = useInformerOptional("Claim");

  const derivedContributions = useDerived<readonly Contribution[]>(
    () => {
      const all = contribInformer.list() as readonly ContributionEntity[];
      const sorted = [...all].sort((a, b) =>
        compareTimestampsDesc(a.metadata.creationTimestamp, b.metadata.creationTimestamp),
      );
      if (sorted.length <= DAG_CONTRIBUTION_LIMIT) {
        return sorted.map(entityToContribution);
      }
      const byId = new Map(sorted.map((e) => [e.id, e]));
      const kept = new Set<string>();
      const queue: ContributionEntity[] = [];
      for (const e of sorted) {
        if (kept.size >= DAG_CONTRIBUTION_LIMIT) break;
        kept.add(e.id);
        queue.push(e);
      }
      while (queue.length > 0 && kept.size < DAG_TOTAL_CAP) {
        const head = queue.shift();
        if (!head) continue;
        for (const r of head.spec.relations) {
          if (
            r.relationType !== "derives_from" &&
            r.relationType !== "adopts" &&
            r.relationType !== "reviews" &&
            r.relationType !== "reproduces"
          )
            continue;
          const parent = byId.get(r.targetCid);
          if (parent && !kept.has(parent.id)) {
            kept.add(parent.id);
            queue.push(parent);
            if (kept.size >= DAG_TOTAL_CAP) break;
          }
        }
      }
      return sorted.filter((e) => kept.has(e.id)).map(entityToContribution);
    },
    ["Contribution"],
    shallowArraysEqual,
  );

  const derivedClaims = useDerived<readonly Claim[]>(
    () => {
      const all = claimInformer.list() as readonly ClaimEntity[];
      // Version-skew guard: if any payload lacks `persistedPhase`, we
      // cannot tell an active-with-expired-lease row from a truly
      // terminal expired row using `phase` alone, so the blocked status
      // path would silently degrade. Throw to mark the informer as
      // unhealthy — `claimInformerReady` flips false, polled
      // `getClaims({ status: "all" })` takes over, and the projection
      // gets the raw active claims it needs.
      for (const e of all) {
        if (e.status.persistedPhase === undefined) {
          throw new Error(
            "ClaimEntity payload missing persistedPhase — falling back to polled claims",
          );
        }
      }
      return all.filter((e) => e.status.persistedPhase === "active").map(entityToClaim);
    },
    ["Claim"],
    shallowArraysEqual,
  );

  const contribInformerReady =
    useContribWatch && derivedContributions.hasSynced && !derivedContributions.error;
  const claimInformerReady = useClaimWatch && derivedClaims.hasSynced && !derivedClaims.error;

  // Polled fallback only when the contribution informer is unavailable.
  const dagFetcher = useCallback(() => provider.getDag(), [provider]);
  const polledDag = useEventDrivenData<DagData>(
    dagFetcher,
    undefined,
    undefined,
    active && !contribInformerReady,
  );

  // Polled claim fallback — same `active` gate as contributions so the
  // panel keeps a consistent freshness story. Fetches `status: "all"`
  // (not `"active"`) because the local store's `activeClaims()` filter
  // drops leases whose `lease_expires_at` is already in the past — and
  // that is exactly the state `deriveDagStatus` needs to surface
  // `blocked`. `deriveDagStatus` independently filters to active claims,
  // so the extra rows are harmless.
  const claimsFetcher = useCallback(
    () =>
      isScopedForClaims
        ? Promise.resolve([] as readonly Claim[])
        : provider.getClaims({ status: "all" }),
    [provider, isScopedForClaims],
  );
  const polledClaims = useEventDrivenData<readonly Claim[]>(
    claimsFetcher,
    undefined,
    undefined,
    active && !claimInformerReady && !isScopedForClaims,
  );

  const contributions: readonly Contribution[] = useMemo(() => {
    if (contribInformerReady) return derivedContributions.data ?? [];
    return polledDag.data?.contributions ?? [];
  }, [contribInformerReady, derivedContributions.data, polledDag.data]);

  const claims: readonly Claim[] = useMemo(() => {
    if (claimInformerReady) return derivedClaims.data ?? [];
    return polledClaims.data ?? [];
  }, [claimInformerReady, derivedClaims.data, polledClaims.data]);

  const loading = contribInformerReady ? false : polledDag.loading;
  const isStale = contribInformerReady ? false : polledDag.isStale;
  // Surface informer errors even while the polled fallback runs so
  // operators see watch-pipeline failures alongside polled data.
  // Claim-source failures matter too — without them, status icons
  // silently disappear and an upstream `/api/claims` outage looks
  // identical to "no active claims".
  const error =
    derivedContributions.error ?? polledDag.error ?? derivedClaims.error ?? polledClaims.error;

  // Outcome batch fetch — kept so done/failed icons remain accurate.
  const outcomeProvider = provider.capabilities.outcomes
    ? (provider as unknown as TuiOutcomeProvider)
    : undefined;
  const cids = useMemo(() => contributions.map((c) => c.cid), [contributions]);
  const outcomeFetcher = useCallback(
    () => outcomeProvider?.getOutcomes(cids) ?? Promise.resolve(new Map()),
    [outcomeProvider, cids],
  );
  const { data: outcomes } = useEventDrivenData<ReadonlyMap<string, OutcomeRecord>>(
    outcomeFetcher,
    undefined,
    undefined,
    active && cids.length > 0,
  );

  // Ticking clock so an active claim whose lease expires between data
  // events flips running → blocked without waiting for the next push.
  const now = useNowTicker();
  const projection = useMemo(
    () =>
      projectDagTree({
        contributions,
        outcomes: outcomes ?? new Map(),
        claims,
        now,
        options: {
          collapsed: snapshot.collapsed,
          focusCid: snapshot.focusCid,
          maxNodes: DAG_TOTAL_CAP,
        },
      }),
    [contributions, outcomes, claims, now, snapshot.collapsed, snapshot.focusCid],
  );

  // Report the *rendered* row order to the parent, NOT the raw contribution
  // list — the projection reorders root-to-descendant, can hide collapsed
  // subtrees, and emits duplicate rows for multi-parent crosslinks. Parent
  // navigation (Enter/cursor-based actions) must index against what the
  // user actually sees so a cursor row aligns with the right cid.
  //
  // Focus gate: when this DAG is not the focused panel (cursor < 0) we
  // must NOT fire — the 5s status ticker would otherwise stomp the
  // parent's global contributionList every tick with cids from a
  // background panel, redirecting Enter/cursor on whichever panel IS
  // focused.
  //
  // Skip-if-unchanged: compare the cid sequence so a tick-driven
  // projection rebuild with the same visible rows doesn't burn a parent
  // setState round-trip.
  const lastReportedCidsRef = useRef<readonly string[] | null>(null);
  useEffect(() => {
    if (!onContributionsLoaded) return;
    // While unfocused, clear the dedup ref so the FIRST tick after refocus
    // re-emits even if the cid sequence happens to match what we last
    // reported. Otherwise the parent's contributionList stays populated
    // by whichever panel reported in between, and Enter on the refocused
    // DAG opens the other panel's row.
    if (cursor < 0) {
      lastReportedCidsRef.current = null;
      return;
    }
    if (projection.rows.length === 0) return;
    const cidSeq = projection.rows.map((r) => r.cid);
    const prev = lastReportedCidsRef.current;
    if (prev && prev.length === cidSeq.length && prev.every((c, i) => c === cidSeq[i])) {
      return;
    }
    const contribByCid = new Map(contributions.map((c) => [c.cid, c]));
    const visible: Contribution[] = [];
    for (const row of projection.rows) {
      const c = contribByCid.get(row.cid);
      if (c) visible.push(c);
    }
    lastReportedCidsRef.current = cidSeq;
    onContributionsLoaded(visible);
  }, [projection.rows, contributions, onContributionsLoaded, cursor]);

  // Production keybindings — armed only when the parent confirms (a)
  // the DAG panel is focused AND (b) no modal/text-input mode is active.
  // useKeyboard registers globally and fires regardless of overlay state,
  // so the `keysEnabled` gate is the only thing keeping a space typed
  // into the command palette or `/` filter from toggling a DAG row.
  //   space → toggle collapse on the currently-focused row
  //   shift+A → expand all
  //   shift+Z → collapse every interior (non-leaf) cid currently rendered
  useKeyboard(
    useCallback(
      (key) => {
        if (!keysEnabled || cursor < 0) return;
        const name = (key as { name?: string }).name;
        const shift = (key as { shift?: boolean }).shift === true;
        if (name === "space") {
          const row = projection.rows[cursor];
          if (row && row.expander !== "leaf" && row.expander !== "crosslink") {
            store.toggleCollapsed(row.cid);
          }
          return;
        }
        if (shift && name === "a") {
          store.expandAll();
          return;
        }
        if (shift && name === "z") {
          const collapsible = projection.rows
            .filter((r) => r.expander === "expanded" || r.expander === "collapsed")
            .map((r) => r.cid);
          store.collapseAll(collapsible);
        }
      },
      [keysEnabled, cursor, projection.rows, store],
    ),
  );

  if (loading && contributions.length === 0) {
    return (
      <box>
        <text opacity={0.5}>Loading DAG...</text>
      </box>
    );
  }

  if (projection.rows.length === 0) {
    return (
      <EmptyState
        title="Contribution graph showing agent work."
        hint="Spawn agents with Ctrl+P to see activity here. Each node is a contribution linked to its parents."
      />
    );
  }

  return (
    <box flexDirection="column">
      <box marginBottom={1} flexDirection="row">
        <text>{`Contribution DAG (${String(projection.rows.length)} rows / ${String(projection.nodes.size)} nodes${projection.truncated ? ", truncated" : ""}) `}</text>
        {isScopedForClaims && (
          // Surface explicitly: a scoped session can't yet pull
          // session-filtered claims, so we drop them entirely rather than
          // leak cross-session running/blocked icons. Without this banner
          // operators would mistake the universal idle/awaiting-review
          // for accurate status data.
          <text color={theme.statusBlocked}>claim status unavailable (scoped) </text>
        )}
        <DataStatus loading={loading} isStale={isStale} error={error?.message} />
      </box>
      {projection.rows.map((row, i) => (
        // Multi-parent rows emit the same cid multiple times (one primary +
        // one crosslink per extra incoming edge), so the cid alone is not a
        // unique React key. Compose with row index + incoming-edge type so
        // every occurrence reconciles against the right slot when the
        // projection updates.
        <DagRowView
          key={`dag-${row.cid}-${String(i)}-${row.incomingEdge ?? "root"}`}
          row={row}
          isSelected={i === cursor}
          highlight={effectiveHighlight}
        />
      ))}
    </box>
  );
});

interface DagRowProps {
  readonly row: RenderRow;
  readonly isSelected: boolean;
  readonly highlight: string;
}

// Plain component (no React.memo): every projection run allocates fresh
// RenderRow objects, so prop-identity memoization would just add a
// comparator call per row without skipping work. Row rendering is a
// terminal-cell write, not a DOM mutation — the saved work is negligible
// even at 100+ rows.
function DagRowView({ row, isSelected, highlight }: DagRowProps): React.ReactNode {
  const { node, depth, expander, incomingEdge } = row;
  const indent = "  ".repeat(depth);
  // `↪` marks a crosslink — a second incoming edge to a node whose subtree
  // was already rendered elsewhere. Distinct from `·` (leaf) so operators
  // can tell "no children" from "children already shown above".
  const expanderGlyph =
    expander === "expanded"
      ? "▼"
      : expander === "collapsed"
        ? "▶"
        : expander === "crosslink"
          ? "↪"
          : "·";
  const cidShort = `${node.cid.slice(0, 14)}…`;
  const edgeLabel =
    incomingEdge && incomingEdge !== "derives_from"
      ? `[${EDGE_LABEL[incomingEdge] ?? incomingEdge}] `
      : "";
  const kindColor = KIND_COLORS[node.kind];
  const haystack = `${node.cid} ${node.summary} ${node.kind} ${node.agentLabel}`.toLowerCase();
  const matches = highlight !== "" && haystack.includes(highlight);

  const summaryColor = isSelected ? theme.focus : matches ? theme.highlightMatch : kindColor;
  const truncatedSummary =
    node.summary.length > 60 ? `${node.summary.slice(0, 58)}…` : node.summary;

  return (
    <box flexDirection="row">
      <text color={isSelected ? theme.focus : undefined}>{isSelected ? "> " : "  "}</text>
      <text>{indent}</text>
      <text opacity={0.6}>{`${expanderGlyph} `}</text>
      <DagStatusIcon status={node.status} />
      <text> </text>
      <text opacity={0.5}>{edgeLabel}</text>
      <text opacity={0.6}>{`${cidShort} `}</text>
      <text color={summaryColor}>{`[${node.kind}] ${truncatedSummary}`}</text>
    </box>
  );
}

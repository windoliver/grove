import { useKeyboard } from "@opentui/react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Claim } from "../../../core/models.js";
import { EmptyState } from "../../components/empty-state.js";
import { useEventDrivenData } from "../../hooks/use-event-driven-data.js";
import type { TuiDataProvider } from "../../provider.js";
import { AgentGrid, moveCursor } from "./agent-grid.js";
import { ApprovalModal } from "./approval-modal.js";
import { createApprovalQueue } from "./approval-queue.js";
import { DrillDock } from "./drill-dock.js";
import { nextDrillTab } from "./drill-tabs.js";
import { FleetBanner, type SortMode, type StateFilter } from "./fleet-banner.js";
import { routeKey, type SupervisionAction } from "./keyboard.js";
import { loadThresholds } from "./thresholds.js";
import type { DrillTab, PendingApproval, SupervisedAgent } from "./types.js";
import { useFleetSupervision } from "./use-fleet-supervision.js";

export interface SupervisionScreenProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly goal?: string;
  readonly progress?: React.ReactNode;
  readonly pendingApprovals: readonly PendingApproval[];
  readonly onAcceptApproval: (requestId: string) => Promise<void>;
  readonly onRejectApproval: (requestId: string) => Promise<void>;
  readonly onBack?: () => void;
}

const SEVERITY_RANK: Readonly<Record<SupervisedAgent["state"], number>> = {
  awaiting: 0,
  blocked: 1,
  thrashing: 2,
  stuck: 3,
  silent: 4,
  running: 5,
  done: 6,
  idle: 7,
};

export const SupervisionScreen: React.FC<SupervisionScreenProps> = (props) => {
  const { provider, intervalMs, goal, progress, pendingApprovals } = props;
  const [cursor, setCursor] = useState(0);
  const [drillOpen, setDrillOpen] = useState(false);
  const [drillTab, setDrillTab] = useState<DrillTab>("feed");
  const [filterText, setFilterText] = useState("");
  const [cmdMode, setCmdMode] = useState<"idle" | "filter">("idle");
  const [sort, setSort] = useState<SortMode>("severity");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [modalDetail, setModalDetail] = useState(false);
  const [tickMs, setTickMs] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setTickMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  const claimsFetcher = useCallback(
    async (): Promise<readonly Claim[]> => provider.getClaims({ status: "active" }),
    [provider],
  );
  const contribsFetcher = useCallback(
    async () => provider.getContributions({ limit: 200 }),
    [provider],
  );
  const costsFetcher = useCallback(async () => {
    const cp = provider as { getSessionCosts?: () => Promise<unknown> };
    if (!cp.getSessionCosts) return new Map();
    const out = (await cp.getSessionCosts()) as {
      byAgent: readonly { agentId: string; costUsd: number; tokens: number; contextPercent?: number }[];
    };
    const m = new Map<string, { costUsd: number; tokens: number; contextPercent?: number }>();
    for (const a of out.byAgent) {
      m.set(a.agentId, {
        costUsd: a.costUsd,
        tokens: a.tokens,
        ...(a.contextPercent !== undefined ? { contextPercent: a.contextPercent } : {}),
      });
    }
    return m;
  }, [provider]);

  const { data: claims } = useEventDrivenData(claimsFetcher, undefined, undefined, true);
  const { data: contributions } = useEventDrivenData(contribsFetcher, undefined, undefined, true);
  const { data: costs } = useEventDrivenData(costsFetcher, undefined, undefined, true);

  const thresholds = useMemo(() => loadThresholds(), []);
  const { agents, summary } = useFleetSupervision({
    claims: claims ?? [],
    contributions: contributions ?? [],
    costs: costs ?? new Map(),
    sessions: new Map(),
    pendingApprovals,
    handoffsByAgent: new Map(),
    completedClaimsByAgent: new Map(),
    tickMs,
    thresholds,
  });

  const visible = useMemo(
    () => filterAndSort(agents, filterText, sort, stateFilter),
    [agents, filterText, sort, stateFilter],
  );

  const focusedAgent = visible[cursor];
  const approvalQueue = useMemo(
    () =>
      createApprovalQueue(pendingApprovals, {
        accept: props.onAcceptApproval,
        reject: props.onRejectApproval,
      }),
    [pendingApprovals, props.onAcceptApproval, props.onRejectApproval],
  );

  const handle = useCallback(
    (action: SupervisionAction) => {
      switch (action.kind) {
        case "cursor-left":
          setCursor((c) => moveCursor(c, visible.length, "left"));
          break;
        case "cursor-right":
          setCursor((c) => moveCursor(c, visible.length, "right"));
          break;
        case "cursor-up":
          setCursor((c) => moveCursor(c, visible.length, "up"));
          break;
        case "cursor-down":
          setCursor((c) => moveCursor(c, visible.length, "down"));
          break;
        case "cursor-top":
          setCursor(0);
          break;
        case "cursor-bottom":
          setCursor(Math.max(0, visible.length - 1));
          break;
        case "open-drill":
          if (focusedAgent) setDrillOpen(true);
          break;
        case "close-drill":
          setDrillOpen(false);
          break;
        case "cycle-drill-tab":
          setDrillTab(nextDrillTab);
          break;
        case "set-drill-tab":
          setDrillTab(action.tab);
          break;
        case "enter-filter":
          setCmdMode("filter");
          break;
        case "exit-cmd-mode":
          setCmdMode("idle");
          setFilterText("");
          break;
        case "cmd-mode-char":
          setFilterText((t) => t + action.char);
          break;
        case "cmd-mode-backspace":
          setFilterText((t) => t.slice(0, -1));
          break;
        case "cycle-sort":
          setSort((s) => cycle(s, ["severity", "role", "cost", "age"] as const));
          break;
        case "cycle-state-filter":
          setStateFilter((s) => cycle(s, ["all", "problems", "running"] as const));
          break;
        case "open-next-approval":
          if (approvalQueue.head) {
            setModalOpen(true);
            setModalDetail(false);
          }
          break;
        case "close-modal":
          setModalOpen(false);
          setModalDetail(false);
          break;
        case "toggle-approval-detail":
          setModalDetail((d) => !d);
          break;
        case "accept-approval":
          if (approvalQueue.head) {
            void approvalQueue.accept(approvalQueue.head.requestId).catch(() => {});
            setModalOpen(approvalQueue.pending.length > 1);
            setModalDetail(false);
          }
          break;
        case "reject-approval":
          if (approvalQueue.head) {
            void approvalQueue.reject(approvalQueue.head.requestId).catch(() => {});
            setModalOpen(approvalQueue.pending.length > 1);
            setModalDetail(false);
          }
          break;
        case "accept-focused-approval":
          if (focusedAgent?.pendingApproval) {
            void approvalQueue.accept(focusedAgent.pendingApproval.requestId).catch(() => {});
          }
          break;
        case "reject-focused-approval":
          if (focusedAgent?.pendingApproval) {
            void approvalQueue.reject(focusedAgent.pendingApproval.requestId).catch(() => {});
          }
          break;
        case "copy-agent-id":
          // Out-of-scope for v1 — host process will own clipboard.
          break;
        case "back-to-main":
          props.onBack?.();
          break;
      }
    },
    [visible, focusedAgent, approvalQueue, props],
  );

  useKeyboard(
    useCallback(
      (key: { name: string }) => {
        const action = routeKey(key.name, {
          modalOpen,
          focusedAgentAwaiting: !!focusedAgent?.pendingApproval,
          drillOpen,
          cmdMode,
        });
        if (action) handle(action);
      },
      [modalOpen, focusedAgent, drillOpen, cmdMode, handle],
    ),
  );

  // Solo-agent auto-drill
  useEffect(() => {
    if (visible.length === 1 && !drillOpen) setDrillOpen(true);
  }, [visible.length, drillOpen]);

  if (visible.length === 0) {
    return (
      <box flexDirection="column">
        <FleetBanner
          summary={summary}
          filterText={filterText}
          filterMode={cmdMode}
          sort={sort}
          stateFilter={stateFilter}
          goal={goal}
          progress={progress}
        />
        <EmptyState
          title="No agents registered."
          hint="Press r to register, or Ctrl+P to spawn."
        />
      </box>
    );
  }

  return (
    <box flexDirection="column">
      <FleetBanner
        summary={summary}
        filterText={filterText}
        filterMode={cmdMode}
        sort={sort}
        stateFilter={stateFilter}
        goal={goal}
        progress={progress}
      />
      <AgentGrid agents={visible} cursor={cursor} viewportHeight={drillOpen ? 3 : 6} />
      {drillOpen && focusedAgent && (
        <DrillDock agent={focusedAgent} tab={drillTab} provider={provider} active={true} />
      )}
      {modalOpen && approvalQueue.head && (
        <ApprovalModal
          approval={approvalQueue.head}
          queueDepth={approvalQueue.pending.length}
          detailOpen={modalDetail}
          nowMs={tickMs}
        />
      )}
    </box>
  );
};

function cycle<T extends string>(current: T, options: readonly T[]): T {
  const i = options.indexOf(current);
  return options[(i + 1) % options.length] as T;
}

function filterAndSort(
  agents: readonly SupervisedAgent[],
  filterText: string,
  sort: SortMode,
  stateFilter: StateFilter,
): readonly SupervisedAgent[] {
  const q = filterText.trim().toLowerCase();
  let out = agents.filter((a) => {
    if (stateFilter === "problems" && (a.state === "running" || a.state === "done" || a.state === "idle"))
      return false;
    if (stateFilter === "running" && a.state !== "running") return false;
    if (!q) return true;
    const hay = `${a.agentId} ${a.agentName ?? ""} ${a.role} ${a.platform} ${a.state} ${a.currentTask ?? ""}`.toLowerCase();
    return hay.includes(q);
  });
  out = [...out].sort((a, b) => {
    switch (sort) {
      case "severity": {
        const d = SEVERITY_RANK[a.state] - SEVERITY_RANK[b.state];
        return d !== 0 ? d : b.lastActionAt - a.lastActionAt;
      }
      case "role": return a.role.localeCompare(b.role);
      case "cost": return b.costUsd - a.costUsd;
      case "age":  return b.lastActionAt - a.lastActionAt;
    }
  });
  return out;
}

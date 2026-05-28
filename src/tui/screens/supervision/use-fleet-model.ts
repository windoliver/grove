/**
 * Fleet model — join active claims with tmux session, cost, monitor outputs,
 * pending permissions, handoffs, and per-role failure messages, and derive
 * AgentHealth per agent. Sorted problem-first.
 */

import { useCallback, useMemo } from "react";
import { type ClaimEntity, claimToEntity } from "../../../core/entity.js";
import { type Handoff, HandoffStatus } from "../../../core/handoff.js";
import { agentIdFromSession } from "../../agents/tmux-manager.js";
import { isActive } from "../../components/columns/claim-columns.js";
import { useProviderScoped } from "../../hooks/informer-context.js";
import type { AgentMonitorState, PermissionPrompt } from "../../hooks/use-agent-monitor.js";
import { useEntityData } from "../../hooks/use-entity-data.js";
import { useEventDrivenData } from "../../hooks/use-event-driven-data.js";
import type { TuiDataProvider } from "../../provider.js";
import { isCostProvider, isHandoffProvider } from "../../provider.js";
import {
  type AgentHealth,
  deriveAgentHealth,
  HEALTH_THRESHOLDS,
  healthPriority,
} from "./agent-health.js";

export interface FleetCost {
  readonly usd: number;
  readonly tokens: number;
  readonly ctxPercent?: number;
}

export interface FleetAgent {
  readonly agentId: string;
  readonly agentName: string;
  readonly role: string;
  readonly platform: string;
  readonly session: string | undefined;
  readonly claim: ClaimEntity;
  readonly health: AgentHealth;
  readonly currentTask: string | undefined;
  readonly lastAction: string | undefined;
  readonly lastOutputAt: string | undefined;
  readonly cost: FleetCost | undefined;
  readonly handoffs: { pendingOut: number; overdueIn: number; blockedOn?: string };
  readonly pendingApproval: PermissionPrompt | undefined;
  readonly attemptCount: number;
}

export interface FleetSources {
  readonly claims: readonly ClaimEntity[];
  readonly tmuxSessions: readonly string[];
  readonly costs: ReadonlyMap<string, FleetCost>;
  readonly agentOutputs: ReadonlyMap<string, readonly string[]>;
  readonly agentOutputTimestamps: ReadonlyMap<string, string>;
  readonly pendingPermissions: readonly PermissionPrompt[];
  readonly handoffs: readonly Handoff[];
  readonly agentFailures: ReadonlyMap<string, string>;
  readonly filterText: string | undefined;
  readonly nowMs: number;
}

const matchesFilter = (a: FleetAgent, q: string): boolean => {
  const haystack =
    `${a.agentName} ${a.agentId} ${a.role} ${a.platform} ${a.claim.spec.targetRef}`.toLowerCase();
  return haystack.includes(q);
};

/** Build a sorted FleetAgent list. Pure — exported for testing. */
export function buildFleet(s: FleetSources): readonly FleetAgent[] {
  const tmuxByAgent = new Map<string, string>();
  for (const session of s.tmuxSessions) {
    const id = agentIdFromSession(session);
    if (id) tmuxByAgent.set(id, session);
  }

  const inboundByRole = new Map<string, Handoff[]>();
  const outboundByRole = new Map<string, number>();
  for (const h of s.handoffs) {
    if (h.status !== HandoffStatus.PendingPickup) continue;
    const list = inboundByRole.get(h.toRole) ?? [];
    list.push(h);
    inboundByRole.set(h.toRole, list);
    outboundByRole.set(h.fromRole, (outboundByRole.get(h.fromRole) ?? 0) + 1);
  }

  const agents: FleetAgent[] = [];
  for (const claim of s.claims) {
    const role = claim.spec.agent.role ?? "worker";
    const agentId = claim.spec.agent.agentId;
    // costs/sessions keyed by agentId
    const session = tmuxByAgent.get(agentId);
    // outputs, timestamps, failures, permissions keyed by role
    const outputs = s.agentOutputs.get(role) ?? [];
    const lastAction = outputs.length > 0 ? outputs[outputs.length - 1] : undefined;
    const lastOutputAt = s.agentOutputTimestamps.get(role);
    const pendingApproval = s.pendingPermissions.find((p) => p.agentRole === role);
    const inbound = inboundByRole.get(role) ?? [];
    const oldestInbound = inbound.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    const blockedOn = oldestInbound?.fromRole;
    const blockedSinceMs = oldestInbound
      ? s.nowMs - new Date(oldestInbound.createdAt).getTime()
      : 0;
    const overdueIn = inbound.filter(
      (h) => h.replyDueAt !== undefined && new Date(h.replyDueAt).getTime() < s.nowMs,
    ).length;

    const health = deriveAgentHealth(
      {
        role,
        leaseExpiresAt: claim.status.leaseExpiresAt,
        heartbeatAt: claim.status.heartbeatAt,
        attemptCount: claim.status.attemptCount,
        lastRetryAt: undefined,
        lastOutputAt,
        currentTask: claim.spec.intentSummary,
        currentTaskSinceMs:
          s.nowMs -
          new Date(claim.metadata.creationTimestamp ?? claim.status.heartbeatAt).getTime(),
        pendingApproval,
        blockedOn,
        blockedSinceMs,
        agentFailure: s.agentFailures.get(role),
      },
      s.nowMs,
      HEALTH_THRESHOLDS,
    );

    agents.push({
      agentId,
      agentName: claim.spec.agent.agentName ?? agentId,
      role,
      platform: claim.spec.agent.platform ?? "-",
      session,
      claim,
      health,
      currentTask: claim.spec.intentSummary,
      lastAction,
      lastOutputAt,
      cost: s.costs.get(agentId),
      handoffs: {
        pendingOut: outboundByRole.get(role) ?? 0,
        overdueIn,
        ...(blockedOn ? { blockedOn } : {}),
      },
      pendingApproval,
      attemptCount: claim.status.attemptCount,
    });
  }

  const q = s.filterText?.trim().toLowerCase();
  const filtered = q ? agents.filter((a) => matchesFilter(a, q)) : agents;

  return filtered.slice().sort((a, b) => {
    const pa = healthPriority(a.health);
    const pb = healthPriority(b.health);
    if (pa !== pb) return pa - pb;
    if (a.role === "coordinator" && b.role !== "coordinator") return -1;
    if (b.role === "coordinator" && a.role !== "coordinator") return 1;
    return a.agentName.localeCompare(b.agentName);
  });
}

export interface UseFleetModelArgs {
  readonly provider: TuiDataProvider;
  readonly monitor: AgentMonitorState;
  readonly agentFailures: ReadonlyMap<string, string> | undefined;
  readonly tmux: import("../../agents/tmux-manager.js").TmuxManager | undefined;
  readonly filterText: string | undefined;
  readonly active: boolean;
}

const NAMESPACE = "default";

/** Stable empty reference for the scoped short-circuit (no churn). */
const EMPTY_FLEET: readonly FleetAgent[] = [];

export function useFleetModel(args: UseFleetModelArgs): readonly FleetAgent[] {
  // Claims come from the informer-backed EntityStore in nexus mode
  // (useEntityData → useEntities), with the polled getClaims path as the
  // local-mode fallback. Reading only the fallback (#193) left the
  // FleetRail empty in nexus mode even while agents actively claimed.
  const claimsFallback = useCallback(async (): Promise<readonly ClaimEntity[]> => {
    const flat = await args.provider.getClaims({ status: "active" });
    return flat.map((c) => claimToEntity(c, () => Date.now(), NAMESPACE));
  }, [args.provider]);
  const { data: claims } = useEntityData<"Claim">(args.provider, "Claim", {
    active: args.active,
    predicate: isActive,
    fallbackFetcher: claimsFallback,
  });

  const tmuxFetcher = useCallback(async (): Promise<readonly string[]> => {
    if (!args.tmux) return [];
    return (await args.tmux.isAvailable()) ? args.tmux.listSessions() : [];
  }, [args.tmux]);
  const { data: tmuxSessions } = useEventDrivenData<readonly string[]>(
    tmuxFetcher,
    undefined,
    undefined,
    args.active && !!args.tmux,
  );

  const costsFetcher = useCallback(async (): Promise<ReadonlyMap<string, FleetCost>> => {
    if (!isCostProvider(args.provider)) return new Map();
    const out = await args.provider.getSessionCosts();
    const m = new Map<string, FleetCost>();
    for (const a of out.byAgent) {
      m.set(a.agentId, {
        usd: a.costUsd,
        tokens: a.tokens,
        ...(a.contextPercent !== undefined ? { ctxPercent: a.contextPercent } : {}),
      });
    }
    return m;
  }, [args.provider]);
  const { data: costs } = useEventDrivenData<ReadonlyMap<string, FleetCost>>(
    costsFetcher,
    undefined,
    undefined,
    args.active,
  );

  const handoffsFetcher = useCallback(async (): Promise<readonly Handoff[]> => {
    if (!isHandoffProvider(args.provider)) return [];
    return args.provider.getHandoffs({ limit: 200 });
  }, [args.provider]);
  const { data: handoffs } = useEventDrivenData<readonly Handoff[]>(
    handoffsFetcher,
    undefined,
    undefined,
    args.active && isHandoffProvider(args.provider),
  );

  // Scoped sessions: `useEntityWatchEnabled` returns false in scoped mode
  // and `provider.getClaims` is namespace-global (no session filter), so
  // the fallback would leak claims from OTHER sessions. Render empty until
  // session-scoped claim filtering lands. Mirrors AgentListView. Called
  // unconditionally with the other hooks to keep React hook order stable.
  const isScoped = useProviderScoped(args.provider);

  // nowMs captured at memo-eval time; health re-derives whenever any source changes
  const fleet = useMemo(
    () =>
      buildFleet({
        claims: claims ?? [],
        tmuxSessions: tmuxSessions ?? [],
        costs: costs ?? new Map(),
        agentOutputs: args.monitor.agentOutputs,
        agentOutputTimestamps: args.monitor.agentOutputTimestamps,
        pendingPermissions: args.monitor.pendingPermissions,
        handoffs: handoffs ?? [],
        agentFailures: args.agentFailures ?? new Map(),
        filterText: args.filterText,
        nowMs: Date.now(),
      }),
    [
      claims,
      tmuxSessions,
      costs,
      args.monitor.agentOutputs,
      args.monitor.agentOutputTimestamps,
      args.monitor.pendingPermissions,
      handoffs,
      args.agentFailures,
      args.filterText,
    ],
  );

  return isScoped ? EMPTY_FLEET : fleet;
}

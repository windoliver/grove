/**
 * Visual test harness for the Handoffs panel in RunningView.
 *
 * This harness is intentionally deterministic: it renders a codex -> claude
 * review-loop topology with handoffs in overdue, resolved, blocked, and
 * dead-letter states. Run it inside tmux and use capture-pane for regression
 * checks without requiring real ACP credentials.
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { Handoff } from "../../src/core/handoff.js";
import { HandoffStatus } from "../../src/core/handoff.js";
import {
  type Claim,
  ClaimStatus,
  type Contribution,
  ContributionKind,
  ContributionMode,
  ScoreDirection,
} from "../../src/core/models.js";
import type { AgentTopology } from "../../src/core/topology.js";
import { createLocalRuntime } from "../../src/local/runtime.js";
import { PagesStore } from "../../src/tui/data/pages-store.js";
import { PagesStoreProvider } from "../../src/tui/hooks/use-screen-stack.js";
import { LocalDataProvider } from "../../src/tui/local-provider.js";
import type { TuiDataProvider, TuiHandoffProvider } from "../../src/tui/provider.js";
import { RunningView } from "../../src/tui/screens/running-view.js";

const SESSION_ID = "review-loop-codex-claude";
const STARTED_AT = new Date(Date.now() - 10 * 60_000).toISOString();

function isoFromNow(deltaMs: number): string {
  return new Date(Date.now() + deltaMs).toISOString();
}

function cid(prefix: string): string {
  return `blake3:${prefix.padEnd(64, prefix)}`;
}

let replacementCounter = 0;

let stubHandoffs: readonly Handoff[] = [
  {
    handoffId: "h-001",
    sourceCid: cid("a1"),
    fromRole: "reviewer",
    toRole: "coder",
    status: HandoffStatus.PendingPickup,
    requiresReply: true,
    replyDueAt: isoFromNow(-120_000),
    createdAt: isoFromNow(-240_000),
  },
  {
    handoffId: "h-002",
    sourceCid: cid("b2"),
    fromRole: "reviewer",
    toRole: "coder",
    status: HandoffStatus.Replied,
    requiresReply: false,
    resolvedByCid: cid("c3"),
    seenAt: isoFromNow(-100_000),
    ackedAt: isoFromNow(-95_000),
    createdAt: isoFromNow(-180_000),
  },
  {
    handoffId: "h-003",
    sourceCid: cid("d4"),
    fromRole: "coder",
    toRole: "reviewer",
    status: HandoffStatus.Delivered,
    requiresReply: true,
    replyDueAt: isoFromNow(300_000),
    seenAt: isoFromNow(-80_000),
    createdAt: isoFromNow(-160_000),
  },
  {
    handoffId: "h-004",
    sourceCid: cid("e5"),
    fromRole: "coder",
    toRole: "reviewer",
    status: HandoffStatus.DeadLettered,
    requiresReply: true,
    replyDueAt: isoFromNow(300_000),
    createdAt: isoFromNow(-120_000),
  },
];

const contributions: readonly Contribution[] = [
  {
    cid: cid("a1"),
    manifestVersion: 1,
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "Codex posts implementation for Claude review",
    artifacts: {},
    relations: [],
    scores: { confidence: { value: 0.82, direction: ScoreDirection.Maximize } },
    tags: ["review-loop", "codex"],
    agent: { agentId: "coder-acp", role: "coder", platform: "codex" },
    createdAt: isoFromNow(-240_000),
  },
  {
    cid: cid("b2"),
    manifestVersion: 1,
    kind: ContributionKind.Review,
    mode: ContributionMode.Evaluation,
    summary: "Claude replies with review complete",
    artifacts: {},
    relations: [],
    tags: ["review-loop", "claude"],
    agent: { agentId: "reviewer-acp", role: "reviewer", platform: "claude-code" },
    createdAt: isoFromNow(-180_000),
  },
];

const activeClaims: readonly Claim[] = [
  {
    claimId: "claim-coder",
    targetRef: "session:review-loop-codex-claude/coder",
    agent: { agentId: "coder-acp", role: "coder", platform: "codex" },
    status: ClaimStatus.Active,
    intentSummary: "Implement issue #163 handoff recovery",
    createdAt: STARTED_AT,
    heartbeatAt: isoFromNow(-5_000),
    leaseExpiresAt: isoFromNow(300_000),
  },
  {
    claimId: "claim-reviewer",
    targetRef: "session:review-loop-codex-claude/reviewer",
    agent: { agentId: "reviewer-acp", role: "reviewer", platform: "claude-code" },
    status: ClaimStatus.Active,
    intentSummary: "Review Codex handoff recovery",
    createdAt: STARTED_AT,
    heartbeatAt: isoFromNow(-5_000),
    leaseExpiresAt: isoFromNow(300_000),
  },
];

function requireHandoff(handoffId: string): Handoff {
  const handoff = stubHandoffs.find((candidate) => candidate.handoffId === handoffId);
  if (handoff === undefined) {
    throw new Error(`Unknown handoff '${handoffId}'`);
  }
  return handoff;
}

function updateHandoff(handoffId: string, next: (handoff: Handoff) => Handoff): void {
  let found = false;
  stubHandoffs = stubHandoffs.map((handoff) => {
    if (handoff.handoffId !== handoffId) return handoff;
    found = true;
    return next(handoff);
  });
  if (!found) {
    throw new Error(`Unknown handoff '${handoffId}'`);
  }
}

function appendReplacement(
  original: Handoff,
  replacement: Pick<Handoff, "fromRole" | "toRole" | "requiresReply" | "replyDueAt">,
  reason: string | undefined,
): void {
  replacementCounter += 1;
  const replacementHandoffId = `h-r${replacementCounter.toString().padStart(3, "0")}`;
  stubHandoffs = [
    ...stubHandoffs.map((handoff) =>
      handoff.handoffId === original.handoffId
        ? {
            ...handoff,
            status: HandoffStatus.Cancelled,
            terminalReason: reason ?? "operator replacement",
            replacementHandoffId,
          }
        : handoff,
    ),
    {
      handoffId: replacementHandoffId,
      sourceCid: original.sourceCid,
      fromRole: replacement.fromRole,
      toRole: replacement.toRole,
      status: HandoffStatus.PendingPickup,
      requiresReply: replacement.requiresReply,
      replyDueAt: replacement.replyDueAt,
      createdAt: isoFromNow(0),
    },
  ];
}

const mockProvider: TuiDataProvider & TuiHandoffProvider = {
  capabilities: {
    outcomes: false,
    artifacts: false,
    vfs: false,
    messaging: false,
    costTracking: false,
    askUser: false,
    github: false,
    bounties: false,
    gossip: false,
    goals: false,
    sessions: false,
    handoffs: true,
  },
  async getDashboard() {
    return {
      metadata: {
        name: "review-loop validation",
        contributionCount: contributions.length,
        activeClaimCount: activeClaims.length,
        mode: "local-harness",
        backendLabel: "tmux harness",
        goal: "Codex coder hands off to Claude reviewer",
        activeSessionId: SESSION_ID,
      },
      activeClaims,
      recentContributions: contributions,
      frontierSummary: {
        topByMetric: [
          {
            metric: "confidence",
            cid: contributions[0]?.cid ?? cid("00"),
            summary: contributions[0]?.summary ?? "no contribution",
            value: 0.82,
          },
        ],
        topByAdoption: [],
      },
    };
  },
  async getContributions() {
    return contributions;
  },
  async getContribution(targetCid) {
    const contribution = contributions.find((candidate) => candidate.cid === targetCid);
    if (contribution === undefined) return undefined;
    return { contribution, ancestors: [], children: [], thread: [] };
  },
  async getClaims() {
    return activeClaims;
  },
  async getFrontier() {
    return {
      byMetric: {},
      byAdoption: [],
      byRecency: [],
      byReviewScore: [],
      byReproduction: [],
    };
  },
  async getActivity() {
    return contributions;
  },
  async getDag() {
    return { contributions };
  },
  async getHotThreads() {
    return [];
  },
  async getAgentTasks() {
    return [];
  },
  async getHandoffs() {
    return [...stubHandoffs];
  },
  async markHandoffDelivered(handoffId) {
    updateHandoff(handoffId, (handoff) => ({
      ...handoff,
      status: HandoffStatus.Delivered,
      seenAt: handoff.seenAt ?? isoFromNow(0),
    }));
  },
  async cancelHandoff(handoffId, reason) {
    updateHandoff(handoffId, (handoff) => ({
      ...handoff,
      status: HandoffStatus.Cancelled,
      terminalReason: reason ?? "operator cancelled",
    }));
  },
  async manualResolveHandoff(handoffId, reason) {
    updateHandoff(handoffId, (handoff) => ({
      ...handoff,
      status: HandoffStatus.ManuallyResolved,
      terminalReason: reason ?? "operator resolved",
    }));
  },
  async resendHandoff(handoffId, options) {
    const original = requireHandoff(handoffId);
    appendReplacement(
      original,
      {
        fromRole: original.fromRole,
        toRole: original.toRole,
        requiresReply: original.requiresReply,
        replyDueAt: options?.replyDueAt ?? isoFromNow(300_000),
      },
      options?.reason,
    );
  },
  async rerouteHandoff(handoffId, options) {
    const original = requireHandoff(handoffId);
    appendReplacement(
      original,
      {
        fromRole: original.fromRole,
        toRole: options.toRole,
        requiresReply: original.requiresReply,
        replyDueAt: options.replyDueAt ?? isoFromNow(300_000),
      },
      options.reason,
    );
  },
  close() {
    /* no-op */
  },
};

const topology: AgentTopology = {
  structure: "graph",
  roles: [
    {
      name: "coder",
      description: "Codex implementation agent",
      command: "codex",
      platform: "codex",
      edges: [{ target: "reviewer", edgeType: "delegates", replyTimeoutSeconds: 300 }],
    },
    {
      name: "reviewer",
      description: "Claude review agent",
      command: "claude",
      platform: "claude-code",
      edges: [{ target: "coder", edgeType: "feedback", replyTimeoutSeconds: 300 }],
    },
  ],
};

interface HarnessData {
  readonly provider: TuiDataProvider;
  readonly topology: AgentTopology;
  readonly goal: string;
  readonly sessionId: string;
  readonly sessionStartedAt?: string;
  readonly activeRoles: readonly string[];
  readonly agentFailures?: ReadonlyMap<string, string> | undefined;
  readonly cleanup: () => void;
}

function createHarnessData(): HarnessData {
  const groveDir = process.env.GROVE_HANDOFFS_HARNESS_GROVE_DIR;
  if (!groveDir) {
    return {
      provider: mockProvider,
      topology,
      goal: "Review loop: coder=codex, reviewer=claude; validate handoff recovery",
      sessionId: SESSION_ID,
      sessionStartedAt: STARTED_AT,
      activeRoles: ["coder", "reviewer"],
      agentFailures: new Map([["reviewer", "claude ACP runtime unavailable"]]),
      cleanup: () => mockProvider.close(),
    };
  }

  const runtime = createLocalRuntime({
    groveDir,
    frontierCacheTtlMs: 0,
    workspace: false,
    parseContract: true,
  });
  const provider = new LocalDataProvider({
    contributionStore: runtime.contributionStore,
    claimStore: runtime.claimStore,
    agentTaskStore: runtime.agentTaskStore,
    frontier: runtime.frontier,
    groveName: runtime.contract?.name ?? "grove-handoffs",
    outcomeStore: runtime.outcomeStore,
    bountyStore: runtime.bountyStore,
    cas: runtime.cas,
    goalSessionStore: runtime.goalSessionStore,
    handoffStore: runtime.handoffStore,
    timelineStore: runtime.timelineStore,
    backendLabel: `local (${groveDir})`,
  });

  return {
    provider,
    topology: runtime.contract?.topology ?? topology,
    goal: `Real handoffs from ${groveDir}`,
    sessionId: process.env.GROVE_SESSION_ID ?? SESSION_ID,
    sessionStartedAt: undefined,
    activeRoles: (runtime.contract?.topology ?? topology).roles.map((role) => role.name),
    cleanup: () => runtime.close(),
  };
}

async function main(): Promise<void> {
  const { DialogProvider } = await import("@opentui-ui/dialog/react");
  const { Toaster } = await import("@opentui-ui/toast/react");
  const harness = createHarnessData();

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: false,
  });
  const root = createRoot(renderer);
  const pagesStore = new PagesStore();
  pagesStore.push({ kind: "running" });

  root.render(
    <DialogProvider>
      <PagesStoreProvider store={pagesStore}>
        <RunningView
          provider={harness.provider}
          intervalMs={1000}
          topology={harness.topology}
          goal={harness.goal}
          sessionId={harness.sessionId}
          sessionStartedAt={harness.sessionStartedAt}
          activeRoles={harness.activeRoles}
          agentFailures={harness.agentFailures}
          onEnterInspect={() => {
            /* no-op */
          }}
          onComplete={() => {
            /* no-op */
          }}
          onQuit={() => renderer.destroy()}
        />
      </PagesStoreProvider>
      <Toaster position="bottom-right" />
    </DialogProvider>,
  );

  renderer.start();
  await renderer.idle();

  await new Promise((resolve) => setTimeout(resolve, 120_000));
  renderer.destroy();
  harness.cleanup();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

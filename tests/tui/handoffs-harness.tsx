/**
 * Visual test harness for the Handoffs panel in RunningView.
 *
 * Renders RunningView in a running session with pre-populated handoff data.
 * Press 5 to open the Handoffs panel, Esc to close it.
 *
 * Run in a tmux session so you can attach:
 *
 *   tmux new-session -d -s grove-handoffs \
 *     "bun run tests/tui/handoffs-harness.tsx; read"
 *   tmux attach -t grove-handoffs
 *
 * Or run directly in your terminal (no tmux needed):
 *   bun run tests/tui/handoffs-harness.tsx
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
import type { Handoff } from "../../src/core/handoff.js";
import { HandoffStatus } from "../../src/core/handoff.js";
import type { ScreenState } from "../../src/tui/screens/screen-manager.js";
import { ScreenManager } from "../../src/tui/screens/screen-manager.js";
import { SpawnManager } from "../../src/tui/spawn-manager.js";
import { SpawnManagerContext } from "../../src/tui/spawn-manager-context.js";

// ---------------------------------------------------------------------------
// Stub handoffs (3 in different states)
// ---------------------------------------------------------------------------

const stubHandoffs: readonly Handoff[] = [
  {
    handoffId: "h-001",
    sourceCid: "blake3:aaaa0000111111111111111111111111111111111111111111111111111111111",
    fromRole: "coder",
    toRole: "reviewer",
    status: HandoffStatus.PendingPickup,
    requiresReply: false,
    createdAt: new Date(Date.now() - 30_000).toISOString(),
  },
  {
    handoffId: "h-002",
    sourceCid: "blake3:bbbb0000222222222222222222222222222222222222222222222222222222222",
    fromRole: "reviewer",
    toRole: "coder",
    status: HandoffStatus.Replied,
    requiresReply: false,
    resolvedByCid: "blake3:cccc0000333333333333333333333333333333333333333333333333333333333",
    createdAt: new Date(Date.now() - 90_000).toISOString(),
  },
  {
    handoffId: "h-003",
    sourceCid: "blake3:dddd0000444444444444444444444444444444444444444444444444444444444",
    fromRole: "coder",
    toRole: "reviewer",
    status: HandoffStatus.Expired,
    requiresReply: true,
    replyDueAt: new Date(Date.now() - 10_000).toISOString(),
    createdAt: new Date(Date.now() - 180_000).toISOString(),
  },
];

// ---------------------------------------------------------------------------
// Mock provider with handoff support
// ---------------------------------------------------------------------------

const mockProvider = {
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
  getDashboard: async () => ({
    totalContributions: 2,
    frontier: [],
    topMetrics: {},
    recentActivity: [],
    activeClaimCount: 1,
    staleClaimCount: 0,
    sessions: [],
    activeClaims: [
      {
        claimId: "c1",
        targetRef: "coder-abc",
        status: "active",
        agent: { agentId: "coder-abc", role: "coder", platform: "claude-code" },
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        heartbeatAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        intentSummary: "Implementing auth fix",
      },
    ],
    frontierSummary: { topByMetric: [] },
  }),
  getContributions: async () => [],
  getContribution: async () => undefined,
  getClaims: async () => [],
  getFrontier: async () => ({ pareto: [], dominated: [], metrics: {} }),
  getActivity: async () => [
    {
      cid: "blake3:aaaa0000111111111111111111111111111111111111111111111111111111111",
      kind: "work",
      mode: "evaluation",
      summary: "Fix null check in auth module",
      agent: { agentId: "coder-abc", role: "coder" },
      artifacts: {},
      relations: [],
      tags: [],
      createdAt: new Date(Date.now() - 30_000).toISOString(),
    },
  ],
  getDag: async () => ({ nodes: [], edges: [] }),
  getHotThreads: async () => [],
  // TuiHandoffProvider
  getHandoffs: async () => stubHandoffs,
  close: () => {},
};

const topology = {
  structure: "graph" as const,
  roles: [
    {
      name: "coder",
      description: "Writes code",
      command: "echo",
      platform: "claude-code" as const,
    },
    { name: "reviewer", description: "Reviews code", command: "echo", platform: "codex" as const },
  ],
  edges: [{ from: "coder", to: "reviewer", type: "delegates" as const }],
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { DialogProvider } = await import("@opentui-ui/dialog/react");
  const { Toaster } = await import("@opentui-ui/toast/react");

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: false,
  });
  const root = createRoot(renderer);

  const spawnManager = new SpawnManager(
    mockProvider as Parameters<typeof SpawnManager>[0],
    undefined,
    () => {},
  );

  const initialState: ScreenState = {
    screen: "running",
    goal: "Review PR #42 — test handoffs panel (press 5)",
    sessionId: "test-handoffs-session",
    sessionStartedAt: new Date().toISOString(),
  };

  const appProps = {
    provider: mockProvider,
    topology,
    groveDir: undefined,
    tmux: undefined,
    intervalMs: 30_000,
    agentRuntime: undefined,
    eventBus: undefined,
  } as Parameters<typeof ScreenManager>[0]["appProps"];

  root.render(
    React.createElement(
      DialogProvider,
      null,
      React.createElement(
        SpawnManagerContext,
        { value: spawnManager },
        React.createElement(ScreenManager, {
          appProps,
          startOnRunning: true,
          initialState,
        }),
      ),
      React.createElement(Toaster, { position: "bottom-right" }),
    ),
  );

  renderer.start();
  await renderer.idle();

  // Keep alive — press Ctrl+C or q to exit
  await new Promise((r) => setTimeout(r, 120_000));
  renderer.destroy();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

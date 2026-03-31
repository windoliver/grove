/**
 * Visual test harness for RunningView with TracePane integration.
 *
 * Renders RunningView on the "running" screen with log buffers populated,
 * so pressing 'e' opens the trace viewer with real data.
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
import type { ScreenState } from "../../src/tui/screens/screen-manager.js";
import { ScreenManager } from "../../src/tui/screens/screen-manager.js";
import { SpawnManager } from "../../src/tui/spawn-manager.js";
import { SpawnManagerContext } from "../../src/tui/spawn-manager-context.js";

// Mock provider
const mockProvider = {
  capabilities: { sessions: true, goals: true, vfs: false, search: false },
  getDashboard: async () => ({
    totalContributions: 5,
    frontier: [],
    topMetrics: {},
    recentActivity: [],
    activeClaimCount: 2,
    staleClaimCount: 0,
    sessions: [],
    activeClaims: [
      {
        claimId: "c1",
        targetRef: "coder-abc",
        status: "active",
        agent: { agentId: "coder-abc", role: "coder", platform: "claude-code" },
        leaseExpiresAt: new Date(Date.now() + 300000).toISOString(),
        heartbeatAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ],
    frontierSummary: { topByMetric: [] },
  }),
  getContributions: async () => [
    {
      cid: "abc123",
      kind: "work",
      summary: "Fixed XSS vulnerability in auth module",
      agent: { agentId: "coder-abc", role: "coder" },
      createdAt: new Date().toISOString(),
      scores: {},
      artifacts: {},
      relations: [],
    },
    {
      cid: "def456",
      kind: "review",
      summary: "LGTM — null check looks correct",
      agent: { agentId: "reviewer-xyz", role: "reviewer" },
      createdAt: new Date().toISOString(),
      scores: {},
      artifacts: {},
      relations: [],
    },
  ],
  getContribution: async () => undefined,
  getClaims: async () => [],
  getFrontier: async () => ({ pareto: [], dominated: [], metrics: {} }),
  getActivity: async () => [],
  getDag: async () => ({ nodes: [], edges: [] }),
  getHotThreads: async () => [],
  close: () => {},
  listSessions: async () => [],
  createSession: async () => ({
    sessionId: "test-sess",
    status: "active" as const,
    startedAt: new Date().toISOString(),
    contributionCount: 0,
  }),
  getSession: async () => undefined,
  archiveSession: async () => {},
  addContributionToSession: async () => {},
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
};

async function main() {
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

  // Pre-populate log buffers on the spawn manager
  const coderBuf = spawnManager.ensureLogBuffer("coder");
  coderBuf.pushRawLines([
    "[tool] Read src/auth.ts (completed)",
    "Found 3 issues in authentication flow",
    "[tool] Edit src/auth.ts (running)",
    "  Adding null check on line 42",
    "[IPC from reviewer] LGTM, merge it",
    "[done] end_turn",
  ]);

  const reviewerBuf = spawnManager.ensureLogBuffer("reviewer");
  reviewerBuf.pushRawLines([
    "[tool] Read src/auth.ts (completed)",
    "Code looks correct",
    "[done] end_turn",
  ]);

  const initialState: ScreenState = {
    screen: "running",
    goal: "Review PR #42 for security issues",
    sessionId: "test-sess-123",
    sessionStartedAt: new Date().toISOString(),
  };

  const appProps = {
    provider: mockProvider,
    topology,
    groveDir: undefined,
    tmux: undefined,
    intervalMs: 30000,
    agentRuntime: undefined,
    eventBus: undefined,
  } as Parameters<typeof ScreenManager>[0]["appProps"];

  root.render(
    React.createElement(
      SpawnManagerContext,
      { value: spawnManager },
      React.createElement(ScreenManager, {
        appProps,
        startOnRunning: true,
        initialState,
      }),
    ),
  );

  renderer.start();
  await renderer.idle();

  // Keep alive for interactive testing
  await new Promise((r) => setTimeout(r, 30000));
  renderer.destroy();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

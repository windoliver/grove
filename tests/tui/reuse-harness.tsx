/**
 * E2E rendering harness for session reuse testing.
 *
 * Renders ScreenManager starting on the COMPLETE screen with preset/roleMapping
 * state preserved — simulating the end of a session. When Enter is pressed,
 * the reuse flow should skip to goal-input (Screen 3), NOT preset-select (Screen 1).
 *
 * Used by session-reuse-e2e.test.ts via tmux capture-pane.
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
import type { ScreenState } from "../../src/tui/screens/screen-manager.js";
import { ScreenManager } from "../../src/tui/screens/screen-manager.js";

// Minimal mock provider — satisfies TuiDataProvider + TuiSessionProvider
const mockProvider = {
  capabilities: { sessions: true, goals: true, vfs: false, search: false },
  getDashboard: async () => ({
    totalContributions: 0,
    frontier: [],
    topMetrics: {},
    recentActivity: [],
    activeClaimCount: 0,
    staleClaimCount: 0,
    sessions: [],
  }),
  getContributions: async () => [],
  getContribution: async () => undefined,
  getClaims: async () => [],
  getFrontier: async () => ({ pareto: [], dominated: [], metrics: {} }),
  getActivity: async () => [],
  getDag: async () => ({ nodes: [], edges: [] }),
  getHotThreads: async () => [],
  close: () => {
    /* no-op */
  },
  listSessions: async () => [],
  createSession: async (input: { goal?: string; presetName?: string }) => ({
    sessionId: "test-456",
    goal: input.goal,
    presetName: input.presetName,
    status: "active" as const,
    startedAt: new Date().toISOString(),
    contributionCount: 0,
  }),
  getSession: async () => undefined,
  archiveSession: async () => {
    /* no-op */
  },
  addContributionToSession: async () => {
    /* no-op */
  },
};

// Mock topology with 2 roles (uses goal field)
const topology = {
  structure: "graph" as const,
  roles: [
    {
      name: "coder",
      description: "Writes code",
      command: "echo",
      platform: "claude-code" as const,
      goal: "Implement the session goal",
    },
    {
      name: "reviewer",
      description: "Reviews code",
      command: "echo",
      platform: "codex" as const,
      goal: "Review coder work",
    },
  ],
};

const presets = [
  { name: "review-loop", description: "Coder + reviewer", details: "" },
  { name: "research-loop", description: "3 agent research", details: "" },
];

// Start on complete screen WITH preset state preserved — simulates end of a session
const initialState: ScreenState = {
  screen: "complete",
  selectedPreset: "review-loop",
  detectedAgents: new Map([
    ["claude", true],
    ["codex", true],
    ["gemini", false],
  ]),
  roleMapping: new Map([
    ["coder", "claude"],
    ["reviewer", "codex"],
  ]),
  goal: "Review PR #42",
  sessionId: "prev-session-abc",
  completeSnapshot: {
    reason: "All roles signaled done",
    contributionCount: 7,
  },
};

async function main() {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: false,
  });
  const root = createRoot(renderer);

  root.render(
    React.createElement(ScreenManager, {
      appProps: {
        provider: mockProvider,
        topology,
        groveDir: undefined,
        tmux: undefined,
        intervalMs: 2000,
        agentRuntime: undefined,
        eventBus: undefined,
        presetName: "review-loop",
      } as Parameters<typeof ScreenManager>[0]["appProps"],
      presets,
      sessions: [],
      startOnRunning: false,
      initialState,
    }),
  );

  renderer.start();
  await renderer.idle();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

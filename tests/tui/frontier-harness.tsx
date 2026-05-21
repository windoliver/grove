/**
 * Visual test harness for the redesigned Frontier panel (issue #187).
 *
 * Mounts ScreenManager → RunningView with a mock provider that returns a
 * seeded Frontier exercising every signal: adoption, recency, review,
 * reproduction, plus two metric:* slices. Auto-focuses the Frontier panel
 * (key '3') so the tab bar + Overview render on first capture.
 *
 * Run via tmux for capture-pane verification:
 *
 *   tmux new-session -d -s grove-frontier -x 160 -y 50 \
 *     "bun run tests/tui/frontier-harness.tsx; read"
 *   tmux capture-pane -t grove-frontier -p
 *
 * Or run directly in your terminal:
 *   bun run tests/tui/frontier-harness.tsx
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
import type { Frontier, FrontierEntry } from "../../src/core/frontier.js";
import type { ScreenState } from "../../src/tui/screens/screen-manager.js";
import { ScreenManager } from "../../src/tui/screens/screen-manager.js";
import { SpawnManager } from "../../src/tui/spawn-manager.js";
import { SpawnManagerContext } from "../../src/tui/spawn-manager-context.js";

// ---------------------------------------------------------------------------
// Seeded Frontier — every signal populated
// ---------------------------------------------------------------------------

function entry(cid: string, value: number, summary: string): FrontierEntry {
  return { cid, value, summary };
}

const NOW = Date.now();

const seededFrontier: Frontier = {
  byAdoption: [
    entry(
      "blake3:aaaa0000inference-cache-draft-with-lots-of-padding-cid",
      12,
      "inference cache draft",
    ),
    entry("blake3:bbbb0000batched-scheduler-v3-padding-cid-padding-cid", 9, "batched scheduler v3"),
    entry(
      "blake3:cccc0000prompt-prefix-dedup-padding-cid-padding-cid-padding",
      7,
      "prompt prefix dedup",
    ),
    entry("blake3:dddd0000router-patch-padding-cid-padding-cid-padding-cid", 5, "router patch"),
  ],
  byRecency: [
    entry(
      "blake3:eeee0000fresh-bench-result-padding-cid-padding-cid-padding",
      NOW - 2 * 60 * 1000,
      "fresh bench result",
    ),
    entry(
      "blake3:ffff0000beam-tweak-padding-cid-padding-cid-padding-cid-padding",
      NOW - 18 * 60 * 1000,
      "beam tweak",
    ),
    entry(
      "blake3:1111aaaa-recent-eval-padding-cid-padding-cid-padding-cid",
      NOW - 2 * 60 * 60 * 1000,
      "recent eval",
    ),
  ],
  byReviewScore: [
    entry(
      "blake3:cccc0000prompt-prefix-dedup-padding-cid-padding-cid-padding",
      4.7,
      "prompt prefix dedup",
    ),
    entry(
      "blake3:aaaa0000inference-cache-draft-with-lots-of-padding-cid",
      4.3,
      "inference cache draft",
    ),
    entry("blake3:2222bbbb-attention-rewrite-padding-cid-padding-cid", 3.9, "attention rewrite"),
  ],
  byReproduction: [
    entry("blake3:bbbb0000batched-scheduler-v3-padding-cid-padding-cid", 3, "batched scheduler v3"),
    entry(
      "blake3:cccc0000prompt-prefix-dedup-padding-cid-padding-cid-padding",
      2,
      "prompt prefix dedup",
    ),
  ],
  byMetric: {
    rouge_l: [
      entry(
        "blake3:aaaa0000inference-cache-draft-with-lots-of-padding-cid",
        0.812,
        "inference cache draft",
      ),
      entry(
        "blake3:bbbb0000batched-scheduler-v3-padding-cid-padding-cid",
        0.781,
        "batched scheduler v3",
      ),
      entry(
        "blake3:3333cccc-greedy-decode-padding-cid-padding-cid-padding",
        0.754,
        "greedy decode",
      ),
    ],
    bleu: [
      entry(
        "blake3:aaaa0000inference-cache-draft-with-lots-of-padding-cid",
        0.412,
        "inference cache draft",
      ),
      entry(
        "blake3:cccc0000prompt-prefix-dedup-padding-cid-padding-cid-padding",
        0.388,
        "prompt prefix dedup",
      ),
    ],
  },
};

// ---------------------------------------------------------------------------
// Mock provider
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
    handoffs: false,
  },
  getDashboard: async () => ({
    totalContributions: 12,
    frontier: [],
    topMetrics: {},
    recentActivity: [],
    activeClaimCount: 0,
    staleClaimCount: 0,
    sessions: [],
    activeClaims: [],
    frontierSummary: { topByMetric: [], topByAdoption: [] },
  }),
  getContributions: async () => [],
  getContribution: async () => undefined,
  getClaims: async () => [],
  getFrontier: async (): Promise<Frontier> => seededFrontier,
  getActivity: async () => [],
  getDag: async () => ({ nodes: [], edges: [] }),
  getHotThreads: async () => [],
  close: () => {
    /* no-op */
  },
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
  ],
  edges: [],
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
    () => {
      /* no-op */
    },
    [{ kind: "local" as const, path: "/tmp" }],
  );

  const initialState: ScreenState = {
    screen: "running",
    goal: "Frontier #187 smoke — Ctrl+A then 3 (Frontier), ] / [ to cycle slices, a to adopt",
    sessionId: "frontier-smoke",
    sessionStartedAt: new Date(NOW - 5 * 60_000).toISOString(),
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

  // Keep alive — Ctrl+C / q to exit, or send-keys can drive the harness.
  await new Promise((r) => setTimeout(r, 120_000));
  renderer.destroy();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

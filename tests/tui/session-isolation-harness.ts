/**
 * Harness for session isolation E2E test.
 *
 * Seeds a grove dir's SQLite DB with N completed sessions, loads them via
 * the real listSessions() call (which applies LIMIT 20 + archived exclusion),
 * then renders the TUI preset-select screen with those sessions.
 *
 * This lets us verify that:
 *   - After seeding 55 stale sessions, only ≤5 appear in "Recent sessions"
 *   - Each grove dir reads from its own DB (no cross-contamination)
 *
 * Usage:
 *   bun run tests/tui/session-isolation-harness.ts \
 *     --grove-dir /tmp/grove-a \
 *     --label grove-a \
 *     [--count 55]
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";

import { createSqliteStores } from "../../src/local/sqlite-store.js";
import type { ScreenState } from "../../src/tui/screens/screen-manager.js";
import { ScreenManager } from "../../src/tui/screens/screen-manager.js";
import { SpawnManager } from "../../src/tui/spawn-manager.js";
import { SpawnManagerContext } from "../../src/tui/spawn-manager-context.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "grove-dir": { type: "string" },
    label: { type: "string", default: "grove" },
    count: { type: "string", default: "55" },
  },
  strict: false,
});

const groveDir = values["grove-dir"] as string | undefined;
if (!groveDir) {
  process.stderr.write("--grove-dir is required\n");
  process.exit(1);
}

const label = values.label as string;
const seedCount = parseInt(values.count as string, 10);

// ---------------------------------------------------------------------------
// Seed DB with stale sessions
// ---------------------------------------------------------------------------

mkdirSync(groveDir, { recursive: true });
const dbPath = join(groveDir, "grove.db");
const stores = createSqliteStores(dbPath);

for (let i = 0; i < seedCount; i++) {
  const session = await stores.goalSessionStore.createSession({
    goal: `${label}-goal-${i}`,
    presetName: "review-loop",
    topology: {
      structure: "flat",
      roles: [{ name: "coder", description: "Writes code", platform: "claude-code" as const }],
    },
  });
  await stores.goalSessionStore.updateSession(session.id, {
    status: "completed",
    completedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    stopReason: "done",
  });
}

// Load sessions exactly as main.ts does — LIMIT 20 + archived exclusion applied here
const sessions = [...(await stores.goalSessionStore.listSessions())];
stores.close();

// ---------------------------------------------------------------------------
// Minimal mock provider (satisfies TuiDataProvider + TuiSessionProvider)
// ---------------------------------------------------------------------------

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
    id: `harness-${Date.now()}`,
    goal: input.goal,
    presetName: input.presetName,
    status: "active" as const,
    createdAt: new Date().toISOString(),
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

// ---------------------------------------------------------------------------
// Presets (review-loop available for selection)
// ---------------------------------------------------------------------------

const presets = [
  { name: "review-loop", description: "Coder + reviewer", details: "" },
  { name: "research-loop", description: "3-agent research", details: "" },
];

// ---------------------------------------------------------------------------
// Render ScreenManager starting on preset-select (Screen 1)
// ---------------------------------------------------------------------------

const initialState: ScreenState = {
  screen: "preset-select",
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
    () => {
      /* test harness — errors are silent */
    },
    [{ kind: "local" as const, path: groveDir }],
  );

  const appProps = {
    provider: mockProvider,
    topology: undefined,
    groveDir: undefined,
    tmux: undefined,
    intervalMs: 2000,
    agentRuntime: undefined,
    eventBus: undefined,
    presetName: undefined,
  } as Parameters<typeof ScreenManager>[0]["appProps"];

  root.render(
    React.createElement(
      SpawnManagerContext,
      { value: spawnManager },
      React.createElement(ScreenManager, {
        appProps,
        presets,
        sessions,
        startOnRunning: false,
        initialState,
      }),
    ),
  );

  renderer.start();
  await renderer.idle();
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});

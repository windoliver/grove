/**
 * E2E harness for edge-type-aware workspace provisioning.
 *
 * Renders SpawnProgress with two roles connected by a topology edge.
 * SpawnManager uses resolveRoleWorkspaceStrategies() to pick the correct
 * baseBranch for each role — verified via tmux capture-pane.
 *
 * Args:
 *   --edge-type delegates|feeds|escalates|feedback   (default: delegates)
 *   --use-git-repo                                    (default: false)
 *
 * Expected output (real git repo):
 *   delegates/feeds/escalates → both "started"; reviewer branch based on coder branch
 *   feedback                  → both "started"; both independent (HEAD)
 *
 * Non-git dir: both "started [shared workspace]" (allow-fallback default)
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React, { useEffect, useRef, useState } from "react";
import type { AgentTopology, EdgeType } from "../../src/core/topology.js";
import { MockTmuxManager } from "../../src/tui/agents/tmux-manager.js";
import type { TuiDataProvider } from "../../src/tui/provider.js";
import type { AgentSpawnState } from "../../src/tui/screens/spawn-progress.js";
import { SpawnProgress } from "../../src/tui/screens/spawn-progress.js";
import { SpawnManager } from "../../src/tui/spawn-manager.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "edge-type": { type: "string", default: "delegates" },
    "use-git-repo": { type: "boolean", default: false },
  },
  strict: false,
});

const edgeType = (values["edge-type"] ?? "delegates") as EdgeType;
const useGitRepo = values["use-git-repo"] === true;

// ---------------------------------------------------------------------------
// Temp project root
// ---------------------------------------------------------------------------

const tempRoot = mkdtempSync(join(tmpdir(), "grove-edge-e2e-"));
const groveDir = join(tempRoot, ".grove");
mkdirSync(groveDir, { recursive: true });

if (useGitRepo) {
  execSync("git init", { cwd: tempRoot, stdio: "ignore" });
  execSync("git config user.email test@grove.test", { cwd: tempRoot, stdio: "ignore" });
  execSync("git config user.name Grove-E2E-Test", { cwd: tempRoot, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: tempRoot, stdio: "ignore" });
}

// ---------------------------------------------------------------------------
// Topology: coder → reviewer with the given edge type
// ---------------------------------------------------------------------------

// For delegates/feeds/escalates with workspace test: use branch_from_source.
// For feedback/independent test: no workspace field (default independent).
const usesBranching = edgeType === "delegates" || edgeType === "feeds" || edgeType === "escalates";
const topology: AgentTopology = {
  structure: "graph",
  roles: [
    {
      name: "coder",
      edges: [
        {
          target: "reviewer",
          edgeType,
          ...(usesBranching ? { workspace: "branch_from_source" as const } : {}),
        },
      ],
    },
    { name: "reviewer" },
  ],
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
  async getDashboard() {
    return {
      metadata: {
        name: "test",
        contributionCount: 0,
        activeClaimCount: 0,
        mode: "test",
        backendLabel: "test",
      },
      activeClaims: [],
      recentContributions: [],
      frontierSummary: { topByMetric: [], topByAdoption: [] },
    };
  },
  async getContributions() {
    return [];
  },
  async getContribution() {
    return undefined;
  },
  async getClaims() {
    return [];
  },
  async getFrontier() {
    return { byMetric: {}, byAdoption: [], byRecency: [], byReviewScore: [], byReproduction: [] };
  },
  async getActivity() {
    return [];
  },
  async getDag() {
    return { contributions: [] };
  },
  async getHotThreads() {
    return [];
  },
  async createClaim(input: {
    targetRef: string;
    agent: { agentId: string };
    intentSummary: string;
    leaseDurationMs: number;
  }) {
    const now = new Date();
    return {
      claimId: crypto.randomUUID(),
      targetRef: input.targetRef,
      agent: input.agent,
      status: "active" as const,
      intentSummary: input.intentSummary,
      createdAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + input.leaseDurationMs).toISOString(),
    };
  },
  async checkoutWorkspace(targetRef: string): Promise<string> {
    return join("/tmp", "grove-fallback-ws", targetRef);
  },
  async heartbeatClaim() {
    throw new Error("no claim");
  },
  async releaseClaim() {
    /* no-op */
  },
  async cleanWorkspace() {
    /* no-op */
  },
  close() {
    /* no-op */
  },
} as unknown as TuiDataProvider;

// ---------------------------------------------------------------------------
// Harness component
// ---------------------------------------------------------------------------

const SESSION_ID = `edge-e2e-${Date.now().toString(36)}`;

function HarnessApp(): React.ReactElement {
  const [agents, setAgents] = useState<AgentSpawnState[]>([
    { role: "coder", command: "claude", status: "waiting" as const },
    { role: "reviewer", command: "claude", status: "waiting" as const },
  ]);
  const smRef = useRef<SpawnManager | undefined>(undefined);

  useEffect(() => {
    const mockTmux = new MockTmuxManager();
    const sm = new SpawnManager(
      mockProvider,
      mockTmux,
      (err: string) => process.stderr.write(`[harness] ${err}\n`),
      [{ kind: "local" as const, path: tempRoot }],
      undefined,
      groveDir,
    );
    sm.setSessionId(SESSION_ID);
    sm.setTopology(topology);
    sm.setIsolationPolicy("allow-fallback");
    // Tmux-only harness has no runtime/bridge and doesn't exercise
    // inter-agent IPC; assert delivery is ready so the multi-role
    // `pending` gate doesn't block spawn().
    sm.markDeliveryReady();
    smRef.current = sm;

    setAgents((prev) => prev.map((a) => ({ ...a, status: "spawning" as const })));

    // Spawn coder first (it's the source — reviewer depends on its branch)
    void sm
      .spawn("coder", "claude")
      .then((r) => {
        setAgents((prev) =>
          prev.map((a) =>
            a.role === "coder"
              ? { ...a, status: "started" as const, workspaceMode: r.workspaceMode }
              : a,
          ),
        );
        // Spawn reviewer after coder (needs coder's branch for delegates/feeds/escalates)
        void sm
          .spawn("reviewer", "claude")
          .then((r2) => {
            setAgents((prev) =>
              prev.map((a) =>
                a.role === "reviewer"
                  ? { ...a, status: "started" as const, workspaceMode: r2.workspaceMode }
                  : a,
              ),
            );
          })
          .catch((err: unknown) => {
            setAgents((prev) =>
              prev.map((a) =>
                a.role === "reviewer" ? { ...a, status: "failed" as const, error: String(err) } : a,
              ),
            );
          });
      })
      .catch((err: unknown) => {
        setAgents((prev) =>
          prev.map((a) =>
            a.role === "coder" ? { ...a, status: "failed" as const, error: String(err) } : a,
          ),
        );
      });

    return () => {
      smRef.current = undefined;
    };
  }, []);

  return (
    <SpawnProgress
      agents={agents}
      goal={`edge=${edgeType} gitRepo=${String(useGitRepo)} session=${SESSION_ID}`}
      onAllResolved={() => {
        process.stdout.write("HARNESS_RESOLVED\n");
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, useAlternateScreen: false });
  const root = createRoot(renderer);
  root.render(React.createElement(HarnessApp));
  renderer.start();
  await renderer.idle();
}

main().catch((err: unknown) => {
  process.stderr.write(`harness fatal: ${String(err)}\n`);
  process.exit(1);
});

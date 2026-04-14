/**
 * E2E rendering harness for workspace isolation testing.
 *
 * Renders SpawnProgress with two agents being spawned via a real SpawnManager.
 * Workspace provisioning runs for real — so we can observe policy enforcement
 * on-screen via tmux capture-pane.
 *
 * Args:
 *   --policy allow-fallback|strict   (default: allow-fallback)
 *   --use-git-repo                   (default: false = non-git tmpdir)
 *
 * Expected output:
 *   allow-fallback + no git  → both agents "started"  (fallback_workspace)
 *   strict + no git          → both agents "failed: ..." (Workspace provisioning failed)
 *   allow-fallback + git     → both agents "started"  (isolated_worktree)
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React, { useEffect, useRef, useState } from "react";
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
    policy: { type: "string", default: "allow-fallback" },
    "use-git-repo": { type: "boolean", default: false },
  },
  strict: false,
});

const policy = (values.policy ?? "allow-fallback") as "strict" | "allow-fallback";
const useGitRepo = values["use-git-repo"] === true;

// ---------------------------------------------------------------------------
// Temp project root
// ---------------------------------------------------------------------------

const tempRoot = mkdtempSync(join(tmpdir(), "grove-ws-e2e-"));
const groveDir = join(tempRoot, ".grove");
mkdirSync(groveDir, { recursive: true });

if (useGitRepo) {
  execSync("git init", { cwd: tempRoot, stdio: "ignore" });
  execSync("git config user.email test@grove.test", { cwd: tempRoot, stdio: "ignore" });
  execSync("git config user.name Grove-E2E-Test", { cwd: tempRoot, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: tempRoot, stdio: "ignore" });
}

// ---------------------------------------------------------------------------
// Minimal mock provider (checkoutWorkspace used by allow-fallback path)
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
  /** Fallback workspace path returned when git worktree provisioning fails. */
  async checkoutWorkspace(targetRef: string): Promise<string> {
    return join("/tmp", "grove-fallback-ws", targetRef);
  },
  async heartbeatClaim() {
    throw new Error("no claim to heartbeat");
  },
  async releaseClaim() {
    // no-op
  },
  async cleanWorkspace() {
    // no-op
  },
  close() {
    // no-op
  },
} as unknown as TuiDataProvider;

// ---------------------------------------------------------------------------
// Harness component
// ---------------------------------------------------------------------------

const ROLES = ["coder", "reviewer"];

function HarnessApp(): React.ReactElement {
  const [agents, setAgents] = useState<AgentSpawnState[]>(
    ROLES.map((role) => ({ role, command: "claude", status: "waiting" as const })),
  );

  const smRef = useRef<SpawnManager | undefined>(undefined);

  useEffect(() => {
    const mockTmux = new MockTmuxManager();
    const sm = new SpawnManager(
      mockProvider,
      mockTmux,
      (err: string) => process.stderr.write(`[harness] spawn error: ${err}\n`),
      undefined,
      groveDir,
    );
    sm.setIsolationPolicy(policy);
    smRef.current = sm;

    // Mark all as spawning
    setAgents((prev) => prev.map((a) => ({ ...a, status: "spawning" as const })));

    // Fire spawn() for each role — real workspace provisioning runs here
    for (const role of ROLES) {
      void sm
        .spawn(role, "claude")
        .then((result) => {
          setAgents((prev) =>
            prev.map((a) =>
              a.role === role
                ? { ...a, status: "started" as const, workspaceMode: result.workspaceMode }
                : a,
            ),
          );
        })
        .catch((err: unknown) => {
          setAgents((prev) =>
            prev.map((a) =>
              a.role === role
                ? {
                    ...a,
                    status: "failed" as const,
                    error: String(err),
                  }
                : a,
            ),
          );
        });
    }

    return () => {
      smRef.current = undefined;
    };
  }, []);

  return (
    <SpawnProgress
      agents={agents}
      goal={`policy=${policy} gitRepo=${String(useGitRepo)}`}
      onAllResolved={() => {
        // Stay alive — the E2E test kills the tmux session after capture-pane.
        // Write a sentinel to stdout so the test can poll for readiness.
        process.stdout.write("HARNESS_RESOLVED\n");
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: false,
  });
  const root = createRoot(renderer);
  root.render(React.createElement(HarnessApp));
  renderer.start();
  await renderer.idle();
}

main().catch((err: unknown) => {
  process.stderr.write(`harness fatal: ${String(err)}\n`);
  process.exit(1);
});

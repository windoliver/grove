import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcpxTurn } from "../../acp/types.js";
import type { AgentConfig, AgentRuntime, AgentSession } from "../../core/agent-runtime.js";
import type { AgentSessionEntity } from "../../core/entity.js";
import { agentSessionToEntity } from "../../core/entity.js";
import type { RecipeProvenance } from "../../core/recipe.js";
import type { AgentTopology } from "../../core/topology.js";
import { initSqliteDb } from "../../local/sqlite-store.js";
import { SqliteGoalSessionStore } from "../../local/sqlite-goal-session-store.js";
import { launchGoalSession } from "./launch-session.js";

// ---------------------------------------------------------------------------
// Save / restore env vars that launchGoalSession reads
// ---------------------------------------------------------------------------

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  savedEnv.GROVE_NEXUS_URL = process.env.GROVE_NEXUS_URL;
  savedEnv.GROVE_RUNTIME = process.env.GROVE_RUNTIME;
  // Clear Nexus so the session is NOT mirrored (avoids network calls)
  delete process.env.GROVE_NEXUS_URL;
  // Clear GROVE_RUNTIME — we pass runtime directly so this is a no-op,
  // but clearing it prevents any future selectRuntime changes from interfering.
  delete process.env.GROVE_RUNTIME;
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// QuickIdleRuntime — a MockRuntime that reports all sessions as "idle"
// immediately so the orchestrator can stop after the 30-second grace period
// rather than waiting for the 5-minute session timeout.
// ---------------------------------------------------------------------------

class QuickIdleRuntime implements AgentRuntime {
  /** Set to true to indicate this runtime sends the initial prompt on spawn
   *  (prevents the orchestrator from re-sending it via send()). */
  readonly sendsInitialPromptOnSpawn = true;

  private sessions = new Map<string, AgentSession>();
  private nextId = 0;

  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    const id = `quick-${role}-${this.nextId++}`;
    // Report "idle" immediately so checkAllIdle() sees all agents idle
    // as soon as the 30-second grace period expires.
    const session: AgentSession = {
      id,
      role,
      status: "idle",
      platform: config.platform,
      model: config.model,
    };
    this.sessions.set(id, session);
    return session;
  }

  async send(_session: AgentSession, _message: string): Promise<AcpxTurn> {
    const turnId = `turn-${this.nextId++}`;
    return {
      sessionId: _session.id,
      turnId,
      messages: (async function* () {})(),
      result: Promise.resolve({ turnId, stopReason: "end_turn" }),
      cancel: async () => undefined,
      close: async () => undefined,
    };
  }

  async close(session: AgentSession): Promise<void> {
    this.sessions.delete(session.id);
  }

  onIdle(_session: AgentSession, _callback: () => void): void {
    // No-op: idle is signalled via listSessions() returning idle status.
  }

  async listSessions(): Promise<readonly AgentSession[]> {
    return [...this.sessions.values()];
  }

  async listSessionEntities(): Promise<readonly AgentSessionEntity[]> {
    const items = await this.listSessions();
    return items.map((s) => agentSessionToEntity(s));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("launchGoalSession", () => {
  test(
    "creates a session that records recipe provenance",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "grove-launch-"));
      const groveDir = join(root, ".grove");
      await mkdir(groveDir, { recursive: true });

      // Initialize a real git repo so workspace provisioning (git worktree add)
      // succeeds — provisionWorkspace requires a bare-clone/local git repo with
      // at least one commit.
      execFileSync("git", ["-c", "init.defaultBranch=main", "init", root], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: root, stdio: "pipe" });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "pipe" });
      execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root, stdio: "pipe" });

      try {
        const topology: AgentTopology = {
          structure: "graph",
          roles: [{ name: "coder", maxInstances: 1, platform: "claude-code" }],
        };
        const provenance: RecipeProvenance = {
          recipeDigest: "blake3:abc",
          recipeName: "demo",
          recipeVersion: "1.0.0",
          boundParameterDigest: "blake3:def",
          subRecipeDigests: [],
        };

        let startedId: string | undefined;

        const result = await launchGoalSession({
          groveDir,
          groveRoot: root,
          goal: "demo goal",
          topology,
          contract: { contractVersion: 3, name: "demo" },
          repos: [{ kind: "local", path: root }],
          recipeProvenance: provenance,
          // Inject a lightweight runtime that immediately marks agents idle,
          // so the orchestrator can terminate after the 30-second grace period
          // without spawning a real Claude Code process.
          runtime: new QuickIdleRuntime(),
          // Skip the 30-second grace period so the test completes promptly.
          idleGracePeriodMs: 0,
          onAgentsStarted: ({ sessionId }) => {
            startedId = sessionId;
          },
        });

        expect(startedId).toBeDefined();
        expect(result.sessionId).toBe(startedId!);

        // Re-open the DB after launchGoalSession closes it, and verify the
        // session was persisted with the correct recipe provenance.
        const db = initSqliteDb(join(groveDir, "grove.db"));
        const session = await new SqliteGoalSessionStore(db).getSession(result.sessionId);
        db.close();

        expect(session?.recipeProvenance?.recipeDigest).toBe("blake3:abc");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    // idleGracePeriodMs: 0 bypasses the 30-second grace period; 20s is ample.
    20_000,
  );
});

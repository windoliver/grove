/**
 * Spawn manager — encapsulates the spawn/kill lifecycle so it can be
 * tested independently of React components.
 *
 * Manages: workspace checkout → claim creation → tmux session → heartbeat loop.
 * On kill: stop heartbeat → release claim → clean workspace.
 * On tmux failure: roll back claim + workspace.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { AgentConfig, AgentRuntime, AgentSession } from "../core/agent-runtime.js";
import type { AgentIdentity } from "../core/models.js";
import { safeCleanup } from "../shared/safe-cleanup.js";
import type { SpawnOptions, TmuxManager } from "./agents/tmux-manager.js";
import { agentIdFromSession } from "./agents/tmux-manager.js";
import type { NexusWsBridge } from "./nexus-ws-bridge.js";
import type { TuiDataProvider } from "./provider.js";
import type { PersistedSpawnRecord, SessionStore } from "./session-store.js";

/** PR context injected as env vars when spawning agents. */
export interface PrContext {
  readonly number: number;
  readonly title: string;
  readonly filesChanged: number;
}

/** Tracked state for a spawned agent. */
interface SpawnRecord {
  readonly claimId: string;
  readonly targetRef: string;
  readonly agentId: string;
}

/** Result of a spawn attempt. */
export interface SpawnResult {
  readonly spawnId: string;
  readonly claimId: string;
  readonly workspacePath: string;
}

/**
 * Manages the full spawn/kill lifecycle for TUI-spawned agents.
 *
 * Testable without React — timer setup/teardown and failure rollback
 * are exercised directly.
 */
export class SpawnManager {
  private readonly provider: TuiDataProvider;
  private readonly tmux: TmuxManager | undefined;
  private readonly agentRuntime: AgentRuntime | undefined;
  private readonly spawnRecords = new Map<string, SpawnRecord>();
  private readonly agentSessions = new Map<string, AgentSession>();
  private readonly onError: (message: string) => void;
  private readonly sessionStore: SessionStore | undefined;
  private wsBridge: NexusWsBridge | undefined;
  private prContext: PrContext | undefined;
  private sessionGoal: string | undefined;
  private groveDir: string | undefined;

  constructor(
    provider: TuiDataProvider,
    tmux: TmuxManager | undefined,
    onError: (message: string) => void,
    sessionStore?: SessionStore,
    groveDir?: string,
    agentRuntime?: AgentRuntime,
  ) {
    this.provider = provider;
    this.tmux = tmux;
    this.agentRuntime = agentRuntime;
    this.onError = onError;
    this.sessionStore = sessionStore;
    this.groveDir = groveDir;
  }

  /** Attach a NexusWsBridge for push-based IPC. Call after construction. */
  setWsBridge(bridge: NexusWsBridge): void {
    this.wsBridge = bridge;
  }

  /**
   * Set PR context to inject into spawned agent environments.
   * When set, GROVE_PR_NUMBER, GROVE_PR_TITLE, and GROVE_PR_FILES
   * are passed as environment variables via the spawn options.
   */
  setPrContext(ctx: PrContext | undefined): void {
    this.prContext = ctx;
  }

  /** Get the current PR context (for testing). */
  getPrContext(): PrContext | undefined {
    return this.prContext;
  }

  /**
   * Set the session goal. When set, spawned agents receive this as their
   * initial prompt along with their role description.
   */
  setSessionGoal(goal: string | undefined): void {
    this.sessionGoal = goal;
  }

  /**
   * Spawn a new agent session.
   *
   * Lifecycle: workspace checkout → claim → tmux session → heartbeat.
   * On failure at any step, all previously-created state is rolled back.
   */
  async spawn(
    roleId: string,
    command: string,
    _parentAgentId?: string,
    _depth = 0,
    context?: Record<string, unknown>,
  ): Promise<SpawnResult> {
    const spawnId = `${roleId}-${Date.now().toString(36)}`;
    const agent: AgentIdentity = {
      agentId: spawnId,
      ...(roleId !== spawnId ? { role: roleId } : {}),
    };

    // Step 1: Create git worktree for the agent.
    // Uses a real git worktree so the agent has actual source code,
    // can edit files, commit, push, and create PRs.
    let workspacePath: string;
    {
      // Find the project root (parent of .grove/)
      const groveDir = this.groveDir;
      const projectRoot = groveDir ? resolve(groveDir, "..") : process.cwd();
      const baseDir = groveDir
        ? join(groveDir, "workspaces")
        : join(projectRoot, ".grove", "workspaces");
      const branch = `grove/session/${spawnId}`;
      workspacePath = join(baseDir, spawnId);

      try {
        if (!existsSync(baseDir)) {
          await mkdir(baseDir, { recursive: true });
        }
        execSync(`git worktree add "${workspacePath}" -b "${branch}" origin/main`, {
          cwd: projectRoot,
          encoding: "utf-8",
          stdio: "pipe",
        });
      } catch {
        // Fallback to provider's bare workspace if git worktree fails
        if (this.provider.checkoutWorkspace) {
          workspacePath = await this.provider.checkoutWorkspace(spawnId, agent);
        } else {
          throw new Error("Failed to create git worktree and no fallback available");
        }
      }
    }

    // Step 2: Write config files. Errors logged but non-fatal.
    // Claims are NOT auto-created on spawn — agents create claims explicitly
    // via grove_claim MCP tool when they need swarm coordination.
    try {
      await this.writeMcpConfig(workspacePath);
      await this.writeAgentInstructions(workspacePath, roleId, context);
      if (context?.rolePrompt || context?.roleDescription) {
        await this.writeAgentContext(workspacePath, roleId, context);
      }
      // Step 2c: Protect config files from agent mutation (#7 Workspace Mutation Constraints)
      const { chmod } = await import("node:fs/promises");
      for (const protectedFile of [".mcp.json", "CLAUDE.md", "CODEX.md"]) {
        const filePath = join(workspacePath, protectedFile);
        await chmod(filePath, 0o444).catch(() => {
          // File may not exist — non-fatal
        });
      }
    } catch (configErr) {
      this.onError(
        `Config write failed: ${configErr instanceof Error ? configErr.message : String(configErr)}`,
      );
      // Continue — agent can still work without configs
    }

    // Step 3: Start agent session via AgentRuntime (preferred) or tmux (fallback).
    try {
      const roleEnv: Record<string, string> = {
        GROVE_AGENT_ID: spawnId,
        GROVE_AGENT_ROLE: roleId,
      };
      const prEnv: Record<string, string> = this.prContext
        ? {
            GROVE_PR_NUMBER: String(this.prContext.number),
            GROVE_PR_TITLE: this.prContext.title,
            GROVE_PR_FILES: String(this.prContext.filesChanged),
          }
        : {};

      // Build initial prompt from goal + role
      let initialPrompt: string | undefined;
      if (this.sessionGoal || context?.rolePrompt) {
        const parts: string[] = [];
        if (this.sessionGoal) parts.push(this.sessionGoal);
        if (context?.rolePrompt) parts.push(String(context.rolePrompt));
        else if (context?.roleDescription) parts.push(String(context.roleDescription));
        parts.push("Read CLAUDE.md for full instructions.");
        initialPrompt = parts.join(". ");
      }

      // Compose agent command with auto-approve flags
      let agentCommand = command;
      const baseCmd = command.split(/\s+/)[0] ?? command;
      if (baseCmd === "claude") {
        agentCommand = `rm -f ~/.claude/remote-settings.json; ${command} --dangerously-skip-permissions`;
      } else if (baseCmd === "codex") {
        agentCommand = `${command} --full-auto`;
      }
      if (initialPrompt) {
        agentCommand = `${agentCommand} "${initialPrompt.replace(/"/g, '\\"')}"`;
      }

      if (this.agentRuntime) {
        // Use AgentRuntime interface — works with acpx, subprocess, or any runtime
        // Determine if this role should wait for IPC push instead of starting immediately.
        // Detected from prompt content: "wait for" signals a reactive role.
        const rolePromptText = String(context?.rolePrompt ?? "").toLowerCase();
        const waitForPush = context?.waitForPush === true || rolePromptText.includes("wait for");

        const agentConfig: AgentConfig = {
          role: roleId,
          command: agentCommand,
          cwd: workspacePath,
          env: { ...roleEnv, ...prEnv },
          goal: this.sessionGoal,
          prompt: initialPrompt,
          waitForPush,
        };
        const session = await this.agentRuntime.spawn(roleId, agentConfig);
        this.agentSessions.set(spawnId, session);
      } else if (this.tmux) {
        // Fallback: tmux (for TUI testing)
        const options: SpawnOptions = {
          agentId: spawnId,
          command: agentCommand,
          targetRef: spawnId,
          workspacePath,
          env: { ...roleEnv, ...prEnv },
        };
        await this.tmux.spawn(options);
      } else {
        throw new Error("No agent runtime or tmux available for spawning");
      }
    } catch (spawnErr) {
      // Roll back workspace on spawn failure
      if (this.provider.cleanWorkspace) {
        await safeCleanup(
          this.provider.cleanWorkspace(spawnId, spawnId),
          "rollback workspace after spawn failure",
          { silent: true },
        );
      }
      throw spawnErr;
    }

    // Step 3b: Provision IPC inbox in Nexus for this role.
    const nexusUrl = process.env.GROVE_NEXUS_URL;
    const nexusKey = process.env.NEXUS_API_KEY;
    if (nexusUrl && nexusKey) {
      void fetch(`${nexusUrl}/api/v2/ipc/provision/${encodeURIComponent(roleId)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${nexusKey}` },
      }).catch(() => {
        /* best-effort */
      });
    }

    // Step 4: Record spawn + register for IPC push.
    // No claims, no heartbeats — agents create claims themselves via grove_claim
    // when they need swarm coordination.
    this.spawnRecords.set(spawnId, {
      claimId: "",
      targetRef: spawnId,
      agentId: spawnId,
    });
    this.sessionStore?.save({
      spawnId,
      claimId: "",
      targetRef: spawnId,
      agentId: spawnId,
      workspacePath,
      spawnedAt: new Date().toISOString(),
    });

    // Step 5: Register session with NexusWsBridge for push-based IPC.
    // When another agent contributes, Nexus pushes via WebSocket → bridge
    // forwards to this agent via runtime.send(). No polling.
    const agentSession = this.agentSessions.get(spawnId);
    if (agentSession && this.wsBridge) {
      this.wsBridge.registerSession(roleId, agentSession);
    }

    return {
      spawnId,
      claimId: "",
      workspacePath,
    };
  }

  /**
   * Kill an agent session and clean up all associated state.
   *
   * Uses local spawn records so cleanup works even if the claim's
   * lease has expired (no longer returned by active claim queries).
   */
  async kill(sessionName: string): Promise<void> {
    // Step 1: Kill agent session via runtime or tmux
    const killedAgentId = agentIdFromSession(sessionName);
    const agentSession = killedAgentId ? this.agentSessions.get(killedAgentId) : undefined;
    if (agentSession && this.agentRuntime) {
      await this.agentRuntime.close(agentSession);
      if (killedAgentId) this.agentSessions.delete(killedAgentId);
    } else {
      await this.tmux?.kill(sessionName);
    }

    // Step 2: Clean up local records + workspace
    if (!killedAgentId) return;

    const tracked = this.spawnRecords.get(killedAgentId);
    if (tracked) {
      this.spawnRecords.delete(killedAgentId);
      this.sessionStore?.remove(killedAgentId);
      this.wsBridge?.unregisterSession(killedAgentId);

      if (this.provider.cleanWorkspace) {
        await safeCleanup(
          this.provider.cleanWorkspace(tracked.targetRef, killedAgentId),
          "clean workspace during kill",
          { silent: true },
        );
      }
    }
  }

  /** Get the spawn record for an agentId (for testing). */
  getSpawnRecord(agentId: string): SpawnRecord | undefined {
    return this.spawnRecords.get(agentId);
  }

  /** Count active spawns per role — used by palette for capacity checks. */
  getActiveSpawnCounts(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const [spawnId] of this.spawnRecords) {
      // spawnId format: "roleName-timestamp"
      const role = spawnId.replace(/-[a-z0-9]+$/i, "");
      counts.set(role, (counts.get(role) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Reconcile persisted session state with live tmux sessions.
   *
   * Called on TUI startup to recover from crashes. Uses two data sources:
   * 1. Local file store (.grove/tui-sessions.json) — fast, survives crashes
   * 2. Claim store (SQLite/Nexus) — authoritative, survives machine migration
   *
   * For each persisted record:
   * - Live tmux session → reattach (restore in-memory state + restart heartbeat)
   * - Dead tmux session → release claim + clean workspace + remove record
   */
  async reconcile(): Promise<{ reattached: number; released: number }> {
    // Collect records from local file store
    const fileRecords = this.sessionStore?.loadAll() ?? [];

    // Also query claims with tuiSpawned context as Nexus-backed fallback.
    // This catches records that survive across machines or when the local
    // file store is lost (e.g., different checkout, wiped .grove).
    const claimRecords = await this.loadRecordsFromClaims();

    // Merge: file records take precedence (more fields), claim records fill gaps
    const seen = new Set<string>();
    const allRecords: PersistedSpawnRecord[] = [];
    for (const r of fileRecords) {
      seen.add(r.spawnId);
      allRecords.push(r);
    }
    for (const r of claimRecords) {
      if (!seen.has(r.spawnId)) {
        allRecords.push(r);
      }
    }

    if (allRecords.length === 0) return { reattached: 0, released: 0 };

    // Get live agent sessions from runtime or tmux
    let liveSet: Set<string>;
    if (this.agentRuntime) {
      const sessions = await this.agentRuntime.listSessions();
      liveSet = new Set(sessions.map((s) => s.id));
    } else {
      const liveSessions = (await this.tmux?.listSessions()) ?? [];
      liveSet = new Set(liveSessions);
    }

    let reattached = 0;
    let released = 0;

    for (const record of allRecords) {
      const tmuxName = `grove-${record.spawnId}`;
      if (liveSet.has(tmuxName)) {
        // Re-attach: restore in-memory state
        this.spawnRecords.set(record.spawnId, {
          claimId: record.claimId,
          targetRef: record.targetRef,
          agentId: record.agentId,
        });
        reattached++;
      } else {
        // Dead session: clean workspace + remove record
        if (this.provider.cleanWorkspace) {
          await safeCleanup(
            this.provider.cleanWorkspace(record.targetRef, record.agentId),
            `clean orphaned workspace for ${record.spawnId}`,
            { silent: true },
          );
        }
        this.sessionStore?.remove(record.spawnId);
        released++;
      }
    }

    return { reattached, released };
  }

  /**
   * Query active claims with `tuiSpawned: true` context and convert to
   * PersistedSpawnRecords. This is the Nexus-backed recovery path.
   */
  private async loadRecordsFromClaims(): Promise<readonly PersistedSpawnRecord[]> {
    try {
      const claims = await this.provider.getClaims({ status: "active" });
      const records: PersistedSpawnRecord[] = [];
      for (const claim of claims) {
        const ctx = claim.context as Record<string, unknown> | undefined;
        if (ctx?.tuiSpawned === true && typeof ctx.spawnId === "string") {
          records.push({
            spawnId: ctx.spawnId as string,
            claimId: claim.claimId,
            targetRef: claim.targetRef,
            agentId: claim.agent.agentId,
            workspacePath:
              typeof ctx.workspacePath === "string" ? (ctx.workspacePath as string) : "",
            spawnedAt: claim.createdAt,
          });
        }
      }
      return records;
    } catch {
      // Claims query may fail (e.g., Nexus unreachable) — degrade gracefully
      return [];
    }
  }

  /** Close bridge and clear state. */
  destroy(): void {
    this.spawnRecords.clear();
    this.wsBridge?.close();
  }

  /**
   * Write .mcp.json into the agent workspace so the agent CLI (claude, codex)
   * discovers grove MCP tools automatically.
   */
  private async writeMcpConfig(workspacePath: string): Promise<void> {
    // Resolve the .grove directory — workspaces live under .grove/workspaces/
    const groveDir = join(workspacePath, "..", "..");
    // Resolve the project root (parent of .grove) for finding src/mcp/serve.ts
    const projectRoot = join(groveDir, "..");
    // Pass Nexus URL to MCP server for IPC event routing
    const mcpEnv: Record<string, string> = {
      GROVE_DIR: groveDir,
    };
    if (process.env.GROVE_NEXUS_URL) {
      mcpEnv.GROVE_NEXUS_URL = process.env.GROVE_NEXUS_URL;
    }
    if (process.env.NEXUS_API_KEY) {
      mcpEnv.NEXUS_API_KEY = process.env.NEXUS_API_KEY;
    }

    const mcpConfig = {
      mcpServers: {
        grove: {
          command: "bun",
          args: ["run", join(projectRoot, "src", "mcp", "serve.ts")],
          env: mcpEnv,
        },
      },
    };
    await writeFile(join(workspacePath, ".mcp.json"), JSON.stringify(mcpConfig, null, 2), "utf-8");
  }

  /**
   * Write CLAUDE.md (agent instructions) into the workspace.
   * Tells the agent its role. Communication happens automatically via
   * Nexus IPC — agents receive events when other agents contribute.
   */
  private async writeAgentInstructions(
    workspacePath: string,
    roleId: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const roleDescription = context?.roleDescription ?? "";
    const rolePrompt = context?.rolePrompt ?? "";
    const goal = this.sessionGoal || rolePrompt || "Follow your role instructions below.";

    const instructions = `# Grove Agent: ${roleId}

## Session Goal
${goal}

## Your Role: ${roleId}
${roleDescription}

${rolePrompt ? `## Instructions\n${rolePrompt}\n` : ""}

## Identity

You are the **${roleId}** agent. Always pass \`agent: { role: "${roleId}" }\` in grove_contribute and grove_done calls. This is set once here — do not worry about it after this.

## Communication

You will receive push notifications from the system when other agents produce work relevant to you. These arrive as messages in your session — you do NOT need to poll or check for them. Just work on the session goal, and when a notification arrives, act on it.

## MCP Tools (use sparingly)

- \`grove_contribute\` — record your work (always include agent: { role: "${roleId}" })
- \`grove_done\` — signal session complete (only after approval from other agents)

Do NOT call grove_log, grove_search, grove_frontier, grove_checkout, grove_goal, or grove_read_inbox. You receive everything you need via push notifications.

## Workflow

Follow the Instructions section above exactly. You are in a git worktree with full source code. You can edit files, commit, push, create PRs, and use gh CLI.
`;

    await writeFile(join(workspacePath, "CLAUDE.md"), instructions, "utf-8");
  }

  private async writeAgentContext(
    workspacePath: string,
    roleId: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    const contextDir = join(workspacePath, ".grove");
    await mkdir(contextDir, { recursive: true });

    const lines: string[] = [`# Agent Context: ${roleId}`, ""];
    if (context.roleDescription) {
      lines.push(`## Role`, "", String(context.roleDescription), "");
    }
    if (context.rolePrompt) {
      lines.push(`## Instructions`, "", String(context.rolePrompt), "");
    }
    lines.push(
      `## Available MCP Tools`,
      "",
      "- grove_frontier — discover best contributions to build on",
      "- grove_claim / grove_release — coordinate work to avoid duplication",
      "- grove_checkout — materialize artifacts into your workspace",
      "- grove_contribute — submit your work",
      "- grove_review — submit a code review",
      "- grove_send_message / grove_read_inbox — agent-to-agent messaging",
      "- grove_create_plan / grove_update_plan — maintain project plans",
      "- grove_check_stop — check if stop conditions are met",
      "",
    );

    await writeFile(join(contextDir, "agent-context.md"), lines.join("\n"), "utf-8");
  }
}

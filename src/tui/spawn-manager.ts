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

import type { AgentIdentity, Claim } from "../core/models.js";
import { safeCleanup } from "../shared/safe-cleanup.js";
import type { SpawnOptions, TmuxManager } from "./agents/tmux-manager.js";
import { agentIdFromSession } from "./agents/tmux-manager.js";
import type { TuiDataProvider } from "./provider.js";
import type { PersistedSpawnRecord, SessionStore } from "./session-store.js";

/** Lease duration for TUI-spawned agent claims. */
const LEASE_DURATION_MS = 300_000; // 5 minutes

/** Heartbeat interval: renew at ~40% of lease duration. */
const HEARTBEAT_INTERVAL_MS = 120_000; // 2 minutes

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
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly spawnRecords = new Map<string, SpawnRecord>();
  private readonly onError: (message: string) => void;
  private readonly sessionStore: SessionStore | undefined;
  private prContext: PrContext | undefined;
  private sessionGoal: string | undefined;
  private groveDir: string | undefined;

  /** Overridable heartbeat interval for testing. */
  heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS;

  constructor(
    provider: TuiDataProvider,
    tmux: TmuxManager | undefined,
    onError: (message: string) => void,
    sessionStore?: SessionStore,
    groveDir?: string,
  ) {
    this.provider = provider;
    this.tmux = tmux;
    this.onError = onError;
    this.sessionStore = sessionStore;
    this.groveDir = groveDir;
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
    parentAgentId?: string,
    depth = 0,
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
        execSync(
          `git worktree add "${workspacePath}" -b "${branch}" origin/main`,
          { cwd: projectRoot, encoding: "utf-8", stdio: "pipe" },
        );
      } catch {
        // Fallback to provider's bare workspace if git worktree fails
        if (this.provider.checkoutWorkspace) {
          workspacePath = await this.provider.checkoutWorkspace(spawnId, agent);
        } else {
          throw new Error("Failed to create git worktree and no fallback available");
        }
      }
    }

    // Step 2: Create claim.
    let claim: Claim | undefined;
    if (this.provider.createClaim) {
      claim = await this.provider.createClaim({
        targetRef: spawnId,
        agent,
        intentSummary: `TUI-spawned: ${command}`,
        leaseDurationMs: LEASE_DURATION_MS,
        context: {
          tuiSpawned: true,
          spawnId,
          workspacePath,
          ...(parentAgentId !== undefined ? { parentAgentId, depth } : {}),
          ...context,
        },
      });
    }

    // Step 2b: Write .mcp.json so the agent discovers grove MCP tools.
    await this.writeMcpConfig(workspacePath);

    // Step 2c: Write CLAUDE.md with role instructions for the agent.
    await this.writeAgentInstructions(workspacePath, roleId, context);

    // Step 2d: Write agent context file if role prompt/description available.
    if (context?.rolePrompt || context?.roleDescription) {
      await this.writeAgentContext(workspacePath, roleId, context);
    }

    // Step 3: Start tmux session. Roll back on failure.
    // Always pass GROVE_AGENT_ID and GROVE_AGENT_ROLE as env vars.
    // If PR context is available, also pass GROVE_PR_* env vars.
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

      // Compose the agent command with auto-approve flags and session goal.
      // claude → claude --dangerously-skip-permissions "prompt"
      // codex  → codex --full-auto "prompt"
      let agentCommand = command;
      {
        // Add auto-approve flags based on agent CLI
        const baseCmd = command.split(/\s+/)[0] ?? command;
        if (baseCmd === "claude") {
          // Remove remote-settings.json before each launch (it syncs back)
          agentCommand = `rm -f ~/.claude/remote-settings.json; ${command} --dangerously-skip-permissions`;
        } else if (baseCmd === "codex") {
          agentCommand = `${command} --full-auto`;
        }

        // Append session goal + role prompt as initial prompt.
        // The role prompt comes from GROVE.md topology (role.prompt field),
        // not hardcoded here. The TUI's guided flow lets users edit these.
        if (this.sessionGoal || context?.rolePrompt) {
          const parts: string[] = [];
          if (this.sessionGoal) parts.push(this.sessionGoal);
          if (context?.rolePrompt) parts.push(String(context.rolePrompt));
          else if (context?.roleDescription) parts.push(String(context.roleDescription));
          parts.push("Read CLAUDE.md for full instructions.");
          const prompt = parts.join(". ");
          agentCommand = `${agentCommand} "${prompt.replace(/"/g, '\\"')}"`;
        }
      }

      const options: SpawnOptions = {
        agentId: spawnId,
        command: agentCommand,
        targetRef: spawnId,
        workspacePath,
        env: { ...roleEnv, ...prEnv },
      };
      await this.tmux?.spawn(options);
    } catch (spawnErr) {
      // Roll back claim + workspace
      if (claim && this.provider.releaseClaim) {
        await safeCleanup(
          this.provider.releaseClaim(claim.claimId),
          "rollback claim after spawn failure",
          { silent: true },
        );
      }
      if (this.provider.cleanWorkspace) {
        await safeCleanup(
          this.provider.cleanWorkspace(spawnId, spawnId),
          "rollback workspace after spawn failure",
          { silent: true },
        );
      }
      throw spawnErr;
    }

    // Step 4: Start heartbeat + record tracking info.
    // No initial prompt is sent — the agent reads CLAUDE.md in its workspace
    // for role instructions and session goal. Communication happens via
    // Nexus IPC and the grove DAG, not tmux send-keys.
    if (claim) {
      this.startHeartbeat(claim.claimId);
      this.spawnRecords.set(spawnId, {
        claimId: claim.claimId,
        targetRef: spawnId,
        agentId: spawnId,
      });

      // Step 6: Persist spawn record to session store for crash recovery.
      this.sessionStore?.save({
        spawnId,
        claimId: claim.claimId,
        targetRef: spawnId,
        agentId: spawnId,
        workspacePath,
        spawnedAt: new Date().toISOString(),
      });
    }

    return {
      spawnId,
      claimId: claim?.claimId ?? "",
      workspacePath,
    };
  }

  /**
   * Kill a tmux session and clean up all associated state.
   *
   * Uses local spawn records so cleanup works even if the claim's
   * lease has expired (no longer returned by active claim queries).
   */
  async kill(sessionName: string): Promise<void> {
    // Step 1: Kill tmux session
    await this.tmux?.kill(sessionName);

    // Step 2: Look up from local records
    const killedAgentId = agentIdFromSession(sessionName);
    if (!killedAgentId) return;

    const tracked = this.spawnRecords.get(killedAgentId);
    if (tracked) {
      this.stopHeartbeat(tracked.claimId);
      this.spawnRecords.delete(killedAgentId);
      this.sessionStore?.remove(killedAgentId);

      if (this.provider.releaseClaim) {
        await safeCleanup(
          this.provider.releaseClaim(tracked.claimId),
          "release claim during kill",
          {
            silent: true,
          },
        );
      }
      if (this.provider.cleanWorkspace) {
        await safeCleanup(
          this.provider.cleanWorkspace(tracked.targetRef, killedAgentId),
          "clean workspace during kill",
          { silent: true },
        );
      }
      return;
    }

    // Fallback: query active claims
    const claims = await this.provider.getClaims({ agentId: killedAgentId, status: "active" });
    for (const claim of claims) {
      if (claim.agent.agentId === killedAgentId) {
        this.stopHeartbeat(claim.claimId);
        if (this.provider.releaseClaim) {
          await this.provider.releaseClaim(claim.claimId);
        }
        if (this.provider.cleanWorkspace) {
          await this.provider.cleanWorkspace(claim.targetRef, killedAgentId);
        }
      }
    }
  }

  /** Whether a heartbeat timer is running for the given claimId. */
  hasHeartbeat(claimId: string): boolean {
    return this.heartbeatTimers.has(claimId);
  }

  /** Get the spawn record for an agentId (for testing). */
  getSpawnRecord(agentId: string): SpawnRecord | undefined {
    return this.spawnRecords.get(agentId);
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

    // Get live tmux sessions
    const liveSessions = (await this.tmux?.listSessions()) ?? [];
    const liveSet = new Set(liveSessions);

    let reattached = 0;
    let released = 0;

    for (const record of allRecords) {
      const tmuxName = `grove-${record.spawnId}`;
      if (liveSet.has(tmuxName)) {
        // Re-attach: restore in-memory state + restart heartbeat
        this.spawnRecords.set(record.spawnId, {
          claimId: record.claimId,
          targetRef: record.targetRef,
          agentId: record.agentId,
        });
        this.startHeartbeat(record.claimId);
        reattached++;
      } else {
        // Dead session: release claim + clean workspace + remove record
        if (this.provider.releaseClaim) {
          await safeCleanup(
            this.provider.releaseClaim(record.claimId),
            `release orphaned claim ${record.claimId}`,
            { silent: true },
          );
        }
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

  /** Stop all timers and clear state. */
  destroy(): void {
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();
    this.spawnRecords.clear();
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
    await writeFile(
      join(workspacePath, ".mcp.json"),
      JSON.stringify(mcpConfig, null, 2),
      "utf-8",
    );
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
    const goal = this.sessionGoal ?? "";

    const instructions = `# Grove Agent: ${roleId}

${goal ? `## Session Goal\n${goal}\n` : ""}
## Your Role
${roleDescription}

${rolePrompt ? `## Instructions\n${rolePrompt}\n` : ""}

## How This Works

You are part of a multi-agent grove session. You have grove MCP tools available:

- \`grove_contribute\` — record your work (kind=work), reviews (kind=review), or questions (kind=ask_user)
- \`grove_review\` — review another agent's contribution by CID
- \`grove_done\` — signal you are finished (other agents see this and can wrap up too)
- \`grove_log\` — see recent contributions from all agents
- \`grove_frontier\` — see the best contributions
- \`grove_search\` — search contributions

You will receive notifications automatically via Nexus IPC when other agents
contribute work relevant to your role. Act on notifications according to your role.
When you complete work, call \`grove_contribute\` to record it in the DAG.
When you have no more work to do, call \`grove_done\` to signal completion.

Start by working on the session goal. Use \`grove_log\` to see what others have done.

You are in a git worktree with the full project source code. You can:
- Edit files, run tests, commit, and push
- Create branches and PRs via \`gh pr create\`
- When you finish your work, commit + push + create a PR, then call \`grove_contribute\` to record it
- Call \`grove_done\` when you have no more work to do
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

  private startHeartbeat(claimId: string): void {
    if (!this.provider.heartbeatClaim) return;
    const heartbeatFn = this.provider.heartbeatClaim.bind(this.provider);
    const timer = setInterval(() => {
      heartbeatFn(claimId, LEASE_DURATION_MS).catch((err) => {
        const msg = err instanceof Error ? err.message : "Heartbeat failed";
        this.onError(`Heartbeat for ${claimId.slice(0, 8)}: ${msg}`);
      });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimers.set(claimId, timer);
  }

  private stopHeartbeat(claimId: string): void {
    const timer = this.heartbeatTimers.get(claimId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.heartbeatTimers.delete(claimId);
    }
  }
}

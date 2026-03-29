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
        execSync(`git worktree add "${workspacePath}" -b "${branch}" HEAD`, {
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

    // Build a map of live sessions for quick lookup
    const liveSessionMap = new Map<string, import("../core/agent-runtime.js").AgentSession>();
    if (this.agentRuntime) {
      for (const session of await this.agentRuntime.listSessions()) {
        liveSessionMap.set(session.id, session);
      }
    }

    for (const record of allRecords) {
      const tmuxName = `grove-${record.spawnId}`;
      if (liveSet.has(tmuxName)) {
        // Re-attach: restore in-memory state
        this.spawnRecords.set(record.spawnId, {
          claimId: record.claimId,
          targetRef: record.targetRef,
          agentId: record.agentId,
        });
        // Also restore agent session so sendToAgent/getActiveRoles work
        const liveSession = liveSessionMap.get(tmuxName);
        if (liveSession) {
          this.agentSessions.set(record.spawnId, liveSession);
        }
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

    // Fallback: scan live acpx sessions and reattach those whose workspace
    // is under this grove's workspaces directory (filters out other projects).
    if (reattached === 0 && this.agentRuntime && this.groveDir) {
      const workspacesPrefix = join(this.groveDir, "workspaces");
      // acpx sessions list includes the cwd — use it to filter
      try {
        const output = execSync("acpx codex sessions list", { encoding: "utf-8", stdio: "pipe" });
        for (const line of output.trim().split("\n").filter(Boolean)) {
          const fields = line.split("\t");
          const name = (fields[1] ?? "").trim();
          const cwd = (fields[2] ?? "").trim();
          const isClosed = line.includes("[closed]");
          if (!name.startsWith("grove-") || isClosed) continue;
          if (!cwd.startsWith(workspacesPrefix) && !cwd.startsWith(`/private${workspacesPrefix}`))
            continue;

          const role = name.replace(/^grove-/, "").replace(/-\d+-.*$/, "");
          if (role && !this.agentSessions.has(role)) {
            const session = liveSessionMap.get(name);
            if (session) {
              this.agentSessions.set(role, session);
              this.spawnRecords.set(role, { claimId: "", targetRef: role, agentId: role });
              reattached++;
            }
          }
        }
      } catch {
        // Best-effort
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

  /**
   * Route a contribution to downstream agents via topology edges.
   *
   * This is the local IPC mechanism: when a contribution appears from a source
   * role, look up topology edges and push a message to each target role's
   * agent session via runtime.send().
   */
  async routeContribution(
    sourceRole: string,
    summary: string,
    kind: string,
    topology?: import("../core/topology.js").AgentTopology,
  ): Promise<void> {
    if (!topology || !this.agentRuntime) return;

    // Find target roles from topology edges
    const sourceRoleDef = topology.roles.find((r) => r.name === sourceRole);
    if (!sourceRoleDef?.edges) return;

    // Find source workspace path
    let sourceWorkspace: string | undefined;
    for (const spawnId of this.spawnRecords.keys()) {
      if (spawnId.startsWith(sourceRole) && this.groveDir) {
        sourceWorkspace = join(this.groveDir, "workspaces", spawnId);
        break;
      }
    }
    // Also check agentSessions keys (reconciled sessions use role as key)
    if (!sourceWorkspace && this.groveDir) {
      for (const key of this.agentSessions.keys()) {
        if (key.startsWith(sourceRole)) {
          sourceWorkspace = join(this.groveDir, "workspaces", key);
          break;
        }
      }
    }

    const targetRoles = sourceRoleDef.edges.map((e) => e.target);
    for (const targetRole of targetRoles) {
      // Find the agent session for this target role
      for (const [spawnId, session] of this.agentSessions) {
        if (spawnId.startsWith(targetRole)) {
          // Sync source workspace files to target workspace before sending IPC.
          // Each agent has its own git worktree — files created by one agent
          // are invisible to others without syncing.
          if (sourceWorkspace && this.groveDir) {
            const targetWorkspace = join(this.groveDir, "workspaces", spawnId);
            try {
              execSync(
                `rsync -a --exclude='.git' --exclude='.mcp.json' --exclude='CODEX.md' --exclude='CLAUDE.md' --exclude='.grove-role' "${sourceWorkspace}/" "${targetWorkspace}/"`,
                { stdio: "pipe", timeout: 10_000 },
              );
            } catch {
              // Best-effort — agent can still work without sync
            }
          }

          const message = `[IPC from ${sourceRole}] New ${kind}: ${summary}. Please review and respond.`;

          // Send via Nexus IPC (persists message + triggers SSE) AND direct runtime.send
          if (this.wsBridge) {
            void (this.wsBridge as import("./nexus-ws-bridge.js").NexusWsBridge)
              .send(sourceRole, targetRole, { summary, kind })
              .catch(() => {
                /* best-effort */
              });
          }
          try {
            await this.agentRuntime.send(session, message);
          } catch {
            // Non-fatal
          }
          break;
        }
      }
    }
  }

  /**
   * Send a user message to a specific agent role.
   *
   * Looks up the active agent session for the given role and pushes the
   * message via runtime.send(). This triggers the agent to process the
   * message as if it were an IPC notification.
   */
  async sendToAgent(role: string, message: string): Promise<boolean> {
    if (!this.agentRuntime) return false;

    for (const [spawnId, session] of this.agentSessions) {
      if (spawnId.startsWith(role)) {
        await this.agentRuntime.send(session, message);
        return true;
      }
    }
    return false;
  }

  /** Get list of active agent roles (for UI display). */
  getActiveRoles(): string[] {
    const roles: string[] = [];
    for (const spawnId of this.agentSessions.keys()) {
      const role = spawnId.replace(/-[a-z0-9]+$/i, "");
      if (!roles.includes(role)) roles.push(role);
    }
    return roles;
  }

  /** Close bridge and clear state (agents stay alive in acpx). */
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
    // MCP server writes to local SQLite (same DB as HTTP server).
    // Do NOT pass GROVE_NEXUS_URL — Nexus VFS reads hit rate limits.
    // IPC routing uses Nexus separately via NexusWsBridge.
    const mcpEnv: Record<string, string> = {
      GROVE_DIR: groveDir,
    };

    // Find the grove MCP server: check dist/ first (installed), then src/ (dev)
    const { dirname } = await import("node:path");
    const groveRoot = dirname(dirname(dirname(new URL(import.meta.url).pathname)));
    let mcpServePath = join(groveRoot, "dist", "mcp", "serve.js");
    if (!existsSync(mcpServePath)) {
      mcpServePath = join(groveRoot, "src", "mcp", "serve.ts");
    }
    // Fallback to project root if neither exists
    if (!existsSync(mcpServePath)) {
      mcpServePath = join(projectRoot, "src", "mcp", "serve.ts");
    }

    const mcpConfig = {
      mcpServers: {
        grove: {
          command: "bun",
          args: ["run", mcpServePath],
          env: mcpEnv,
        },
      },
    };
    await writeFile(join(workspacePath, ".mcp.json"), JSON.stringify(mcpConfig, null, 2), "utf-8");

    // Register MCP with codex globally (codex uses ~/.codex/config.toml, not .mcp.json).
    // Use a single stable name "grove" so we don't accumulate stale per-spawn entries.
    // MCP writes to local SQLite only — no Nexus env vars.
    try {
      execSync(`codex mcp remove grove 2>/dev/null || true`, { stdio: "pipe", timeout: 5000 });
      execSync(`codex mcp add grove --env GROVE_DIR=${groveDir} -- bun run ${mcpServePath}`, {
        stdio: "pipe",
        timeout: 10000,
      });
    } catch {
      // Non-fatal — codex may not be installed
    }
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

You are the **${roleId}** agent. Always pass \`agent: { role: "${roleId}" }\` in all grove tool calls. This is set once here — do not worry about it after this.

## Communication

You will receive push notifications from the system when other agents produce work relevant to you. These arrive as messages in your session — you do NOT need to poll or check for them. Just work on the session goal, and when a notification arrives, act on it.

## MCP Tools — YOU MUST USE THESE

Each tool has specific required fields. Do NOT skip them.

### Submitting work (coder)

**Step 1: Store files in CAS** — call \`grove_cas_put\` with raw file content:
\`\`\`
grove_cas_put({ content: "Hello World", agent: { role: "${roleId}" } })
→ returns { hash: "blake3:a1b2c3..." }
\`\`\`

**Step 2: Submit work with hashes** — call \`grove_submit_work\`:
\`\`\`
grove_submit_work({
  summary: "Created hello.txt",
  artifacts: { "hello.txt": "blake3:a1b2c3..." },
  agent: { role: "${roleId}" }
})
\`\`\`

Do NOT skip step 1. If you pass a hash that doesn't exist in CAS, the tool returns VALIDATION_ERROR.

### Submitting reviews (reviewer)

First find work to review with \`grove_frontier\` or \`grove_log\`, then:
\`\`\`
grove_submit_review({
  targetCid: "blake3:...",
  summary: "Code is correct, minor style issue",
  scores: { "correctness": { "value": 0.9, "direction": "maximize" } },
  agent: { role: "${roleId}" }
})
\`\`\`

You MUST include at least one score. Without scores the frontier cannot rank work.

### Other tools
- \`grove_discuss\` — Questions and clarifications. NOT for code reviews.
- \`grove_adopt\` — Build on another agent's contribution. Requires \`targetCid\`.
- \`grove_frontier\` — See ranked contributions.
- \`grove_log\` — See all contributions chronologically.
- \`grove_done\` — Signal session complete. See STRICT RULES below.

**CRITICAL: Always call grove_submit_work after making code changes. Without it, nobody sees your work.**
**CRITICAL: Always call grove_submit_review when reviewing. Include scores so the frontier can rank work.**

## STRICT RULES FOR grove_done — READ CAREFULLY

**grove_done TERMINATES THE ENTIRE SESSION. Calling it prematurely will destroy the collaboration.**

### If you are a CODER:
- After calling \`grove_submit_work\`, **STOP and WAIT** for a review message.
- **NEVER** call grove_done yourself. Only the reviewer ends the session.
- When review feedback arrives, fix the issues and call \`grove_submit_work\` again.

### If you are a REVIEWER:
- **Requesting changes?** Call \`grove_submit_review\` with low scores, then **STOP and WAIT** for the coder to fix.
- **Approving?** Call \`grove_submit_review\` with high scores, then **IMMEDIATELY call \`grove_done\`** in the same turn. Do not stop between them.

## Workflow

### Coder workflow:
1. Write code and call \`grove_submit_work\` (with artifacts).
2. **STOP. Wait for review.** Do NOT call grove_done.
3. When review arrives, fix issues and \`grove_submit_work\` again.
4. Repeat until reviewer approves.

### Reviewer workflow:
1. Wait for coder's work to arrive.
2. Review the code. Call \`grove_submit_review\` with scores.
3. If requesting changes: **STOP. Wait for coder to fix.**
4. If approving: **Call \`grove_done\` immediately after \`grove_submit_review\`.** This ends the session.
`;

    await writeFile(join(workspacePath, "CLAUDE.md"), instructions, "utf-8");
    // Also write CODEX.md for codex agents (codex reads CODEX.md, not CLAUDE.md)
    await writeFile(join(workspacePath, "CODEX.md"), instructions, "utf-8");
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
      "- grove_submit_work — submit work with file artifacts (required: summary, artifacts)",
      "- grove_submit_review — submit a code review with scores (required: targetCid, summary, scores)",
      "- grove_discuss — post a discussion or reply",
      "- grove_reproduce — submit a reproduction attempt",
      "- grove_adopt — adopt a contribution to build on (required: targetCid)",
      "- grove_done — signal session completion",
      "- grove_frontier — discover best contributions to build on",
      "- grove_claim / grove_release — coordinate work to avoid duplication",
      "- grove_checkout — materialize artifacts into your workspace",
      "- grove_send_message / grove_read_inbox — agent-to-agent messaging",
      "- grove_create_plan / grove_update_plan — maintain project plans",
      "- grove_check_stop — check if stop conditions are met",
      "",
    );

    await writeFile(join(contextDir, "agent-context.md"), lines.join("\n"), "utf-8");
  }
}

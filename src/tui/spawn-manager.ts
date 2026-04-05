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
import { AgentLogBuffer } from "./data/agent-log-buffer.js";
import { loadTraceHistory, saveTraceHistory } from "./data/trace-persistence.js";
import { debugLog } from "./debug-log.js";
import type { NexusWsBridge } from "./nexus-ws-bridge.js";
import type { TuiDataProvider } from "./provider.js";

// ---------------------------------------------------------------------------
// Module-level global timer tracking
// ---------------------------------------------------------------------------
// SpawnManager may be recreated when appProps change (useMemo in tui-app.tsx).
// A new instance can't clear timers owned by the old instance. Using a module
// global ensures ALL contribution poll timers are cleared regardless of which
// instance started them.
const _allGlobalContribTimers: ReturnType<typeof setInterval>[] = [];
function clearAllGlobalContribTimers(): void {
  for (const t of _allGlobalContribTimers) {
    clearInterval(t);
  }
  _allGlobalContribTimers.length = 0;
}

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
  private readonly logBuffers = new Map<string, AgentLogBuffer>();
  private readonly onError: (message: string) => void;
  private readonly sessionStore: SessionStore | undefined;
  private wsBridge: NexusWsBridge | undefined;
  private prContext: PrContext | undefined;
  private sessionGoal: string | undefined;
  private sessionId: string | undefined;
  private groveDir: string | undefined;
  private logPollTimer: ReturnType<typeof setInterval> | null = null;
  // Track ALL interval handles — prevents "lost handle" leak when startContributionPolling
  // is called multiple times (e.g. when React effect deps change during session startup).
  private allContributionPollTimers: ReturnType<typeof setInterval>[] = [];
  private readonly seenCids = new Set<string>();
  // spawnIds that should receive IPC routing — populated when agents are spawned
  // or explicitly reattached for the CURRENT session. Prevents routing to stale
  // sessions from previous sessions that reconcile() found still alive in acpx.
  private readonly routableSessions = new Set<string>();
  private onContributionDetected:
    | ((c: import("../core/models.js").Contribution) => void)
    | undefined;

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
    _depth: number = 0,
    context?: Record<string, unknown>,
  ): Promise<SpawnResult> {
    debugLog("spawn", `role=${roleId} command=${command}`);
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
      if (this.sessionGoal || context?.roleGoal || context?.rolePrompt) {
        const parts: string[] = [];
        if (this.sessionGoal) parts.push(this.sessionGoal);
        if (context?.roleGoal) parts.push(String(context.roleGoal));
        else if (context?.rolePrompt) parts.push(String(context.rolePrompt));
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
        this.routableSessions.add(spawnId);
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

    // Step 4: Record spawn + register for IPC push + create log buffer.
    // No claims, no heartbeats — agents create claims themselves via grove_claim
    // when they need swarm coordination.
    this.ensureLogBuffer(roleId);
    this.spawnRecords.set(spawnId, {
      claimId: "",
      targetRef: spawnId,
      agentId: spawnId,
    });
    // Store the actual runtime session ID so reconcile() can correctly
    // match stored records to live acpx sessions. Without this, reconcile
    // constructs "grove-{spawnId}" which never matches the acpx name
    // "grove-{role}-{counter}-{ts}", causing fallback on every TUI restart.
    const acpxSessionId = this.agentSessions.get(spawnId)?.id;
    this.sessionStore?.save({
      spawnId,
      claimId: "",
      targetRef: spawnId,
      agentId: spawnId,
      workspacePath,
      spawnedAt: new Date().toISOString(),
      ...(acpxSessionId ? { acpxSessionId } : {}),
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
      // Use the stored acpx session ID when available. Without it, we'd construct
      // "grove-{spawnId}" which never matches the actual acpx name format
      // "grove-{role}-{counter}-{timestamp}" — causing reattached=0 every time.
      const acpxId = (record as { acpxSessionId?: string }).acpxSessionId;
      const lookupId = acpxId ?? `grove-${record.spawnId}`;
      debugLog(
        "reconcile",
        `checking record spawnId=${record.spawnId} lookupId=${lookupId} inLiveSet=${liveSet.has(lookupId)}`,
      );

      if (liveSet.has(lookupId)) {
        // Re-attach: restore in-memory state
        this.spawnRecords.set(record.spawnId, {
          claimId: record.claimId,
          targetRef: record.targetRef,
          agentId: record.agentId,
        });
        // Also restore agent session so sendToAgent/getActiveRoles work
        const liveSession = liveSessionMap.get(lookupId);
        if (liveSession) {
          this.agentSessions.set(record.spawnId, liveSession);
          // Mark as routable — this is a verified session from our store
          this.routableSessions.add(record.spawnId);
        }
        // Ensure log buffer exists for reconciled agents
        const role = record.spawnId.replace(/-[a-z0-9]+$/i, "");
        this.ensureLogBuffer(role);
        reattached++;
        debugLog("reconcile", `reattached spawnId=${record.spawnId} acpxId=${lookupId}`);
      } else {
        // Dead session: clean workspace + remove record
        debugLog("reconcile", `dead session spawnId=${record.spawnId} — cleaning up`);
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
    //
    // This path fires when the session store has no records (first launch ever,
    // store was lost, or all sessions were cleaned up). With acpxSessionId stored,
    // this should be rare in normal operation.
    //
    // IMPORTANT: Only the MOST RECENT session per role is added here, and it is
    // marked routable. This matches the expected "single active session per role"
    // invariant. With 200+ stale sessions, the list is sorted newest-first by
    // acpx so the most recent match is used.
    if (reattached === 0 && this.agentRuntime && this.groveDir) {
      const workspacesPrefix = join(this.groveDir, "workspaces");
      // acpx sessions list includes the cwd — use it to filter
      try {
        const output = execSync("acpx codex sessions list", { encoding: "utf-8", stdio: "pipe" });
        debugLog("reconcile", `fallback: scanning acpx sessions (reattached=0)`);
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
              this.routableSessions.add(role); // mark as routable — first (newest) match per role
              this.spawnRecords.set(role, { claimId: "", targetRef: role, agentId: role });
              reattached++;
              debugLog("reconcile", `fallback reattached role=${role} acpxId=${name}`);
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
    debugLog(
      "route",
      `from=${sourceRole} kind=${kind} summary="${summary.slice(0, 60)}" hasTopology=${!!topology} hasRuntime=${!!this.agentRuntime}`,
    );
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
    debugLog(
      "route",
      `targetRoles=${targetRoles.join(",")} agentSessions=[${[...this.agentSessions.keys()].join(",")}] routableSessions=[${[...this.routableSessions].join(",")}]`,
    );
    for (const targetRole of targetRoles) {
      let foundSpawnId: string | undefined;
      // Find the agent session for this target role
      for (const [spawnId, session] of this.agentSessions) {
        if (spawnId.startsWith(targetRole)) {
          foundSpawnId = spawnId;
          // Sync source workspace files to target workspace before sending IPC.
          // Each agent has its own git worktree — files created by one agent
          // are invisible to others without syncing.
          if (sourceWorkspace && this.groveDir) {
            const targetWorkspace = join(this.groveDir, "workspaces", spawnId);
            debugLog("route", `rsync ${sourceWorkspace} → ${targetWorkspace}`);
            try {
              execSync(
                `rsync -a --exclude='.git' --exclude='.mcp.json' --exclude='CODEX.md' --exclude='CLAUDE.md' --exclude='.grove-role' "${sourceWorkspace}/" "${targetWorkspace}/"`,
                { stdio: "pipe", timeout: 10_000 },
              );
              debugLog("route", `rsync done`);
            } catch (rsyncErr) {
              debugLog(
                "route",
                `rsync failed: ${rsyncErr instanceof Error ? rsyncErr.message : String(rsyncErr)}`,
              );
            }
          }

          const message = `[IPC from ${sourceRole}] New ${kind}: ${summary}. Please review and respond.`;

          // Only route to sessions that are marked routable (spawned or explicitly
          // reattached for the current session). Prevents IPC delivery to stale
          // sessions from previous sessions that reconcile() found still alive.
          const isRoutable = this.routableSessions.has(spawnId);
          debugLog(
            "route",
            `step: spawnId=${spawnId} routable=${isRoutable} sessionId=${session.id} sessionRole=${session.role} sessionStatus=${session.status} wsBridge=${!!this.wsBridge}`,
          );
          if (!isRoutable) {
            debugLog("route", `SKIP: not routable, breaking`);
            break;
          }
          if (this.wsBridge) {
            debugLog("route", `wsBridge path: calling wsBridge.send`);
            // Nexus IPC path: wsBridge.send() stores the message in the agent's inbox,
            // then NexusWsBridge SSE delivers it via runtime.send(). Don't also call
            // runtime.send() here — that would double-deliver.
            void (this.wsBridge as import("./nexus-ws-bridge.js").NexusWsBridge)
              .send(sourceRole, targetRole, { summary, kind })
              .catch(() => {
                /* best-effort */
              });
          } else {
            // Local path (no Nexus): direct runtime.send() is the only delivery mechanism.
            debugLog("route", `local path: calling agentRuntime.send(sessionId=${session.id})`);
            try {
              await this.agentRuntime.send(session, message);
              debugLog("route", `agentRuntime.send completed for sessionId=${session.id}`);
            } catch (sendErr) {
              debugLog(
                "route",
                `agentRuntime.send FAILED: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`,
              );
            }
          }
          break;
        }
      }
      if (!foundSpawnId) {
        debugLog("route", `NO session found for targetRole=${targetRole} — routing skipped`);
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

  // ─── Log buffer management (issue #183) ───

  /** Get all per-agent log buffers (for TracePane). */
  getLogBuffers(): ReadonlyMap<string, AgentLogBuffer> {
    return this.logBuffers;
  }

  /** Set the session ID for log buffer naming and persistence. */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  /**
   * Ensure an AgentLogBuffer exists for a role. Creates one if missing.
   * Called at spawn time and on reconcile.
   */
  ensureLogBuffer(role: string): AgentLogBuffer {
    let buffer = this.logBuffers.get(role);
    if (!buffer) {
      buffer = new AgentLogBuffer(role, this.sessionId ?? "unknown");
      this.logBuffers.set(role, buffer);
    }
    return buffer;
  }

  /**
   * Start polling log files for all active agent roles.
   * Call once after spawn/reconcile. Subsequent calls restart the timer.
   */
  startLogPolling(intervalMs: number = 2000, seekToEnd = false): void {
    this.stopLogPolling();
    if (!this.groveDir) return;
    const logDir = `${this.groveDir}/agent-logs`;

    // On fresh session start, record the current end-of-file byte offset for
    // ALL existing log files for each role. This prevents old data from being
    // shown when a new session starts.
    //
    // WHY per-path, not just newest file:
    //   acpx recycles numbered log files (coder-0.log, coder-1.log) — the new
    //   session might write to ANY of them. recordSeekPosition() stores the
    //   current size of each file; pollLogFile() restores the offset when it
    //   creates a new reader, even if the path differs from the current reader.
    //
    // WHY synchronous statSync (not async seekToEnd):
    //   reconcile() calls startLogPolling() shortly after (same async chain).
    //   If we used async seeks, the positions might not be set yet when the
    //   first pollAll() fires → read from byte 0 → old data included.
    if (seekToEnd) {
      try {
        const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
        const files = readdirSync(logDir).filter((f: string) => f.endsWith(".log"));
        for (const [role, buffer] of this.logBuffers) {
          const roleFiles = files.filter(
            (f: string) => f === `${role}.log` || f.startsWith(`${role}-`),
          );
          let seekCount = 0;
          for (const roleFile of roleFiles) {
            try {
              const fileSize = statSync(`${logDir}/${roleFile}`).size;
              buffer.recordSeekPosition(`${logDir}/${roleFile}`, fileSize);
              seekCount++;
            } catch {
              // File unreadable — skip
            }
          }
          buffer.clearForNewSession();
          debugLog(
            "seekToEnd",
            `role=${role} seeked ${seekCount} file(s): [${roleFiles.join(",")}]`,
          );
        }
      } catch (e) {
        debugLog("seekToEnd", `error: ${String(e)}`);
      }
    }

    let pollCount = 0;
    const pollAll = () => {
      // Scan log directory for files matching each role (e.g., coder-0.log, coder-1.log)
      try {
        const { readdirSync } = require("node:fs") as typeof import("node:fs");
        const files = readdirSync(logDir).filter((f: string) => f.endsWith(".log"));
        if (pollCount < 3 || pollCount % 10 === 0) {
          debugLog(
            "poll",
            `#${pollCount} logDir=${logDir} files=[${files.join(",")}] buffers=[${[...this.logBuffers.keys()].join(",")}]`,
          );
        }
        for (const [role, buffer] of this.logBuffers) {
          // Find the most recently modified log file for this role
          const { statSync } = require("node:fs") as typeof import("node:fs");
          const roleFile = files
            .filter((f: string) => f === `${role}.log` || f.startsWith(`${role}-`))
            .sort((a: string, b: string) => {
              try {
                return statSync(`${logDir}/${b}`).mtimeMs - statSync(`${logDir}/${a}`).mtimeMs;
              } catch {
                return 0;
              }
            })[0];
          if (roleFile) {
            void buffer
              .pollLogFile(`${logDir}/${roleFile}`)
              .then(() => {
                if (buffer.size > 0 && (pollCount < 5 || pollCount % 10 === 0)) {
                  debugLog("poll", `role=${role} file=${roleFile} bufferSize=${buffer.size}`);
                }
              })
              .catch(() => {
                /* non-fatal */
              });
          }
        }
        pollCount++;
      } catch (err) {
        debugLog("poll", `error: ${String(err)}`);
      }
    };

    this.logPollTimer = setInterval(pollAll, intervalMs);
    if (!seekToEnd) {
      pollAll(); // Also poll immediately (skip initial sync poll when seekToEnd — async seek must complete first)
    }
  }

  /** Stop the log polling timer. */
  stopLogPolling(): void {
    if (this.logPollTimer !== null) {
      clearInterval(this.logPollTimer);
      this.logPollTimer = null;
    }
    // Kill ALL contribution poll timers globally (covers timers from previous instances too)
    clearAllGlobalContribTimers();
    this.allContributionPollTimers = [];
    this.contributionPollTimer = null;
    // NOTE: do NOT clear routableSessions here — spawn() populates it before polling starts.
  }

  /**
   * Start polling contributions outside React (React timers die on unmount).
   * Detects new CIDs and routes them via routeContribution.
   */
  startContributionPolling(
    provider: TuiDataProvider,
    topology: import("../core/topology.js").AgentTopology | undefined,
    sessionStartedAt: string | undefined,
    intervalMs: number = 3000,
    /** When true, skip routeContribution — a server-side SessionOrchestrator is handling routing. */
    serverRoutingActive: boolean = false,
  ): void {
    // Kill ALL timers across ALL SpawnManager instances (module-level global).
    // SpawnManager may be recreated when appProps change; the new instance can't
    // see the old instance's timer handles without a shared reference.
    const prevCount = _allGlobalContribTimers.length;
    clearAllGlobalContribTimers();
    this.allContributionPollTimers = [];
    this.contributionPollTimer = null;
    debugLog(
      "contribPoll",
      `startContributionPolling called, cleared ${prevCount} global timer(s), seenCids=${this.seenCids.size}`,
    );

    let pollCount = 0;
    const timer = setInterval(async () => {
      try {
        const contributions = await provider.getContributions({ limit: 500 });
        const feed = sessionStartedAt
          ? (contributions ?? []).filter((c) => c.createdAt >= sessionStartedAt)
          : (contributions ?? []);

        if (pollCount < 3 || pollCount % 20 === 0) {
          debugLog(
            "contribPoll",
            `#${pollCount} fetched=${feed.length} seen=${this.seenCids.size}`,
          );
        }

        // First poll: seed all existing CIDs to avoid re-routing old contributions on resume
        if (pollCount === 0) {
          for (const c of feed) {
            this.seenCids.add(c.cid);
          }
          debugLog("contribPoll", `seeded ${feed.length} existing CIDs`);
        } else {
          // Subsequent polls: detect new contributions and route them
          for (const c of feed) {
            if (!this.seenCids.has(c.cid)) {
              this.seenCids.add(c.cid);
              debugLog(
                "contribPoll",
                `NEW cid=${c.cid.slice(0, 20)} kind=${c.kind} role=${c.agent?.role}`,
              );
              // Route to downstream agents — skip when server-side SessionOrchestrator
              // is already routing via event bus (prevents double IPC delivery).
              if (c.agent?.role && topology && !serverRoutingActive) {
                void this.routeContribution(c.agent.role, c.summary, c.kind, topology);
              }
              // Mark upstream handoffs as delivered — the contribution reached the routing layer
              if ((provider as { getHandoffs?: unknown }).getHandoffs) {
                const hp = provider as unknown as import("./provider.js").TuiHandoffProvider;
                void hp
                  .getHandoffs({ sourceCid: c.cid, status: "pending_pickup" })
                  .then((hs) => {
                    for (const h of hs) {
                      void hp.markHandoffDelivered(h.handoffId).catch(() => {
                        /* best-effort */
                      });
                    }
                  })
                  .catch(() => {
                    /* best-effort */
                  });
              }
              // Notify callback (for TUI feed update)
              this.onContributionDetected?.(c);
            }
          }
        }
        pollCount++;
      } catch (err) {
        debugLog("contribPoll", `error: ${String(err)}`);
      }
    }, intervalMs);
    this.contributionPollTimer = timer;
    this.allContributionPollTimers.push(timer);
    _allGlobalContribTimers.push(timer);
  }

  /** Set a callback for when new contributions are detected (for TUI feed notification). */
  setOnContributionDetected(
    cb: ((c: import("../core/models.js").Contribution) => void) | undefined,
  ): void {
    this.onContributionDetected = cb;
  }

  /**
   * Save all trace buffers to JSONL. Called on session end.
   * Returns immediately if no groveDir or sessionId.
   */
  async saveTraces(): Promise<void> {
    debugLog(
      "save",
      `groveDir=${this.groveDir} sessionId=${this.sessionId} bufferCount=${this.logBuffers.size} sizes=[${[...this.logBuffers.entries()].map(([r, b]) => `${r}:${b.size}`).join(",")}]`,
    );
    if (!this.groveDir || !this.sessionId) return;
    await saveTraceHistory(this.groveDir, this.sessionId, this.logBuffers);
    debugLog("save", "done");
  }

  /**
   * Load trace history from JSONL into buffers. Called on resume.
   * Creates buffers for each role found in the session directory.
   */
  async loadTraces(sessionIdToLoad: string): Promise<void> {
    if (!this.groveDir) return;
    const loaded = await loadTraceHistory(this.groveDir, sessionIdToLoad);
    for (const [role, buffer] of loaded) {
      this.logBuffers.set(role, buffer);
    }
  }

  /**
   * Close bridge and clear state.
   *
   * Closes all active agent sessions so they don't accumulate in acpx
   * across TUI restarts. Without this, each test run leaves sessions that
   * interfere with reconcile fallback and make `acpx sessions list` noisy.
   */
  destroy(): void {
    this.stopLogPolling();
    this.routableSessions.clear();
    // Close all agent sessions via runtime to prevent accumulation
    if (this.agentRuntime) {
      for (const session of this.agentSessions.values()) {
        void this.agentRuntime.close(session).catch(() => {
          /* best-effort — session may already be gone */
        });
      }
    }
    for (const buffer of this.logBuffers.values()) {
      buffer.dispose();
    }
    this.logBuffers.clear();
    this.spawnRecords.clear();
    this.agentSessions.clear();
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
    // MCP server needs GROVE_NEXUS_URL so contributions are written to Nexus
    // (enables IPC push via NexusEventBus + TopologyRouter for agent routing).
    // Without it, contributions only go to local SQLite and reviewer never gets notified.
    const mcpEnv: Record<string, string> = {
      GROVE_DIR: groveDir,
    };
    if (process.env.GROVE_NEXUS_URL) {
      mcpEnv.GROVE_NEXUS_URL = process.env.GROVE_NEXUS_URL;
    }
    if (process.env.NEXUS_API_KEY) {
      mcpEnv.NEXUS_API_KEY = process.env.NEXUS_API_KEY;
    }

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
    const roleGoal = context?.roleGoal ?? "";
    const sessionGoal = this.sessionGoal || "Follow your role instructions below.";

    const instructions = `# Grove Agent: ${roleId}

## Session Goal
${sessionGoal}

## Your Role: ${roleId}
${roleDescription}
${roleGoal ? `\nObjective: ${roleGoal}\n` : ""}
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
    if (context.roleGoal) {
      lines.push(`## Objective`, "", String(context.roleGoal), "");
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

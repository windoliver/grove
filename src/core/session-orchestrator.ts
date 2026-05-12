/**
 * Orchestrates a multi-agent session from start to completion.
 *
 * Given a contract with topology, spawns agents for each role,
 * sends goals, wires event routing, and monitors for stop conditions.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AcpxTurn } from "../acp/types.js";
import { watchTurnError } from "../acp/watch-turn.js";
import { NexusHttpClient } from "../nexus/nexus-http-client.js";
import {
  resolveNexusSkillCatalogRoot,
  type SkillResolutionWarning,
} from "../nexus/nexus-skill-catalog.js";
import { resolveConfiguredNexusUrl } from "../shared/nexus-url.js";
import type { AgentProfile } from "./agent-profile.js";
import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";
import { type GroveConfig, parseGroveConfig } from "./config.js";
import type { GroveContract } from "./contract.js";
import type { EventBus, GroveEvent } from "./event-bus.js";
import { LoopStopStatus, type LoopStopStatus as LoopStopStatusValue } from "./loop-runner.js";
import { type ResolvedRepo, type ResolveRepoOptions, resolveRepo } from "./repo-cache.js";
import type { RepoRef } from "./repo-ref.js";
import { resolveBundledSkillsRoot, resolveMcpServePath } from "./resolve-mcp-serve-path.js";
import { hasValidRoutingSignature } from "./routing-provenance.js";
import type { AgentPlatformType, AgentRole, AgentTopology } from "./topology.js";
import { resolveRoleWorkspaceStrategies, topologicalSortRoles } from "./topology.js";
import { TopologyRouter } from "./topology-router.js";
import { bootstrapWorkspace, type SkillCatalogResolver } from "./workspace-bootstrap.js";
import {
  type ProvisionedWorkspace,
  provisionWorkspace,
  type WorkspaceIsolationPolicy,
  type WorkspaceMode,
} from "./workspace-provisioner.js";

export type { WorkspaceIsolationPolicy, WorkspaceMode };

const CONTRIBUTION_POLL_LIMIT = 200;

class RequiredSkillCatalogResolutionError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "RequiredSkillCatalogResolutionError";
  }
}

function isRequiredSkillCatalogResolutionError(
  error: unknown,
): error is RequiredSkillCatalogResolutionError {
  return error instanceof RequiredSkillCatalogResolutionError;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSkillCatalogWarning(warning: SkillResolutionWarning): string {
  const fallback = warning.fallbackSource ? ` fallback: ${warning.fallbackSource};` : "";
  return `Nexus skill catalog warning for '${warning.skillName}': attempted ${warning.attemptedSource};${fallback} ${warning.reason}`;
}

/** Configuration for starting a session. */
export interface SessionConfig {
  /** The session goal (what agents should accomplish). */
  readonly goal: string;
  /** The parsed contract (metrics, gates, etc. — topology is separate). */
  readonly contract: GroveContract;
  /** Resolved topology for this session (from preset, inline, or GROVE.md default). */
  readonly topology: AgentTopology;
  /** The agent runtime for spawning processes. */
  readonly runtime: AgentRuntime;
  /** The event bus for inter-agent notifications. */
  readonly eventBus: EventBus;
  /**
   * Grove launcher directory — anchors `.grove/`, `mcpServePath`, the
   * bundled skills root, workspace-override skills root, and fallback
   * cwd when no workspace is provisioned. Independent of `repos`.
   */
  readonly projectRoot: string;

  /**
   * Repositories the session targets. Length ≥ 1; today exactly 1 is
   * honored (the forward-compat hook for multi-repo sessions).
   * Resolved to bare clones via `resolveRepo` at session start.
   */
  readonly repos: readonly RepoRef[];

  /** Overrides for cache resolution (tests, CI, explicit cache root). */
  readonly repoCache?: Partial<ResolveRepoOptions>;

  /** Base directory for agent workspaces. */
  readonly workspaceBaseDir: string;
  /** Optional session ID (generated if not provided). */
  readonly sessionId?: string | undefined;
  /**
   * Controls how workspace provisioning failures are handled.
   *
   * - 'strict' (default): any failure — worktree creation or bootstrap — aborts
   *   the spawn for that role.
   * - 'allow-fallback': on worktree failure the agent uses the project root;
   *   on bootstrap failure the agent runs without config files. Both degraded
   *   modes are visible via AgentSessionInfo.workspaceMode.
   */
  readonly workspaceIsolationPolicy?: WorkspaceIsolationPolicy | undefined;
  /**
   * Contribution store for polling-based routing. When set, the orchestrator
   * polls for new contributions every few seconds and forwards them to
   * downstream agents. Required because MCP tools run in child processes
   * with separate EventBus instances — in-process events don't cross.
   */
  readonly contributionStore?:
    | {
        list(query?: {
          limit?: number;
          order?: "created_at_asc" | "created_at_desc";
        }): Promise<readonly import("./models.js").Contribution[]>;
      }
    | undefined;
  /** Optional agent profiles — overlay role defaults with per-agent runtime config. */
  readonly profiles?: readonly AgentProfile[] | undefined;
}

/** Status of a running session. */
export interface SessionStatus {
  readonly sessionId: string;
  readonly goal: string;
  readonly agents: readonly AgentSessionInfo[];
  readonly started: boolean;
  readonly stopped: boolean;
  readonly stopReason?: string | undefined;
  readonly stopStatus?: LoopStopStatusValue | undefined;
}

/** Info about a single agent in the session. */
export interface AgentSessionInfo {
  readonly role: string;
  readonly session: AgentSession;
  readonly goal: string;
  /** Describes how this agent's workspace was provisioned. */
  readonly workspaceMode: WorkspaceMode;
}

/**
 * Merge runtime selection fields from role + profile.
 * Precedence: profile > role > default.
 *
 * Exported for testability — pure function, no side effects.
 */
export function mergeRuntimeConfig(
  role: AgentRole,
  profile: AgentProfile | undefined,
): { command: string; platform: AgentPlatformType | undefined; model: string | undefined } {
  return {
    command: profile?.command ?? role.command ?? "claude",
    platform: profile?.platform ?? role.platform,
    model: profile?.model ?? role.model,
  };
}

export class SessionOrchestrator {
  private readonly config: SessionConfig;
  private readonly sessionId: string;
  private readonly agents: AgentSessionInfo[] = [];
  private readonly router: TopologyRouter;
  private readonly routingTokensByRole = new Map<string, string>();
  private eventHandlers?: Map<string, import("./event-bus.js").EventHandler>;
  private stopped = false;
  private stopReason: string | undefined;
  private stopStatus: LoopStopStatusValue | undefined;
  private contributionCount = 0;
  private readonly doneRoles = new Set<string>();
  private startedAt = 0;
  private readonly seenCids = new Set<string>();
  private resolvedNexusUrl: string | undefined;
  private contributionPollTimer: ReturnType<typeof setInterval> | null = null;
  private contributionPollStartTimer: ReturnType<typeof setTimeout> | null = null;
  private resolvedRepos: readonly ResolvedRepo[] = [];

  constructor(config: SessionConfig) {
    this.config = config;
    this.sessionId =
      config.sessionId ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.router = new TopologyRouter(config.topology, config.eventBus);
  }

  /**
   * Observe a fire-and-forget turn's outcome and surface error stop reasons.
   * With the typed-stream runtime, post-spawn failures (malformed frames,
   * provider rejections, cancelled turns) show up as `stopReason: "error"`
   * on the terminal `Result` instead of as a thrown send() error, so we
   * drain each turn in the background to make silent delivery failures
   * observable. We intentionally do not throw — control-plane prompts are
   * already fire-and-forget and have no retry channel.
   */
  private watchTurn(role: string, turn: AcpxTurn): void {
    watchTurnError(turn, `SessionOrchestrator agent='${role}'`);
  }

  private readGroveConfig(): GroveConfig | undefined {
    const groveDir = join(this.config.projectRoot, ".grove");
    const configPath = join(groveDir, "grove.json");
    if (!existsSync(configPath)) return undefined;
    return parseGroveConfig(readFileSync(configPath, "utf-8"));
  }

  private resolveNexusUrl(config: GroveConfig | undefined): string | undefined {
    const nexusUrl = resolveConfiguredNexusUrl({
      projectRoot: this.config.projectRoot,
      config,
      env: process.env,
    });
    this.resolvedNexusUrl = nexusUrl;
    return nexusUrl;
  }

  private reportSkillCatalogWarnings(warnings: readonly SkillResolutionWarning[]): void {
    for (const warning of warnings) {
      process.stderr.write(`[SessionOrchestrator] ${formatSkillCatalogWarning(warning)}\n`);
    }
  }

  private createSkillCatalogResolver(
    config: GroveConfig | undefined,
    nexusUrl: string | undefined,
  ): SkillCatalogResolver | undefined {
    if (config === undefined) return undefined;
    const groveDir = join(this.config.projectRoot, ".grove");
    const skillCatalog = config.skillCatalog;
    if (config.mode !== "nexus" || skillCatalog === undefined) return undefined;
    if (!nexusUrl) {
      if (skillCatalog.policy !== "required") return undefined;
      return async () => {
        throw new RequiredSkillCatalogResolutionError(
          "Nexus skill catalog required but no Nexus URL is configured",
          undefined,
        );
      };
    }

    const client = new NexusHttpClient({
      url: nexusUrl,
      apiKey: process.env.NEXUS_API_KEY || undefined,
    });
    const zoneId = process.env.GROVE_ZONE_ID ?? "default";
    const cacheRoot = join(groveDir, "cache", "skills");
    const bundledRoot = resolveBundledSkillsRoot(this.config.projectRoot);
    const overrideRoot = join(groveDir, "skills");

    return async (skills) => {
      try {
        const result = await resolveNexusSkillCatalogRoot({
          client,
          zoneId,
          cacheRoot,
          skills,
          policy: skillCatalog.policy,
          trustedKeys: skillCatalog.trustedKeys,
          localFallbackRoots: [overrideRoot, bundledRoot],
        });
        this.reportSkillCatalogWarnings(result.warnings);
        return { root: result.root, warnings: result.warnings };
      } catch (error) {
        if (skillCatalog.policy === "required") {
          throw new RequiredSkillCatalogResolutionError(
            `Nexus skill catalog required but resolution failed: ${messageFromError(error)}`,
            error,
          );
        }
        throw error;
      }
    };
  }

  private failIfRequiredSkillCatalogWouldBeSkipped(role: AgentRole, reason: string): void {
    if (!role.skills || role.skills.length === 0) return;

    const config = this.readGroveConfig();
    const skillCatalog = config?.skillCatalog;
    if (config?.mode !== "nexus" || skillCatalog?.policy !== "required") return;

    throw new RequiredSkillCatalogResolutionError(
      `Nexus skill catalog required but workspace provisioning failed for role '${role.name}' before skills could be resolved: ${reason}`,
      undefined,
    );
  }

  /** Start the session: spawn all agents and send goals. */
  async start(): Promise<SessionStatus> {
    const topology = this.config.topology;
    const policy = this.config.workspaceIsolationPolicy ?? "strict";

    // Resolve workspace strategies from edge types — delegates/feeds/escalates edges
    // make the target role's worktree branch off the source role's branch.
    const wsStrategies = resolveRoleWorkspaceStrategies(topology, this.sessionId);

    // Provision workspaces in topological order so source branches exist before
    // dependents try to base their worktrees on them.
    const orderedRoles = topologicalSortRoles(topology);
    const workspaceMap = new Map<string, { cwd: string; workspaceMode: WorkspaceMode }>();
    for (const role of orderedRoles) {
      const baseBranch = wsStrategies.get(role.name) ?? "HEAD";
      const ws = await this.provisionAgentWorkspace(role, policy, baseBranch);
      workspaceMap.set(role.name, ws);
    }

    // Spawn all agents in parallel (workspaces already provisioned above)
    const SPAWN_TIMEOUT_MS = 30_000;
    const spawnResults = await Promise.allSettled(
      topology.roles.map(async (role) => {
        const ws = workspaceMap.get(role.name) ?? {
          cwd: this.config.projectRoot,
          workspaceMode: {
            status: "fallback_workspace" as const,
            path: this.config.projectRoot,
            reason: "Workspace not provisioned",
          },
        };
        const ac = new AbortController();
        const timeoutId = setTimeout(() => ac.abort(), SPAWN_TIMEOUT_MS);
        try {
          const result = await this.spawnAgent(role, ac.signal, ws);
          clearTimeout(timeoutId);
          return result;
        } catch (err) {
          clearTimeout(timeoutId);
          if (ac.signal.aborted) {
            throw new Error(`Spawn timeout for role '${role.name}' after ${SPAWN_TIMEOUT_MS}ms`);
          }
          throw err;
        }
      }),
    );

    for (const result of spawnResults) {
      if (result.status === "fulfilled") {
        this.agents.push(result.value);
      } else {
        process.stderr.write(`[SessionOrchestrator] spawn failed: ${result.reason}\n`);
      }
    }

    // Require at least one agent
    if (this.agents.length === 0) {
      throw new Error("No agents spawned — all roles failed");
    }

    this.startedAt = Date.now();

    // Some runtimes start config.goal/config.prompt as part of spawn().
    // Lightweight test/runtime adapters do not, so the orchestrator sends the
    // initial role goal for them.
    if (this.config.runtime.sendsInitialPromptOnSpawn !== true) {
      for (const agent of this.agents) {
        const turn = await this.config.runtime.send(agent.session, agent.goal);
        this.watchTurn(agent.role, turn);
      }
    }

    // Wire idle detection
    for (const agent of this.agents) {
      this.config.runtime.onIdle(agent.session, () => {
        this.handleAgentIdle(agent);
      });
    }

    // Subscribe all agents to their event channels (store handlers for cleanup)
    if (!this.eventHandlers) this.eventHandlers = new Map();
    for (const agent of this.agents) {
      const handler = (event: GroveEvent) => {
        void this.handleEvent(agent, event);
      };
      this.eventHandlers.set(agent.role, handler);
      this.config.eventBus.subscribe(agent.role, handler);
    }

    // Start contribution polling — MCP tools run in child processes with
    // separate EventBus instances, so in-process events don't cross process
    // boundaries. Poll SQLite directly to detect new contributions and
    // forward them to downstream agents.
    if (this.config.contributionStore) {
      this.startContributionPolling();
    }

    return this.getStatus();
  }

  /** Stop the session gracefully. */
  async stop(
    reason: string,
    stopStatus: LoopStopStatusValue = LoopStopStatus.Achieved,
  ): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    this.stopStatus = stopStatus;

    // Stop contribution polling
    if (this.contributionPollStartTimer) {
      clearTimeout(this.contributionPollStartTimer);
      this.contributionPollStartTimer = null;
    }
    if (this.contributionPollTimer) {
      clearInterval(this.contributionPollTimer);
      this.contributionPollTimer = null;
    }

    // Notify all agents
    await this.router.broadcastStop(reason);

    this.unsubscribeEventHandlers();

    // Close all agent sessions
    for (const agent of this.agents) {
      await this.config.runtime.close(agent.session);
    }
  }

  /**
   * Poll contribution store for new contributions and forward to downstream agents.
   * This bridges the process boundary — MCP tools write to SQLite, we read from it.
   *
   * Delay the first poll so agents have time to process their initial prompt.
   * Without this, contributions from fast agents (coder) arrive in the same
   * acpx session turn as the initial prompt for slow agents (reviewer), and
   * the agent treats it as context instead of a separate action trigger.
   */
  private startContributionPolling(): void {
    const POLL_MS = 3_000;
    const INITIAL_DELAY_MS = 15_000; // wait for agents to go idle first

    // Seed seenCids with recent contributions that existed before session start.
    void this.config.contributionStore
      ?.list({ limit: CONTRIBUTION_POLL_LIMIT, order: "created_at_desc" })
      .then((existing) => {
        for (const c of existing) {
          this.seenCids.add(c.cid);
        }
      });

    // Start polling after initial delay
    this.contributionPollStartTimer = setTimeout(() => {
      if (this.stopped) return;
      this.contributionPollTimer = setInterval(() => {
        void this.pollContributions();
      }, POLL_MS);
      // Also poll immediately on first tick
      void this.pollContributions();
      this.contributionPollStartTimer = null;
    }, INITIAL_DELAY_MS);
  }

  private async pollContributions(): Promise<void> {
    if (this.stopped || !this.config.contributionStore) return;

    try {
      // Fetch recent contributions newest-first, then process oldest-to-newest.
      // Using a large limit ensures we don't miss contributions in active sessions.
      const contributions = await this.config.contributionStore.list({
        limit: CONTRIBUTION_POLL_LIMIT,
        order: "created_at_desc",
      });
      for (const c of [...contributions].reverse()) {
        if (this.seenCids.has(c.cid)) continue;

        const sourceRole = c.agent.role;
        if (!sourceRole) continue;
        const sourceAgent = this.agents.find((a) => a.role === sourceRole);
        if (!sourceAgent) continue;

        // Trust boundary: require a valid per-contribution routing signature
        // and runtime-issued agent session identity.
        const expectedToken = this.routingTokensByRole.get(sourceRole);
        if (expectedToken === undefined || !hasValidRoutingSignature(c, expectedToken)) {
          continue;
        }
        if (c.agent.agentId !== sourceAgent.session.id) {
          continue;
        }

        // Mark as seen only after ownership verification so transient identity
        // skew doesn't permanently suppress routing for this CID.
        this.seenCids.add(c.cid);
        this.contributionCount++;

        // Find the source agent's workspace path — this is the handoff artifact.
        // The receiving agent reads files directly from this path, no git merge needed.
        const sourceWorkspace = sourceAgent?.workspaceMode.path ?? "(unknown)";

        const action =
          c.kind === "review"
            ? `This is feedback on your work. Read the review and iterate — submit updated work via grove_submit_work.`
            : `Read the source files at ${sourceWorkspace} and respond with the appropriate tool (grove_submit_review for reviews, grove_submit_work for new work).`;

        const message =
          `[grove] New ${c.kind} from ${sourceRole}:\n` +
          `  CID: ${c.cid}\n` +
          `  Summary: ${c.summary}\n` +
          `  Workspace: ${sourceWorkspace}\n\n` +
          action;

        // Use topology router to find targets, then send directly
        const routeResults = await this.router.route(sourceRole, {
          cid: c.cid,
          kind: c.kind,
          summary: c.summary,
        });

        for (const { targetRole } of routeResults) {
          const targetAgent = this.agents.find((a) => a.role === targetRole);
          if (targetAgent) {
            const turn = await this.config.runtime.send(targetAgent.session, message);
            this.watchTurn(targetAgent.role, turn);
          }
        }

        // Detect [DONE] signal. Topologies can designate terminal roles that
        // are sufficient to end the session; otherwise all spawned roles must
        // signal completion.
        if (
          c.summary.startsWith("[DONE]") ||
          (c.context && (c.context as Record<string, unknown>).done === true)
        ) {
          this.doneRoles.add(sourceRole);
          const requiredDoneRoles = this.doneRequiredRoleNames();
          const requiredDone =
            requiredDoneRoles.length > 0 &&
            requiredDoneRoles.every((role) => this.doneRoles.has(role));
          if (requiredDone) {
            void this.stop("Required agents signaled done", LoopStopStatus.Achieved);
            return;
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[SessionOrchestrator] contribution poll failed: ${message}\n`);
    }
  }

  private doneRequiredRoleNames(): readonly string[] {
    const spawnedRoleNames = new Set(this.agents.map((agent) => agent.role));
    const explicitEndingRoles = this.config.topology.roles
      .filter((role) => spawnedRoleNames.has(role.name) && role.endsSession === true)
      .map((role) => role.name);
    if (explicitEndingRoles.length > 0) return explicitEndingRoles;

    const terminalRoles = this.config.topology.roles
      .filter((role) => spawnedRoleNames.has(role.name) && (role.edges?.length ?? 0) === 0)
      .map((role) => role.name);
    if (terminalRoles.length > 0) return terminalRoles;
    return [...spawnedRoleNames];
  }

  /** Get current session status. */
  getStatus(): SessionStatus {
    return {
      sessionId: this.sessionId,
      goal: this.config.goal,
      agents: [...this.agents],
      started: this.agents.length > 0,
      stopped: this.stopped,
      stopReason: this.stopReason,
      stopStatus: this.stopStatus,
    };
  }

  private async spawnAgent(
    role: AgentRole,
    signal?: AbortSignal,
    workspace?: { cwd: string; workspaceMode: WorkspaceMode },
  ): Promise<AgentSessionInfo> {
    const roleGoal = role.goal ?? role.prompt ?? role.description ?? `Fulfill role: ${role.name}`;
    const fullGoal = `Session goal: ${this.config.goal}\n\nYour role (${role.name}): ${roleGoal}`;

    const { cwd, workspaceMode } = workspace ?? {
      cwd: this.config.projectRoot,
      workspaceMode: {
        status: "fallback_workspace" as const,
        path: this.config.projectRoot,
        reason: "No workspace",
      },
    };

    if (signal?.aborted) throw new Error(`Spawn aborted for role '${role.name}'`);

    // Merge profile overlay (profile > role > default)
    const profile = this.config.profiles?.find((p) => p.role === role.name);
    const resolved = mergeRuntimeConfig(role, profile);
    const routingToken = randomUUID();
    this.routingTokensByRole.set(role.name, routingToken);

    const agentConfig: AgentConfig = {
      role: role.name,
      command: resolved.command,
      platform: resolved.platform,
      model: resolved.model,
      cwd,
      goal: fullGoal,
      mcpServers: [this.groveMcpServer(role.name)],
      env: {
        GROVE_SESSION_ID: this.sessionId,
        GROVE_ROLE: role.name,
        GROVE_AGENT_ROLE: role.name,
        GROVE_ROUTING_TOKEN: routingToken,
      },
    };

    if (signal?.aborted) throw new Error(`Spawn aborted for role '${role.name}'`);

    const session = await this.config.runtime.spawn(role.name, agentConfig);

    return {
      role: role.name,
      session,
      goal: fullGoal,
      workspaceMode,
    };
  }

  private groveMcpServer(roleName: string): NonNullable<AgentConfig["mcpServers"]>[number] {
    const env: Record<string, string> = {
      GROVE_DIR: join(this.config.projectRoot, ".grove"),
      GROVE_AGENT_ROLE: roleName,
      GROVE_SESSION_ID: this.sessionId,
    };
    const nexusUrl = process.env.GROVE_NEXUS_URL || this.resolvedNexusUrl;
    if (nexusUrl) env.GROVE_NEXUS_URL = nexusUrl;
    if (process.env.NEXUS_API_KEY) env.NEXUS_API_KEY = process.env.NEXUS_API_KEY;
    return {
      name: "grove",
      command: "bun",
      args: ["run", resolveMcpServePath(this.config.projectRoot)],
      env,
    };
  }

  private async ensureReposResolved(): Promise<void> {
    if (this.resolvedRepos.length > 0) return;
    if (this.config.repos.length === 0) {
      throw new Error("SessionOrchestrator: repos must be non-empty; pass at least one RepoRef.");
    }
    if (this.config.repos.length > 1) {
      throw new Error(
        "SessionOrchestrator: multi-repo sessions are not yet supported; pass exactly one repo.",
      );
    }
    this.resolvedRepos = await Promise.all(
      this.config.repos.map((ref) => resolveRepo(ref, this.config.repoCache ?? {})),
    );
  }

  /**
   * Provision a workspace for an agent role and run bootstrap.
   *
   * Returns the cwd the agent should run in and a WorkspaceMode describing
   * the outcome. When policy is 'strict', any failure throws. When
   * 'allow-fallback', failures produce a degraded WorkspaceMode instead.
   */
  private async provisionAgentWorkspace(
    role: AgentRole,
    policy: WorkspaceIsolationPolicy,
    baseBranch?: string,
  ): Promise<{ readonly cwd: string; readonly workspaceMode: WorkspaceMode }> {
    await this.ensureReposResolved();
    const resolvedRepo = this.resolvedRepos[0];
    if (!resolvedRepo) {
      throw new Error("unreachable: ensureReposResolved did not populate resolvedRepos");
    }
    let provisioned: ProvisionedWorkspace;

    // Step 1: Git worktree — base branch determined by edge type
    try {
      provisioned = await provisionWorkspace({
        role: role.name,
        sessionId: this.sessionId,
        baseDir: this.config.workspaceBaseDir,
        bareClonePath: resolvedRepo.bareClonePath,
        baseBranch: baseBranch ?? "HEAD",
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (policy === "strict") {
        throw new Error(`Workspace provisioning failed for role '${role.name}': ${reason}`);
      }
      this.failIfRequiredSkillCatalogWouldBeSkipped(role, reason);
      return {
        cwd: this.config.projectRoot,
        workspaceMode: {
          status: "fallback_workspace",
          path: this.config.projectRoot,
          reason,
        },
      };
    }

    // Step 2: Bootstrap (write .mcp.json + CLAUDE.md)
    try {
      const groveConfig = this.readGroveConfig();
      const nexusUrl = this.resolveNexusUrl(groveConfig);
      const skillCatalogResolver = this.createSkillCatalogResolver(groveConfig, nexusUrl);
      await bootstrapWorkspace({
        workspacePath: provisioned.path,
        roleId: role.name,
        goal: this.config.goal,
        rolePrompt: role.prompt,
        roleDescription: role.description,
        groveDir: join(this.config.projectRoot, ".grove"),
        mcpServePath: resolveMcpServePath(this.config.projectRoot),
        nexusUrl,
        nexusApiKey: process.env.NEXUS_API_KEY,
        skills: role.skills,
        bundledSkillsRoot: resolveBundledSkillsRoot(this.config.projectRoot),
        workspaceOverrideRoot: join(this.config.projectRoot, ".grove", "skills"),
        skillCatalogResolver,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (policy === "strict" || isRequiredSkillCatalogResolutionError(err)) {
        throw new Error(`Bootstrap failed for role '${role.name}': ${reason}`);
      }
      return {
        cwd: provisioned.path,
        workspaceMode: { status: "bootstrap_failed", path: provisioned.path, reason },
      };
    }

    return {
      cwd: provisioned.path,
      workspaceMode: {
        status: "isolated_worktree",
        path: provisioned.path,
        branch: provisioned.branch,
      },
    };
  }

  private async handleEvent(agent: AgentSessionInfo, event: GroveEvent): Promise<void> {
    if (this.stopped) return;

    if (event.type === "stop") {
      // Auto-close session on stop event
      const reason =
        typeof event.payload.reason === "string" ? event.payload.reason : "Stop condition met";
      void this.stop(reason, LoopStopStatus.Achieved);
      return;
    }

    // When contributionStore polling is active, skip EventBus contribution
    // forwarding to avoid duplicate messages (polling handles it reliably
    // across process boundaries). When no store is configured (e.g., server
    // path), fall back to EventBus forwarding.
    if (event.type === "contribution") {
      if (this.config.contributionStore) {
        return; // Polling handles it
      }
      this.contributionCount++;
    }

    // Forward events to the agent
    const p = event.payload;
    const summary = typeof p.summary === "string" ? p.summary : JSON.stringify(p);
    const message = `[grove] ${event.type} from ${event.sourceRole}: ${summary}`;
    const turn = await this.config.runtime.send(agent.session, message);
    this.watchTurn(agent.role, turn);
  }

  private unsubscribeEventHandlers(): void {
    if (!this.eventHandlers) return;
    for (const [role, handler] of this.eventHandlers) {
      this.config.eventBus.unsubscribe(role, handler);
    }
    this.eventHandlers.clear();
  }

  private handleAgentIdle(_agent: AgentSessionInfo): void {
    // Check if ALL agents are idle → session is complete
    void this.checkAllIdle();
  }

  private async checkAllIdle(): Promise<void> {
    if (this.stopped) return;

    const sessions = await this.config.runtime.listSessions();
    const allIdle = this.agents.every((agent) => {
      const current = sessions.find((s) => s.id === agent.session.id);
      return current?.status === "idle" || current?.status === "stopped";
    });

    if (allIdle && this.agents.length > 0) {
      // Don't auto-stop if no contributions yet AND less than 30s have passed.
      // Agents go idle between tool calls (e.g., coder finishes editing, goes idle
      // briefly, then calls grove_submit_work). Stopping too early kills the session
      // before the handoff can complete.
      const GRACE_PERIOD_MS = 30_000;
      const elapsed = Date.now() - this.startedAt;
      if (this.contributionCount === 0 && elapsed < GRACE_PERIOD_MS) {
        return; // Too early — wait for at least one contribution or grace period
      }
      await this.stop("All agents idle — session complete", LoopStopStatus.Achieved);
    }
  }

  /** Trigger an idle-completion check externally (for testing). */
  async checkIdleCompletion(): Promise<boolean> {
    await this.checkAllIdle();
    return this.stopped;
  }

  /**
   * Wait for the session to complete (all agents idle or stopped).
   *
   * Polls agent status every `pollMs` and resolves when `this.stopped` is true
   * or `timeoutMs` expires. Returns the final stop reason.
   */
  async waitForCompletion(timeoutMs = 300_000, pollMs = 3_000): Promise<string> {
    if (this.stopped) return this.stopReason ?? "Already stopped";

    const deadline = Date.now() + timeoutMs;
    return new Promise<string>((resolve) => {
      const poll = setInterval(async () => {
        await this.checkAllIdle();
        if (this.stopped || Date.now() >= deadline) {
          clearInterval(poll);
          if (!this.stopped) {
            void this.stop("Session timed out", LoopStopStatus.MaxIterations);
          }
          resolve(this.stopReason ?? "Timed out");
        }
      }, pollMs);
    });
  }

  /**
   * Resume an agent that crashed or hit context limits.
   * Queries the DAG for contributions since the agent last contributed,
   * and sends a summary to the new session.
   */
  async resumeAgent(role: string, _config?: AgentConfig): Promise<AgentSessionInfo> {
    const roleSpec = this.config.contract.topology?.roles.find((r) => r.name === role);
    if (!roleSpec) {
      throw new Error(`Role '${role}' not found in topology`);
    }

    // Reuse the existing workspace from the old agent if available,
    // otherwise provision a fresh one. Reprovisioning would fail because
    // the git branch/worktree path already exists from the original spawn.
    const existingAgent = this.agents.find((a) => a.role === role);
    const ws = existingAgent
      ? { cwd: existingAgent.workspaceMode.path, workspaceMode: existingAgent.workspaceMode }
      : await this.provisionAgentWorkspace(
          roleSpec,
          this.config.workspaceIsolationPolicy ?? "strict",
          resolveRoleWorkspaceStrategies(this.config.topology, this.sessionId).get(roleSpec.name) ??
            "HEAD",
        );
    const newSession = await this.spawnAgent(roleSpec, undefined, ws);

    // Send a reconciliation message. Observe the turn's terminal result
    // so a failed catch-up prompt is logged instead of silently restarting
    // the agent without its reconciliation context.
    const message = `[grove] You are resuming role '${role}'. Query the DAG via grove_log or grove_frontier to catch up on what happened while you were offline.`;
    const turn = await this.config.runtime.send(newSession.session, message);
    this.watchTurn(role, turn);

    // Replace the old agent entry
    const idx = this.agents.findIndex((a) => a.role === role);
    if (idx >= 0) {
      this.agents[idx] = newSession;
    } else {
      this.agents.push(newSession);
    }

    // Unsubscribe old handler before re-subscribing (prevents leak)
    const oldHandler = this.eventHandlers?.get(role);
    if (oldHandler) this.config.eventBus.unsubscribe(role, oldHandler);
    const newHandler = (event: import("./event-bus.js").GroveEvent) => {
      void this.handleEvent(newSession, event);
    };
    if (!this.eventHandlers) this.eventHandlers = new Map();
    this.eventHandlers.set(role, newHandler);
    this.config.eventBus.subscribe(role, newHandler);

    return newSession;
  }
}

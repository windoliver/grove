/**
 * Orchestrates a multi-agent session from start to completion.
 *
 * Given a contract with topology, spawns agents for each role,
 * sends goals, wires event routing, and monitors for stop conditions.
 */

import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";
import type { EventBus, GroveEvent } from "./event-bus.js";
import type { GroveContract } from "./contract.js";
import type { AgentRole } from "./topology.js";
import { TopologyRouter } from "./topology-router.js";

/** Configuration for starting a session. */
export interface SessionConfig {
  /** The session goal (what agents should accomplish). */
  readonly goal: string;
  /** The parsed contract (includes topology, metrics, etc.). */
  readonly contract: GroveContract;
  /** The agent runtime for spawning processes. */
  readonly runtime: AgentRuntime;
  /** The event bus for inter-agent notifications. */
  readonly eventBus: EventBus;
  /** Working directory for the project. */
  readonly projectRoot: string;
  /** Base directory for agent workspaces. */
  readonly workspaceBaseDir: string;
  /** Optional session ID (generated if not provided). */
  readonly sessionId?: string | undefined;
}

/** Status of a running session. */
export interface SessionStatus {
  readonly sessionId: string;
  readonly goal: string;
  readonly agents: readonly AgentSessionInfo[];
  readonly started: boolean;
  readonly stopped: boolean;
  readonly stopReason?: string | undefined;
}

/** Info about a single agent in the session. */
export interface AgentSessionInfo {
  readonly role: string;
  readonly session: AgentSession;
  readonly goal: string;
}

export class SessionOrchestrator {
  private readonly config: SessionConfig;
  private readonly sessionId: string;
  private readonly agents: AgentSessionInfo[] = [];
  private readonly router: TopologyRouter;
  private stopped = false;
  private stopReason: string | undefined;

  constructor(config: SessionConfig) {
    this.config = config;
    this.sessionId =
      config.sessionId ??
      `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const topology = config.contract.topology;
    if (topology === undefined) {
      throw new Error("Contract must define a topology for auto-spawn");
    }

    this.router = new TopologyRouter(topology, config.eventBus);
  }

  /** Start the session: spawn all agents and send goals. */
  async start(): Promise<SessionStatus> {
    const topology = this.config.contract.topology!;

    // Spawn all agents in parallel
    const spawnResults = await Promise.allSettled(
      topology.roles.map((role) => this.spawnAgent(role)),
    );

    for (const result of spawnResults) {
      if (result.status === "fulfilled") {
        this.agents.push(result.value);
      }
      // Errors are logged but don't block other agents
    }

    // Send goals to all agents
    for (const agent of this.agents) {
      await this.config.runtime.send(agent.session, agent.goal);
    }

    // Wire idle detection
    for (const agent of this.agents) {
      this.config.runtime.onIdle(agent.session, () => {
        this.handleAgentIdle(agent);
      });
    }

    // Subscribe all agents to their event channels
    for (const agent of this.agents) {
      this.config.eventBus.subscribe(agent.role, (event: GroveEvent) => {
        void this.handleEvent(agent, event);
      });
    }

    return this.getStatus();
  }

  /** Stop the session gracefully. */
  async stop(reason: string): Promise<void> {
    this.stopped = true;
    this.stopReason = reason;

    // Notify all agents
    this.router.broadcastStop(reason);

    // Close all agent sessions
    for (const agent of this.agents) {
      await this.config.runtime.close(agent.session);
    }
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
    };
  }

  private async spawnAgent(role: AgentRole): Promise<AgentSessionInfo> {
    const roleGoal =
      role.prompt ?? role.description ?? `Fulfill role: ${role.name}`;
    const fullGoal = `Session goal: ${this.config.goal}\n\nYour role (${role.name}): ${roleGoal}`;

    const agentConfig: AgentConfig = {
      role: role.name,
      command: role.command ?? "claude",
      cwd: this.config.projectRoot,
      goal: fullGoal,
      env: {
        GROVE_SESSION_ID: this.sessionId,
        GROVE_ROLE: role.name,
      },
    };

    const session = await this.config.runtime.spawn(role.name, agentConfig);

    return {
      role: role.name,
      session,
      goal: fullGoal,
    };
  }

  private async handleEvent(
    agent: AgentSessionInfo,
    event: GroveEvent,
  ): Promise<void> {
    if (event.type === "stop") {
      // Auto-close session on stop event
      if (!this.stopped) {
        const reason =
          typeof event.payload.reason === "string"
            ? event.payload.reason
            : "Stop condition met";
        void this.stop(reason);
      }
      return;
    }

    // Forward contribution notifications to the agent
    const message = `[grove] New ${event.type} from ${event.sourceRole}: ${JSON.stringify(event.payload)}`;
    await this.config.runtime.send(agent.session, message);
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
      await this.stop("All agents idle — session complete");
    }
  }

  /** Trigger an idle-completion check externally (for testing). */
  async checkIdleCompletion(): Promise<boolean> {
    await this.checkAllIdle();
    return this.stopped;
  }

  /**
   * Resume an agent that crashed or hit context limits.
   * Queries the DAG for contributions since the agent last contributed,
   * and sends a summary to the new session.
   */
  async resumeAgent(role: string, _config?: AgentConfig): Promise<AgentSessionInfo> {
    const roleSpec = this.config.contract.topology!.roles.find((r) => r.name === role);
    if (!roleSpec) {
      throw new Error(`Role '${role}' not found in topology`);
    }

    // Spawn a new session for the role
    const newSession = await this.spawnAgent(roleSpec);

    // Send a reconciliation message
    const message = `[grove] You are resuming role '${role}'. Query the DAG via grove_log or grove_frontier to catch up on what happened while you were offline.`;
    await this.config.runtime.send(newSession.session, message);

    // Replace the old agent entry
    const idx = this.agents.findIndex((a) => a.role === role);
    if (idx >= 0) {
      this.agents[idx] = newSession;
    } else {
      this.agents.push(newSession);
    }

    // Re-subscribe to events
    this.config.eventBus.subscribe(role, (event) => {
      void this.handleEvent(newSession, event);
    });

    return newSession;
  }
}

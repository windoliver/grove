/**
 * Session service — backend brain for agent sessions.
 *
 * Owns:
 * - Agent lifecycle via AgentRuntime (spawn, monitor, wake-up)
 * - Session state (create, complete, persist)
 * - Event routing via topology edges + EventBus
 * - Contribution monitoring (subscribes to EventBus, routes to agents)
 * - WebSocket push to connected TUI clients
 *
 * The TUI is a thin client — it sends commands and receives events.
 * All business logic lives here.
 *
 * This service wraps the existing SessionOrchestrator and adds:
 * - Push-event fan-out to WebSocket listeners
 * - Contribution counting
 * - Typed event protocol for TUI consumption
 */

import type { AgentRuntime, AgentSession } from "../core/agent-runtime.js";
import type { GroveContract } from "../core/contract.js";
import type { EventBus, EventHandler, GroveEvent } from "../core/event-bus.js";
import { SessionOrchestrator } from "../core/session-orchestrator.js";
import type { AgentTopology } from "../core/topology.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Dependencies for creating a SessionService. */
export interface SessionServiceConfig {
  readonly contract: GroveContract;
  readonly runtime: AgentRuntime;
  readonly eventBus: EventBus;
  readonly projectRoot: string;
  readonly workspaceBaseDir: string;
}

// ---------------------------------------------------------------------------
// State snapshot (serialisable for WebSocket)
// ---------------------------------------------------------------------------

/** Agent info suitable for JSON serialisation over WebSocket. */
export interface AgentInfo {
  readonly role: string;
  readonly id: string;
  readonly status: string;
}

/** Serialisable session state pushed to TUI clients. */
export interface SessionState {
  readonly id: string;
  readonly goal: string;
  readonly agents: readonly AgentInfo[];
  readonly contributions: number;
  readonly status: "pending" | "running" | "complete";
}

// ---------------------------------------------------------------------------
// Push events
// ---------------------------------------------------------------------------

/** Events pushed to TUI clients via WebSocket. */
export type SessionEvent =
  | { readonly type: "agent_spawned"; readonly role: string; readonly agent: AgentInfo }
  | {
      readonly type: "contribution";
      readonly cid: string;
      readonly kind: string;
      readonly summary: string;
      readonly role: string;
    }
  | { readonly type: "agent_done"; readonly role: string; readonly reason: string }
  | { readonly type: "session_complete"; readonly reason: string }
  | { readonly type: "error"; readonly message: string };

/** Callback type for event listeners. */
export type SessionEventListener = (event: SessionEvent) => void;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SessionService {
  private readonly config: SessionServiceConfig;
  private readonly topology: AgentTopology;
  private readonly listeners: Set<SessionEventListener> = new Set();

  private orchestrator: SessionOrchestrator | undefined;
  private goal = "";
  private sessionId = "";
  private sessionStatus: "pending" | "running" | "complete" = "pending";
  private contributionCount = 0;
  private readonly doneRoles: Set<string> = new Set();
  private readonly eventHandlers: Array<{ role: string; handler: EventHandler }> = [];

  constructor(config: SessionServiceConfig) {
    this.config = config;
    const topology = config.contract.topology;
    if (topology === undefined) {
      throw new Error("Contract must have topology");
    }
    this.topology = topology;

    // Subscribe to ALL topology role events for push notifications
    for (const role of topology.roles) {
      const handler: EventHandler = (event: GroveEvent) => {
        this.handleEvent(event);
      };
      config.eventBus.subscribe(role.name, handler);
      this.eventHandlers.push({ role: role.name, handler });
    }

    // Also subscribe to "system" channel
    const systemHandler: EventHandler = (event: GroveEvent) => {
      this.handleEvent(event);
    };
    config.eventBus.subscribe("system", systemHandler);
    this.eventHandlers.push({ role: "system", handler: systemHandler });
  }

  /** Register a listener for push events (WebSocket clients). */
  onEvent(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Start a session — spawn all agents via orchestrator. */
  async startSession(goal: string, sessionId?: string): Promise<SessionState> {
    this.goal = goal;
    this.sessionId = sessionId ?? `session-${Date.now()}`;
    this.sessionStatus = "running";
    this.contributionCount = 0;
    this.doneRoles.clear();

    this.orchestrator = new SessionOrchestrator({
      goal,
      contract: this.config.contract,
      runtime: this.config.runtime,
      eventBus: this.config.eventBus,
      projectRoot: this.config.projectRoot,
      workspaceBaseDir: this.config.workspaceBaseDir,
      sessionId: this.sessionId,
    });

    try {
      const status = await this.orchestrator.start();

      // Emit spawn events for each agent
      for (const agent of status.agents) {
        const info = sessionToAgentInfo(agent.session);
        this.emit({ type: "agent_spawned", role: agent.role, agent: info });
      }
    } catch (err: unknown) {
      this.emit({
        type: "error",
        message: `Failed to start session: ${String(err)}`,
      });
    }

    return this.getState();
  }

  /** Stop the session. */
  async stopSession(reason: string): Promise<void> {
    if (this.orchestrator === undefined) return;
    this.sessionStatus = "complete";
    await this.orchestrator.stop(reason);
    this.emit({ type: "session_complete", reason });
  }

  /** Get current session state (serialisable snapshot). */
  getState(): SessionState {
    const orchestratorStatus = this.orchestrator?.getStatus();
    const agents: AgentInfo[] = orchestratorStatus
      ? orchestratorStatus.agents.map((a) => sessionToAgentInfo(a.session))
      : [];

    return {
      id: this.sessionId,
      goal: this.goal,
      agents,
      contributions: this.contributionCount,
      status: this.sessionStatus,
    };
  }

  /** Clean up subscriptions. */
  destroy(): void {
    for (const { role, handler } of this.eventHandlers) {
      this.config.eventBus.unsubscribe(role, handler);
    }
    this.eventHandlers.length = 0;
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Handle an IPC event from any agent. */
  private handleEvent(event: GroveEvent): void {
    const p = event.payload;
    if (event.type === "contribution") {
      this.contributionCount++;
      this.emit({
        type: "contribution",
        cid: String(p.cid ?? ""),
        kind: String(p.kind ?? ""),
        summary: String(p.summary ?? ""),
        role: event.sourceRole,
      });
    }

    if (event.type === "stop") {
      const reason = typeof p.reason === "string" ? p.reason : "";
      this.emit({ type: "agent_done", role: event.sourceRole, reason });
      this.doneRoles.add(event.sourceRole);

      // Check if all roles are done
      const allDone = this.topology.roles.every((r) => this.doneRoles.has(r.name));
      if (allDone && this.sessionStatus === "running") {
        this.sessionStatus = "complete";
        this.emit({ type: "session_complete", reason: "All agents done" });
      }
    }
  }

  /** Push event to all connected listeners. */
  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* ignore listener errors */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionToAgentInfo(session: AgentSession): AgentInfo {
  return {
    role: session.role,
    id: session.id,
    status: session.status,
  };
}

/**
 * Agent runtime abstraction for spawning and managing agent processes.
 *
 * Decouples grove from any specific agent CLI (acpx, tmux, subprocess).
 */

/** Configuration for spawning an agent. */
export interface AgentConfig {
  readonly role: string;
  readonly command: string;
  readonly cwd: string;
  readonly env?: Record<string, string> | undefined;
  readonly goal?: string | undefined;
  readonly prompt?: string | undefined;
  /** If true, don't send initial prompt — agent waits for push via IPC. */
  readonly waitForPush?: boolean | undefined;
}

/** A running agent session. */
export interface AgentSession {
  readonly id: string;
  readonly role: string;
  readonly pid?: number | undefined;
  readonly status: "running" | "idle" | "stopped" | "crashed";
}

/** Runtime for managing agent lifecycle. */
export interface AgentRuntime {
  /** Spawn a new agent session. */
  spawn(role: string, config: AgentConfig): Promise<AgentSession>;
  /** Send a message/prompt to a running agent. */
  send(session: AgentSession, message: string): Promise<void>;
  /** Gracefully close an agent session. */
  close(session: AgentSession): Promise<void>;
  /** Register a callback for when an agent becomes idle. */
  onIdle(session: AgentSession, callback: () => void): void;
  /** List all active sessions. */
  listSessions(): Promise<readonly AgentSession[]>;
  /** Check if the runtime's dependencies are available. */
  isAvailable(): Promise<boolean>;
}

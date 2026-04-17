/**
 * Agent runtime abstraction for spawning and managing agent processes.
 *
 * Decouples grove from any specific agent CLI (acpx, tmux, subprocess).
 */

import type { AcpxTurn } from "../acp/types.js";
import type { AgentPlatformType } from "./topology.js";

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
  /** Agent platform identifier — determines which backend CLI to invoke. */
  readonly platform?: AgentPlatformType | undefined;
  /** Model identifier, e.g. "claude-opus-4-6". Passed through to the runtime. */
  readonly model?: string | undefined;
}

/** A running agent session. */
export interface AgentSession {
  readonly id: string;
  readonly role: string;
  readonly pid?: number | undefined;
  readonly status: "running" | "idle" | "stopped" | "crashed";
  /** Agent platform used for this session (e.g. "claude-code", "codex"). */
  readonly platform?: AgentPlatformType | undefined;
  /** Model identifier used for this session. */
  readonly model?: string | undefined;
  /** Agent backend name used by the runtime (e.g. "claude", "codex", "gemini"). */
  readonly agent?: string | undefined;
}

/** Runtime for managing agent lifecycle. */
export interface AgentRuntime {
  /** Spawn a new agent session. */
  spawn(role: string, config: AgentConfig): Promise<AgentSession>;
  /** Send a prompt and return the typed turn stream. */
  send(session: AgentSession, message: string): Promise<AcpxTurn>;
  /** Gracefully close an agent session. */
  close(session: AgentSession): Promise<void>;
  /** Register a callback for when an agent becomes idle. */
  onIdle(session: AgentSession, callback: () => void): void;
  /** List all active sessions. */
  listSessions(): Promise<readonly AgentSession[]>;
  /** Check if the runtime's dependencies are available. */
  isAvailable(): Promise<boolean>;
}

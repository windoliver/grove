/**
 * Agent runtime abstraction for spawning and managing agent processes.
 *
 * Decouples grove from any specific agent CLI (acpx, tmux, subprocess).
 */

import type { AcpxTurn } from "../acp/types.js";
import type { AgentSessionEntity } from "./entity.js";
import type { AgentPlatformType } from "./topology.js";

/** Configuration for spawning an agent. */
export interface AgentConfig {
  readonly role: string;
  readonly command: string;
  readonly cwd: string;
  /**
   * Environment variables injected into the child agent process.
   * Runtime implementations MUST pass these through unchanged.
   */
  readonly env?: Record<string, string> | undefined;
  readonly goal?: string | undefined;
  readonly prompt?: string | undefined;
  /** If true, don't send initial prompt — agent waits for push via IPC. */
  readonly waitForPush?: boolean | undefined;
  /** Agent platform identifier — determines which backend CLI to invoke. */
  readonly platform?: AgentPlatformType | undefined;
  /** Model identifier, e.g. "claude-opus-4-6". Passed through to the runtime. */
  readonly model?: string | undefined;
  /**
   * MCP servers forwarded to the ACP agent via `session/new`. Lets Grove's
   * grove_submit_work / grove_submit_review / grove_done tools reach the
   * agent through ACP in addition to the workspace-local `.mcp.json` /
   * codex registry paths.
   */
  readonly mcpServers?: ReadonlyArray<{
    readonly name: string;
    readonly command: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly startupTimeoutSec?: number | undefined;
  }>;
}

/**
 * A running agent session.
 *
 * `id` follows the canonical contract documented in `./session-id.ts`:
 * `grove-<role>-<counter>-<base36-timestamp>`. Implementations MUST construct
 * IDs via `buildSessionId()` and consumers MUST parse them via
 * `parseSessionId()` rather than open-coding regexes — this is what keeps
 * `listSessions()` rediscovery and reattach/resume paths consistent across
 * runtimes.
 */
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
  /**
   * True when spawn(config.goal/config.prompt) starts the first turn itself.
   * Runtimes without this capability rely on SessionOrchestrator to send the
   * initial role goal after spawn.
   */
  readonly sendsInitialPromptOnSpawn?: boolean | undefined;
  /**
   * Spawn a new agent session.
   *
   * The returned `session.id` MUST be produced via `buildSessionId(role, n)`
   * (see `./session-id.ts`). `listSessions()` MUST be able to rediscover any
   * id this method returned for the lifetime of the underlying session.
   */
  spawn(role: string, config: AgentConfig): Promise<AgentSession>;
  /** Send a prompt and return the typed turn stream. */
  send(session: AgentSession, message: string): Promise<AcpxTurn>;
  /** Gracefully close an agent session. */
  close(session: AgentSession): Promise<void>;
  /** Register a callback for when an agent becomes idle. */
  onIdle(session: AgentSession, callback: () => void): void;
  /** List all active sessions. */
  listSessions(): Promise<readonly AgentSession[]>;
  /**
   * Return AgentSessions wrapped in the Entity envelope (derived via agentSessionToEntity adapter).
   * Acceptance criterion for #287.
   */
  listSessionEntities(): Promise<readonly AgentSessionEntity[]>;
  /** Check if the runtime's dependencies are available. */
  isAvailable(): Promise<boolean>;
}

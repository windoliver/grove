/**
 * TmuxRuntime — AgentRuntime implementation backed by tmux sessions.
 *
 * Wraps the existing ShellTmuxManager patterns from the TUI layer into
 * the core AgentRuntime interface, so that any consumer can spawn agents
 * inside tmux without depending on TUI-specific code.
 */

import { execSync } from "node:child_process";
import type { AcpxTurn } from "../acp/types.js";
import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";
import { buildSessionId, parseSessionId, SESSION_ID_PREFIX } from "./session-id.js";
import { shellEscape } from "./shell-utils.js";

/**
 * TmuxRuntime does not produce ACP output. Return an already-settled
 * AcpxTurn so the interface is satisfied without misleading the consumer.
 * Use `errorTurn()` on delivery failure — a synthetic `end_turn` on a
 * failed send-keys would silently hide non-delivery from callers who
 * watch `turn.result`.
 *
 * IMPORTANT — semantics of this success turn:
 *   `end_turn` here means "tmux accepted the keystrokes", NOT "the agent
 *   process consumed the prompt". The pane may have fallen back to a
 *   shell, the agent may have died, or the keystrokes may have been sent
 *   to a non-agent foreground process. Callers that need agent-level
 *   delivery acknowledgement must use the acpx-backed runtime; with
 *   tmux, this is best-effort. This is unavoidable — tmux does not
 *   expose an agent-level ACK channel — so the typed-turn contract
 *   degrades to write-ACK in this fallback mode. Documented rather than
 *   papered over with a synthetic ACK.
 */
function emptyTurn(sessionId: string): AcpxTurn {
  return {
    sessionId,
    turnId: `${sessionId}-noacp`,
    messages: (async function* () {
      /* no messages */
    })(),
    result: Promise.resolve({ turnId: `${sessionId}-noacp`, stopReason: "end_turn" as const }),
    cancel: async () => undefined,
    close: async () => undefined,
  };
}

function errorTurn(sessionId: string, code: string, message: string): AcpxTurn {
  const turnId = `${sessionId}-noacp-err`;
  return {
    sessionId,
    turnId,
    messages: (async function* () {
      /* no messages */
    })(),
    result: Promise.resolve({
      turnId,
      stopReason: "error" as const,
      error: { code, message },
    }),
    cancel: async () => undefined,
    close: async () => undefined,
  };
}

interface TmuxSessionEntry {
  session: AgentSession;
  idleCallbacks: (() => void)[];
  lastOutput: string;
  idleTimer: ReturnType<typeof setInterval> | null;
}

export class TmuxRuntime implements AgentRuntime {
  private sessions: Map<string, TmuxSessionEntry> = new Map();
  private nextId = 0;

  /** How often (ms) to poll for idle detection. */
  private readonly idlePollMs: number;

  constructor(options?: { idlePollMs?: number }) {
    this.idlePollMs = options?.idlePollMs ?? 3000;
  }

  async isAvailable(): Promise<boolean> {
    try {
      execSync("tmux -L grove -V", { encoding: "utf-8", stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    const counter = this.nextId++;
    const sessionName = buildSessionId(role, counter);
    const id = sessionName;

    // Pass platform/model as env vars so the agent process can read them
    const spawnEnv: Record<string, string> = {
      ...process.env,
      ...config.env,
    } as Record<string, string>;
    if (config.platform) spawnEnv.GROVE_AGENT_PLATFORM = config.platform;
    if (config.model) spawnEnv.GROVE_AGENT_MODEL = config.model;

    try {
      execSync(
        `tmux -L grove new-session -d -s ${shellEscape(sessionName)} -c ${shellEscape(config.cwd)} ${shellEscape(config.command)}`,
        {
          encoding: "utf-8",
          stdio: "pipe",
          env: spawnEnv,
        },
      );
    } catch (err) {
      throw new Error(
        `tmux spawn failed for role "${role}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const session: AgentSession = {
      id,
      role,
      status: "running",
      platform: config.platform,
      model: config.model,
    };
    const entry: TmuxSessionEntry = {
      session,
      idleCallbacks: [],
      lastOutput: "",
      idleTimer: null,
    };
    this.sessions.set(id, entry);

    // Send initial prompt if provided
    if (config.goal) {
      await this.send(session, config.goal);
    }

    return session;
  }

  async send(session: AgentSession, message: string): Promise<AcpxTurn> {
    const entry = this.sessions.get(session.id);
    if (!entry) {
      return errorTurn(session.id, "no_session", `unknown tmux session: ${session.id}`);
    }
    try {
      execSync(
        `tmux -L grove send-keys -t ${shellEscape(session.id)} ${shellEscape(message)} Enter`,
        { encoding: "utf-8", stdio: "pipe" },
      );
    } catch (err) {
      // Session may have been killed externally — mark as crashed and
      // report the delivery failure so callers that watch turn.result
      // see a non-success outcome instead of a synthetic end_turn.
      entry.session = { ...entry.session, status: "crashed" };
      return errorTurn(
        session.id,
        "send_keys_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
    return emptyTurn(session.id);
  }

  async close(session: AgentSession): Promise<void> {
    const entry = this.sessions.get(session.id);
    if (entry?.idleTimer) {
      clearInterval(entry.idleTimer);
    }

    try {
      execSync(`tmux -L grove kill-session -t ${shellEscape(session.id)}`, {
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch {
      // Session may already be gone — ignore
    }

    if (entry) {
      entry.session = { ...entry.session, status: "stopped" };
    }
    this.sessions.delete(session.id);
  }

  onIdle(session: AgentSession, callback: () => void): void {
    const entry = this.sessions.get(session.id);
    if (!entry) return;

    entry.idleCallbacks.push(callback);

    // Start polling if not already started
    if (!entry.idleTimer) {
      entry.idleTimer = setInterval(() => {
        this.checkIdle(session.id);
      }, this.idlePollMs);
    }
  }

  async listSessions(): Promise<readonly AgentSession[]> {
    try {
      // Must use the same `-L grove` socket as spawn(); listing without it
      // queries the default tmux server and misses every grove session.
      const output = execSync("tmux -L grove list-sessions -F '#{session_name}'", {
        encoding: "utf-8",
        stdio: "pipe",
      });
      const names = output
        .trim()
        .split("\n")
        .filter((n) => n.startsWith(SESSION_ID_PREFIX));

      // Reconcile tracked sessions with tmux reality
      const result: AgentSession[] = [];
      for (const name of names) {
        const tracked = this.sessions.get(name);
        if (tracked) {
          result.push(tracked.session);
        } else {
          // External grove session — report it as running
          const parsed = parseSessionId(name);
          if (!parsed) continue;
          result.push({ id: name, role: parsed.role, status: "running" });
        }
      }
      return result;
    } catch {
      // No tmux server running or not installed
      return [];
    }
  }

  /** Poll-based idle detection: compare pane output between ticks. */
  private checkIdle(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    try {
      const output = execSync(`tmux -L grove capture-pane -p -t ${shellEscape(sessionId)}`, {
        encoding: "utf-8",
        stdio: "pipe",
      });

      if (output === entry.lastOutput && entry.lastOutput !== "") {
        // Output hasn't changed — fire idle callbacks
        entry.session = { ...entry.session, status: "idle" };
        for (const cb of entry.idleCallbacks) {
          try {
            cb();
          } catch {
            // Don't let callback errors kill the poll loop
          }
        }
      } else {
        entry.lastOutput = output;
        if (entry.session.status === "idle") {
          entry.session = { ...entry.session, status: "running" };
        }
      }
    } catch {
      // Session gone — clean up timer
      if (entry.idleTimer) {
        clearInterval(entry.idleTimer);
        entry.idleTimer = null;
      }
      entry.session = { ...entry.session, status: "crashed" };
    }
  }
}

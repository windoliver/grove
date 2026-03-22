/**
 * TmuxRuntime — AgentRuntime implementation backed by tmux sessions.
 *
 * Wraps the existing ShellTmuxManager patterns from the TUI layer into
 * the core AgentRuntime interface, so that any consumer can spawn agents
 * inside tmux without depending on TUI-specific code.
 */

import { execSync } from "node:child_process";
import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";

/** Prefix for all grove tmux session names. */
const SESSION_PREFIX = "grove-";

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
    const sessionName = `${SESSION_PREFIX}${role}-${counter}`;
    const id = sessionName;

    try {
      execSync(
        `tmux -L grove new-session -d -s ${shellEscape(sessionName)} -c ${shellEscape(config.cwd)} ${shellEscape(config.command)}`,
        {
          encoding: "utf-8",
          stdio: "pipe",
          env: config.env ? { ...process.env, ...config.env } : process.env,
        },
      );
    } catch (err) {
      throw new Error(
        `tmux spawn failed for role "${role}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const session: AgentSession = { id, role, status: "running" };
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

  async send(session: AgentSession, message: string): Promise<void> {
    const entry = this.sessions.get(session.id);
    if (!entry) return;

    try {
      execSync(
        `tmux -L grove send-keys -t ${shellEscape(session.id)} ${shellEscape(message)} Enter`,
        { encoding: "utf-8", stdio: "pipe" },
      );
    } catch {
      // Session may have been killed externally — mark as crashed
      entry.session = { ...entry.session, status: "crashed" };
    }
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
      const output = execSync("tmux list-sessions -F '#{session_name}'", {
        encoding: "utf-8",
        stdio: "pipe",
      });
      const names = output
        .trim()
        .split("\n")
        .filter((n) => n.startsWith(SESSION_PREFIX));

      // Reconcile tracked sessions with tmux reality
      const result: AgentSession[] = [];
      for (const name of names) {
        const tracked = this.sessions.get(name);
        if (tracked) {
          result.push(tracked.session);
        } else {
          // External grove session — report it as running
          const role = name.slice(SESSION_PREFIX.length).replace(/-\d+$/, "");
          result.push({ id: name, role, status: "running" });
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
      const output = execSync(
        `tmux capture-pane -p -t ${shellEscape(sessionId)}`,
        { encoding: "utf-8", stdio: "pipe" },
      );

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

/** Escape a string for safe use in shell commands. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

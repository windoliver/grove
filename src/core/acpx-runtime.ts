/**
 * AcpxRuntime — AgentRuntime implementation backed by the `acpx` CLI.
 *
 * acpx provides stateful, multi-turn agent sessions (claude, codex, gemini).
 * Each session is a persistent conversation that survives restarts.
 *
 * When acpx is not installed this runtime gracefully reports unavailable
 * and all operations become safe no-ops or throw clear errors.
 */

import { execSync } from "node:child_process";
import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";

/** Default agent backend used by acpx when none is specified. */
const DEFAULT_AGENT = "claude";

interface AcpxSessionEntry {
  session: AgentSession;
  agent: string;
  sessionName: string;
  idleCallbacks: (() => void)[];
  idleTimer: ReturnType<typeof setInterval> | null;
}

export class AcpxRuntime implements AgentRuntime {
  private sessions: Map<string, AcpxSessionEntry> = new Map();
  private nextId = 0;

  /** Which acpx agent backend to use (claude, codex, gemini). */
  private readonly agent: string;

  /** How often (ms) to poll for idle detection. */
  private readonly idlePollMs: number;

  constructor(options?: { agent?: string; idlePollMs?: number }) {
    this.agent = options?.agent ?? DEFAULT_AGENT;
    this.idlePollMs = options?.idlePollMs ?? 5000;
  }

  async isAvailable(): Promise<boolean> {
    try {
      execSync("acpx --version", { encoding: "utf-8", stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    if (!(await this.isAvailable())) {
      throw new Error("acpx is not installed or not in PATH");
    }

    const counter = this.nextId++;
    const sessionName = `grove-${role}-${counter}`;
    const id = sessionName;

    // Create a new acpx session
    try {
      execSync(
        `acpx ${shellEscape(this.agent)} sessions new -s ${shellEscape(sessionName)} --cwd ${shellEscape(config.cwd)}`,
        { encoding: "utf-8", stdio: "pipe" },
      );
    } catch (err) {
      throw new Error(
        `acpx session creation failed for role "${role}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const session: AgentSession = { id, role, status: "running" };
    const entry: AcpxSessionEntry = {
      session,
      agent: this.agent,
      sessionName,
      idleCallbacks: [],
      idleTimer: null,
    };
    this.sessions.set(id, entry);

    // Send initial prompt if provided
    const initialMessage = config.goal ?? config.prompt;
    if (initialMessage) {
      await this.send(session, initialMessage);
    }

    return session;
  }

  async send(session: AgentSession, message: string): Promise<void> {
    const entry = this.sessions.get(session.id);
    if (!entry) return;

    try {
      entry.session = { ...entry.session, status: "running" };
      execSync(
        `acpx ${shellEscape(entry.agent)} -s ${shellEscape(entry.sessionName)} ${shellEscape(message)}`,
        { encoding: "utf-8", stdio: "pipe", timeout: 300_000 },
      );
      entry.session = { ...entry.session, status: "idle" };

      // Fire idle callbacks after send completes (acpx is synchronous per turn)
      for (const cb of entry.idleCallbacks) {
        try {
          cb();
        } catch {
          // Don't let callback errors propagate
        }
      }
    } catch (err) {
      entry.session = { ...entry.session, status: "crashed" };
      throw new Error(
        `acpx send failed for session "${session.id}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async close(session: AgentSession): Promise<void> {
    const entry = this.sessions.get(session.id);
    if (entry?.idleTimer) {
      clearInterval(entry.idleTimer);
    }

    try {
      if (entry) {
        execSync(
          `acpx ${shellEscape(entry.agent)} sessions delete -s ${shellEscape(entry.sessionName)}`,
          { encoding: "utf-8", stdio: "pipe" },
        );
      }
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

    // For acpx, idle detection is polling-based: check session status
    if (!entry.idleTimer) {
      entry.idleTimer = setInterval(() => {
        this.checkIdle(session.id);
      }, this.idlePollMs);
    }
  }

  async listSessions(): Promise<readonly AgentSession[]> {
    if (!(await this.isAvailable())) {
      return [];
    }

    try {
      const output = execSync(
        `acpx ${shellEscape(this.agent)} sessions list`,
        { encoding: "utf-8", stdio: "pipe" },
      );

      // Return tracked sessions supplemented by acpx reality
      const lines = output.trim().split("\n").filter(Boolean);
      const result: AgentSession[] = [];

      // Include all tracked sessions
      for (const entry of this.sessions.values()) {
        result.push(entry.session);
      }

      // Also report any grove sessions found in acpx that we aren't tracking
      for (const line of lines) {
        const name = line.trim();
        if (name.startsWith("grove-") && !this.sessions.has(name)) {
          const role = name.slice(6).replace(/-\d+$/, "");
          result.push({ id: name, role, status: "idle" });
        }
      }

      return result;
    } catch {
      // Fall back to tracked sessions only
      return [...this.sessions.values()].map((e) => e.session);
    }
  }

  /** Poll acpx session status for idle detection. */
  private checkIdle(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    // acpx send is synchronous, so the session is idle between sends.
    // This timer is a fallback for cases where external mutations occur.
    if (entry.session.status === "running") {
      // Optimistic: after idlePollMs without a new send, assume idle
      entry.session = { ...entry.session, status: "idle" };
      for (const cb of entry.idleCallbacks) {
        try {
          cb();
        } catch {
          // Don't let callback errors kill the poll loop
        }
      }
    }
  }
}

/** Escape a string for safe use in shell commands. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

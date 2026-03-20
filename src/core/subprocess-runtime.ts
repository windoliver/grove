/**
 * Minimal agent runtime using Bun.spawn.
 * No PTY, no session persistence. Suitable for CI and testing.
 */

import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";

interface SessionEntry {
  proc: import("bun").Subprocess<"pipe", "pipe", "pipe">;
  session: AgentSession;
  idleCallbacks: (() => void)[];
}

export class SubprocessRuntime implements AgentRuntime {
  private sessions = new Map<string, SessionEntry>();
  private nextId = 0;

  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    const id = `subprocess-${role}-${this.nextId++}`;
    const [cmd, ...args] = config.command.split(/\s+/);

    if (!cmd) {
      throw new Error(`Empty command for role "${role}"`);
    }

    const proc = Bun.spawn([cmd, ...args], {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const session: AgentSession = { id, role, pid: proc.pid, status: "running" };
    this.sessions.set(id, { proc, session, idleCallbacks: [] });

    // Monitor for exit
    proc.exited.then(() => {
      const entry = this.sessions.get(id);
      if (entry) {
        entry.session = { ...entry.session, status: "stopped" };
      }
    });

    // Send initial prompt if provided
    if (config.goal) {
      await this.send(session, config.goal);
    }

    return session;
  }

  async send(session: AgentSession, message: string): Promise<void> {
    const entry = this.sessions.get(session.id);
    if (!entry?.proc.stdin) return;
    const result = entry.proc.stdin.write(`${message}\n`);
    if (result instanceof Promise) await result;
    const flush = entry.proc.stdin.flush();
    if (flush instanceof Promise) await flush;
  }

  async close(session: AgentSession): Promise<void> {
    const entry = this.sessions.get(session.id);
    if (!entry) return;
    entry.proc.kill();
    await entry.proc.exited;
    this.sessions.delete(session.id);
  }

  onIdle(session: AgentSession, callback: () => void): void {
    const entry = this.sessions.get(session.id);
    if (entry) entry.idleCallbacks.push(callback);
  }

  async listSessions(): Promise<readonly AgentSession[]> {
    return [...this.sessions.values()].map((e) => e.session);
  }

  async isAvailable(): Promise<boolean> {
    return true; // Always available — just needs Bun
  }
}

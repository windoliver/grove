/**
 * Minimal agent runtime using Bun.spawn.
 * No PTY, no session persistence. Suitable for CI and testing.
 */

import type { AcpxTurn } from "../acp/types.js";
import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";

/**
 * SubprocessRuntime does not produce ACP output. Return an already-settled
 * AcpxTurn so the interface is satisfied without misleading the consumer.
 * Use `errorTurn()` on delivery failure — a synthetic `end_turn` on a
 * failed write would silently hide non-delivery from callers who watch
 * `turn.result`.
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

    const spawnEnv: Record<string, string> = {
      ...process.env,
      ...config.env,
    } as Record<string, string>;
    if (config.platform) spawnEnv.GROVE_AGENT_PLATFORM = config.platform;
    if (config.model) spawnEnv.GROVE_AGENT_MODEL = config.model;

    const proc = Bun.spawn([cmd, ...args], {
      cwd: config.cwd,
      env: spawnEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const session: AgentSession = {
      id,
      role,
      pid: proc.pid,
      status: "running",
      platform: config.platform,
      model: config.model,
    };
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

  async send(session: AgentSession, message: string): Promise<AcpxTurn> {
    const entry = this.sessions.get(session.id);
    if (!entry) {
      return errorTurn(session.id, "no_session", `unknown session id: ${session.id}`);
    }
    if (!entry.proc.stdin) {
      return errorTurn(session.id, "no_stdin", "subprocess has no writable stdin");
    }
    try {
      const result = entry.proc.stdin.write(`${message}\n`);
      if (result instanceof Promise) await result;
      const flush = entry.proc.stdin.flush();
      if (flush instanceof Promise) await flush;
    } catch (err) {
      return errorTurn(
        session.id,
        "stdin_write_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
    return emptyTurn(session.id);
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

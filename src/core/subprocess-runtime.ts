/**
 * Minimal agent runtime using Bun.spawn.
 * No PTY, no session persistence. Suitable for CI and testing.
 */

import type { AcpxTurn } from "../acp/types.js";
import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";
import { buildSessionId } from "./session-id.js";

/**
 * SubprocessRuntime does not produce ACP output. Return an already-settled
 * AcpxTurn so the interface is satisfied without misleading the consumer.
 * Use `errorTurn()` on delivery failure — a synthetic `end_turn` on a
 * failed write would silently hide non-delivery from callers who watch
 * `turn.result`.
 *
 * IMPORTANT — semantics of this success turn:
 *   `end_turn` here means "bytes written to the child's stdin pipe", NOT
 *   "the child process read or acted on them". Callers that need
 *   agent-level acknowledgement must use the acpx-backed runtime; with
 *   SubprocessRuntime the typed-turn contract degrades to write-ACK.
 *   This is unavoidable — a plain subprocess has no agent-level ACK
 *   channel — and is called out explicitly rather than papered over.
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
  exited: boolean;
}

/**
 * Split a shell-like command string into argv tokens.
 *
 * Supports single/double quotes and backslash escaping so profiles can pass
 * quoted `-e` / `-c` scripts without being corrupted by naive whitespace split.
 */
function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let tokenStarted = false;

  for (const ch of command) {
    if (escaping) {
      current += ch;
      escaping = false;
      tokenStarted = true;
      continue;
    }

    if (quote === null) {
      if (ch === " " || ch === "\t" || ch === "\n") {
        if (tokenStarted) {
          args.push(current);
          current = "";
          tokenStarted = false;
        }
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        tokenStarted = true;
        continue;
      }
      if (ch === "\\") {
        escaping = true;
        tokenStarted = true;
        continue;
      }
      current += ch;
      tokenStarted = true;
      continue;
    }

    if (ch === quote) {
      quote = null;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      escaping = true;
      continue;
    }
    current += ch;
    tokenStarted = true;
  }

  if (quote !== null) {
    throw new Error(`Unterminated quote in command: ${command}`);
  }
  if (escaping) {
    current += "\\";
    tokenStarted = true;
  }
  if (tokenStarted) {
    args.push(current);
  }
  return args;
}

export class SubprocessRuntime implements AgentRuntime {
  private sessions = new Map<string, SessionEntry>();
  private nextId = 0;

  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    const id = buildSessionId(role, this.nextId++);
    const [cmd, ...args] = splitCommand(config.command);

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
    const entry: SessionEntry = { proc, session, idleCallbacks: [], exited: false };
    this.sessions.set(id, entry);

    // Monitor for exit — flip the exited flag so send() can refuse to
    // synthesize end_turn against a dead child.
    proc.exited.then(() => {
      entry.exited = true;
      entry.session = { ...entry.session, status: "stopped" };
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
    // Reject sends to a child that has already exited. The `exited` flag
    // is only flipped by a `proc.exited.then(...)` microtask, so there is
    // a window where the child has died but the flag has not yet flipped.
    // Consult `proc.exitCode` directly (null while running, a number on
    // exit) so we catch that window as well.
    if (entry.exited || entry.proc.exitCode !== null) {
      return errorTurn(session.id, "child_exited", "subprocess has already exited");
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
    // Re-check after the flush: the write may have succeeded locally but
    // the child could have exited while we awaited. Check both the flag
    // and the direct exitCode to close the microtask race.
    if (entry.exited || entry.proc.exitCode !== null) {
      return errorTurn(session.id, "child_exited", "subprocess exited during send");
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

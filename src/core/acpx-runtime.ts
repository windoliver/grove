/**
 * AcpxRuntime — AgentRuntime implementation backed by the `acpx` CLI.
 *
 * acpx provides stateful, multi-turn agent sessions (codex, claude, gemini).
 * Each session is a persistent conversation that survives restarts.
 *
 * When acpx is not installed this runtime gracefully reports unavailable
 * and all operations become safe no-ops or throw clear errors.
 */

import { execSync, spawn as nodeSpawn } from "node:child_process";
import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";

/** Default agent backend used by acpx when none is specified. */
const DEFAULT_AGENT = "codex";

interface AcpxSessionEntry {
  session: AgentSession;
  agent: string;
  sessionName: string;
  cwd: string;
  env: Record<string, string | undefined>;
  idleCallbacks: (() => void)[];
  idleTimer: ReturnType<typeof setInterval> | null;
  /** Active child process for the current prompt (null when idle). */
  activeProc: ReturnType<typeof nodeSpawn> | null;
}

export class AcpxRuntime implements AgentRuntime {
  private sessions: Map<string, AcpxSessionEntry> = new Map();
  private nextId = 0;

  /** Which acpx agent backend to use (codex, claude, gemini). */
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
    const sessionName = `grove-${role}-${counter}-${Date.now().toString(36)}`;
    const id = sessionName;
    const mergedEnv = config.env ? { ...process.env, ...config.env } : { ...process.env };

    // Create a new acpx session
    const cmd = `acpx ${shellEscape(this.agent)} sessions new --name ${shellEscape(sessionName)}`;
    try {
      execSync(cmd, { encoding: "utf-8", stdio: "pipe", cwd: config.cwd, env: mergedEnv });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[AcpxRuntime] spawn failed: ${msg}\n  cmd: ${cmd}\n  cwd: ${config.cwd}\n`,
      );
      throw new Error(`acpx session creation failed for role "${role}": ${msg}`);
    }
    process.stderr.write(`[AcpxRuntime] created session ${sessionName} in ${config.cwd}\n`);

    const session: AgentSession = { id, role, status: "running" };
    const entry: AcpxSessionEntry = {
      session,
      agent: this.agent,
      sessionName,
      cwd: config.cwd,
      env: mergedEnv,
      idleCallbacks: [],
      idleTimer: null,
      activeProc: null,
    };
    this.sessions.set(id, entry);

    // Send initial prompt unless this role waits for push (e.g., reviewer waits for coder)
    if (!config.waitForPush) {
      const initialMessage = config.goal ?? config.prompt;
      if (initialMessage) {
        this.sendAsync(entry, initialMessage);
      }
    }

    return session;
  }

  /**
   * Fire-and-forget send: spawns acpx in the background.
   * When the prompt completes, fires idle callbacks.
   */
  private sendAsync(entry: AcpxSessionEntry, message: string): void {
    entry.session = { ...entry.session, status: "running" };

    process.stderr.write(
      `[AcpxRuntime] sendAsync to ${entry.sessionName}: ${message.slice(0, 80)}...\n`,
    );

    const child = nodeSpawn("acpx", [entry.agent, "-s", entry.sessionName, message], {
      cwd: entry.cwd,
      env: entry.env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    entry.activeProc = child;

    // Capture stderr for debugging
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      entry.activeProc = null;
      if (code === 0) {
        process.stderr.write(`[AcpxRuntime] ${entry.sessionName} completed successfully\n`);
        entry.session = { ...entry.session, status: "idle" };
        for (const cb of entry.idleCallbacks) {
          try {
            cb();
          } catch {
            /* ignore */
          }
        }
      } else {
        process.stderr.write(
          `[AcpxRuntime] ${entry.sessionName} exited with code ${code}\n${stderr}\n`,
        );
        entry.session = { ...entry.session, status: "crashed" };
      }
    });

    child.on("error", (err) => {
      entry.activeProc = null;
      process.stderr.write(`[AcpxRuntime] ${entry.sessionName} spawn error: ${err.message}\n`);
      entry.session = { ...entry.session, status: "crashed" };
    });
  }

  async send(session: AgentSession, message: string): Promise<void> {
    const entry = this.sessions.get(session.id);
    if (!entry) return;
    this.sendAsync(entry, message);
  }

  async close(session: AgentSession): Promise<void> {
    const entry = this.sessions.get(session.id);
    if (entry?.idleTimer) {
      clearInterval(entry.idleTimer);
    }
    // Kill active prompt if running
    if (entry?.activeProc) {
      entry.activeProc.kill();
      entry.activeProc = null;
    }

    try {
      if (entry) {
        execSync(
          `acpx ${shellEscape(entry.agent)} sessions close ${shellEscape(entry.sessionName)}`,
          { encoding: "utf-8", stdio: "pipe", cwd: entry.cwd, env: entry.env as NodeJS.ProcessEnv },
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
      const output = execSync(`acpx ${shellEscape(this.agent)} sessions list`, {
        encoding: "utf-8",
        stdio: "pipe",
      });

      const lines = output.trim().split("\n").filter(Boolean);
      const result: AgentSession[] = [];

      for (const entry of this.sessions.values()) {
        result.push(entry.session);
      }

      for (const line of lines) {
        const name = line.trim();
        if (name.startsWith("grove-") && !this.sessions.has(name)) {
          const role = name.slice(6).replace(/-\d+$/, "");
          result.push({ id: name, role, status: "idle" });
        }
      }

      return result;
    } catch {
      return [...this.sessions.values()].map((e) => e.session);
    }
  }

  /** Poll-based idle detection fallback. */
  private checkIdle(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    if (entry.session.status === "running" && !entry.activeProc) {
      entry.session = { ...entry.session, status: "idle" };
      for (const cb of entry.idleCallbacks) {
        try {
          cb();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** Escape a string for safe use in shell commands. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

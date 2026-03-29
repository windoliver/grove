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
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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
  outputCallbacks: ((chunk: string) => void)[];
  idleTimer: ReturnType<typeof setInterval> | null;
  /** Active child process for the current prompt (null when idle). */
  activeProc: ReturnType<typeof nodeSpawn> | null;
  /** Log file path for agent output (debug/streaming). */
  logFile: string | null;
}

export class AcpxRuntime implements AgentRuntime {
  private sessions: Map<string, AcpxSessionEntry> = new Map();
  private nextId = 0;

  /** Which acpx agent backend to use (codex, claude, gemini). */
  private readonly agent: string;

  /** How often (ms) to poll for idle detection. */
  private readonly idlePollMs: number;

  /** Directory for per-agent log files. */
  private readonly logDir: string | undefined;

  constructor(options?: { agent?: string; idlePollMs?: number; logDir?: string }) {
    this.agent = options?.agent ?? DEFAULT_AGENT;
    this.idlePollMs = options?.idlePollMs ?? 5000;
    this.logDir = options?.logDir;
    if (this.logDir) {
      try {
        mkdirSync(this.logDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
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

    // Create a new acpx session with --approve-all (layer 1: acpx client-side auto-approve)
    const createCmd = `acpx --approve-all ${shellEscape(this.agent)} sessions new --name ${shellEscape(sessionName)}`;
    try {
      execSync(createCmd, { encoding: "utf-8", stdio: "pipe", cwd: config.cwd, env: mergedEnv });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`acpx session creation failed for role "${role}": ${msg}`);
    }

    // Set full-access mode (layer 2: codex internal approval policy = never prompt)
    try {
      execSync(
        `acpx --approve-all ${shellEscape(this.agent)} set-mode full-access -s ${shellEscape(sessionName)}`,
        { encoding: "utf-8", stdio: "pipe", cwd: config.cwd, env: mergedEnv, timeout: 10_000 },
      );
    } catch {
      // Non-fatal — some agents may not support set-mode (claude, gemini)
    }

    const session: AgentSession = { id, role, status: "running" };
    const logFile = this.logDir ? join(this.logDir, `${role}-${counter}.log`) : null;
    const entry: AcpxSessionEntry = {
      session,
      agent: this.agent,
      sessionName,
      cwd: config.cwd,
      env: mergedEnv,
      idleCallbacks: [],
      outputCallbacks: [],
      idleTimer: null,
      activeProc: null,
      logFile,
    };
    this.sessions.set(id, entry);

    // Write initial log header
    if (logFile) {
      const header = `[${new Date().toISOString()}] === Session ${sessionName} (role: ${role}) ===\n`;
      try {
        appendFileSync(logFile, header);
      } catch {
        /* ignore */
      }
    }

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
   * Streams stdout to output callbacks + log file.
   * When the prompt completes, fires idle callbacks.
   */
  private sendAsync(entry: AcpxSessionEntry, message: string): void {
    entry.session = { ...entry.session, status: "running" };

    // Wrap message with system-reminder that enforces MCP tool usage
    // (Relay pattern: agents "forget" tools without per-message reinforcement)
    const wrappedMessage = `<system-reminder>
SUBMITTING WORK (2 steps — do NOT skip step 1):
1. grove_cas_put({ content: "<file content>" }) → returns { hash: "blake3:..." }
2. grove_submit_work({ summary: "what you did", artifacts: {"file.ts": "blake3:..."}, agent: { role: "${entry.session.role}" } })

SUBMITTING REVIEWS:
grove_submit_review({ targetCid: "blake3:...", summary: "feedback", scores: {"correctness": {"value": 0.9, "direction": "maximize"}}, agent: { role: "${entry.session.role}" } })

Without calling these tools, other agents cannot see your work.

CRITICAL RULES ABOUT grove_done:
- grove_done ends the ENTIRE session. Do NOT call it prematurely.
- If you are a CODER: After calling grove_submit_work, STOP and WAIT. NEVER call grove_done yourself.
- If you are a REVIEWER and you are REQUESTING CHANGES: After calling grove_submit_review, STOP and WAIT for the coder to fix.
- If you are a REVIEWER and you are APPROVING: Call grove_submit_review, THEN call grove_done immediately in the same turn. This ends the session.
</system-reminder>
${message}`;

    // Log the outgoing prompt
    if (entry.logFile) {
      const ts = new Date().toISOString();
      try {
        appendFileSync(
          entry.logFile,
          `\n[${ts}] >>> PROMPT >>>\n${message}\n[${ts}] <<< END PROMPT <<<\n`,
        );
      } catch {
        /* ignore */
      }
    }

    const child = nodeSpawn(
      "acpx",
      ["--approve-all", entry.agent, "-s", entry.sessionName, wrappedMessage],
      {
        cwd: entry.cwd,
        env: entry.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    entry.activeProc = child;

    // Stream stdout to output callbacks + log file
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      // Write to log file
      if (entry.logFile) {
        try {
          appendFileSync(entry.logFile, text);
        } catch {
          /* ignore */
        }
      }
      // Forward to output callbacks
      for (const cb of entry.outputCallbacks) {
        try {
          cb(text);
        } catch {
          /* ignore */
        }
      }
    });

    // Capture stderr to log file
    child.stderr?.on("data", (chunk: Buffer) => {
      if (entry.logFile) {
        try {
          appendFileSync(entry.logFile, `[stderr] ${chunk.toString()}`);
        } catch {
          /* ignore */
        }
      }
    });

    child.on("close", (code) => {
      entry.activeProc = null;
      const ts = new Date().toISOString();
      if (code === 0) {
        entry.session = { ...entry.session, status: "idle" };
        if (entry.logFile) {
          try {
            appendFileSync(entry.logFile, `\n[${ts}] === IDLE (exit 0) ===\n`);
          } catch {
            /* ignore */
          }
        }
        for (const cb of entry.idleCallbacks) {
          try {
            cb();
          } catch {
            /* ignore */
          }
        }
      } else {
        entry.session = { ...entry.session, status: "crashed" };
        if (entry.logFile) {
          try {
            appendFileSync(entry.logFile, `\n[${ts}] === CRASHED (exit ${code}) ===\n`);
          } catch {
            /* ignore */
          }
        }
      }
    });

    child.on("error", (err) => {
      entry.activeProc = null;
      entry.session = { ...entry.session, status: "crashed" };
      if (entry.logFile) {
        try {
          appendFileSync(entry.logFile, `\n[ERROR] ${err.message}\n`);
        } catch {
          /* ignore */
        }
      }
    });
  }

  async send(session: AgentSession, message: string): Promise<void> {
    let entry = this.sessions.get(session.id);
    // For reattached sessions (not spawned by this runtime), create a minimal entry
    if (!entry) {
      entry = {
        session,
        agent: this.agent,
        sessionName: session.id,
        cwd: process.cwd(),
        env: { ...process.env },
        idleCallbacks: [],
        outputCallbacks: [],
        idleTimer: null,
        activeProc: null,
        logFile: this.logDir ? join(this.logDir, `${session.role}-reattach.log`) : null,
      };
      this.sessions.set(session.id, entry);
    }
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

  onOutput(session: AgentSession, callback: (chunk: string) => void): void {
    const entry = this.sessions.get(session.id);
    if (!entry) return;
    entry.outputCallbacks.push(callback);
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
        // acpx output: UUID\tname\tpath\ttimestamp (tab-separated)
        const fields = line.split("\t");
        const name = (fields[1] ?? line).trim();
        const isClosed = line.includes("[closed]");
        if (name.startsWith("grove-") && !this.sessions.has(name) && !isClosed) {
          const role = name.replace(/^grove-/, "").replace(/-\d+-.*$/, "");
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

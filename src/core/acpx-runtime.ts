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

function appendLog(msg: string): void {
  try {
    appendFileSync("/tmp/grove-debug.log", `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

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
      const out = execSync("acpx --version", { encoding: "utf-8", stdio: "pipe" }).trim();
      // acpx >=0.5.3 is required: 0.3.x uses the buggy @zed-industries/claude-agent-acp
      // adapter that fails session/new with "Query closed before response received".
      // 0.5.x switched to @agentclientprotocol/claude-agent-acp which works.
      const match = /^(\d+)\.(\d+)\.(\d+)/.exec(out);
      if (!match) return true; // unparseable — don't block
      const [, maj, min, patch] = match;
      const major = Number(maj);
      const minor = Number(min);
      const patchNum = Number(patch);
      if (major > 0) return true;
      if (minor > 5) return true;
      if (minor === 5 && patchNum >= 3) return true;
      process.stderr.write(
        `[acpx-runtime] acpx ${out} is too old — grove requires acpx >=0.5.3. ` +
          `Upgrade with: npm install -g acpx@latest\n`,
      );
      return false;
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

    // Strip Claude Code harness env vars before spawning the subagent.
    //
    // When grove runs inside a Claude Code shell (CLAUDECODE=1), any inner
    // `claude` subprocess detects that flag and connects back to the parent
    // Claude Code harness via its IPC channel instead of launching a fresh
    // session. The inner agent then inherits the parent's tool surface
    // (ToolSearch, EnterWorktree, mcp__MaaS-*, etc.) and — critically — does
    // NOT load the workspace's `.mcp.json` / `.acpxrc.json` grove MCP server.
    //
    // Unset every CLAUDE_CODE_* / CLAUDECODE / CLAUDE_PLUGIN_* var so acpx
    // launches a pristine agent that reads its MCP config from the workspace.
    const baseEnv = { ...process.env };
    for (const key of Object.keys(baseEnv)) {
      if (
        key === "CLAUDECODE" ||
        key.startsWith("CLAUDE_CODE_") ||
        key.startsWith("CLAUDE_PLUGIN_")
      ) {
        delete baseEnv[key];
      }
    }
    const mergedEnv = config.env ? { ...baseEnv, ...config.env } : baseEnv;

    // Extract the agent binary name from config.command (e.g. "claude --flag" → "claude").
    // acpx takes the agent name as a subcommand; flags and the initial prompt go through
    // the session creation path, not the `acpx <agent>` argument.
    //
    // Only known acpx subcommands are accepted (claude/codex/gemini/pi/openclaw). Any
    // other first token (including shell builtins like `echo` used in tests) falls back
    // to the runtime-level default so we never pass acpx an unknown agent name.
    const KNOWN_ACPX_AGENTS = new Set(["claude", "codex", "gemini", "pi", "openclaw"]);
    const agent = (() => {
      if (!config.command) return this.agent;
      const stripped = config.command.replace(/^rm\s+[^;]+;\s*/, ""); // drop leading "rm -f ~/..." hooks
      const first = stripped.trim().split(/\s+/)[0] ?? "";
      return KNOWN_ACPX_AGENTS.has(first) ? first : this.agent;
    })();

    // Create a new acpx session with --approve-all (layer 1: acpx client-side auto-approve)
    const createCmd = `acpx --approve-all ${shellEscape(agent)} sessions new --name ${shellEscape(sessionName)}`;
    try {
      execSync(createCmd, { encoding: "utf-8", stdio: "pipe", cwd: config.cwd, env: mergedEnv });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`acpx session creation failed for role "${role}" (agent=${agent}): ${msg}`);
    }

    // Set full-access mode (layer 2: codex internal approval policy = never prompt)
    try {
      execSync(
        `acpx --approve-all ${shellEscape(agent)} set-mode full-access -s ${shellEscape(sessionName)}`,
        { encoding: "utf-8", stdio: "pipe", cwd: config.cwd, env: mergedEnv, timeout: 10_000 },
      );
    } catch {
      // Non-fatal — some agents may not support set-mode (claude, gemini)
    }

    const session: AgentSession = { id, role, status: "running" };
    const logFile = this.logDir ? join(this.logDir, `${role}-${counter}.log`) : null;
    const entry: AcpxSessionEntry = {
      session,
      agent,
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
    appendLog(
      `[acpx.sendAsync] sessionName=${entry.sessionName} role=${entry.session.role} logFile=${entry.logFile} agent=${entry.agent} cwd=${entry.cwd}`,
    );
    entry.session = { ...entry.session, status: "running" };

    // Wrap message with system-reminder that enforces MCP tool usage
    // (Relay pattern: agents "forget" tools without per-message reinforcement)
    const wrappedMessage = `<system-reminder>
SUBMITTING WORK:
1. Edit files, then: git add -A && git commit -m "description"
2. Get hash: git rev-parse HEAD
3. grove_submit_work({ summary: "what you did", commitHash: "<hash>", agent: { role: "${entry.session.role}" } })

REVIEWING WORK:
1. When notified: read files from the Workspace path in the notification (e.g., cat /path/to/coder-workspace/app.js)
2. Review the actual code at that path
3. grove_submit_review({ targetCid: "<cid from notification>", summary: "feedback", scores: {"correctness": {"value": 0.9, "direction": "maximize"}}, agent: { role: "${entry.session.role}" } })

Without calling these tools, other agents cannot see your work.

RULES ABOUT grove_done:
- grove_done ends the ENTIRE session. Do NOT call it prematurely.
- CODER: After grove_submit_work, STOP and WAIT. NEVER call grove_done.
- REVIEWER requesting changes: After grove_submit_review, STOP and WAIT.
- REVIEWER approving: Call grove_submit_review, THEN grove_done. This ends the session.
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

    appendLog(
      `[acpx.sendAsync] spawning: acpx --approve-all ${entry.agent} -s ${entry.sessionName} <message len=${wrappedMessage.length}>`,
    );
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
    child.on("spawn", () => {
      appendLog(
        `[acpx.sendAsync] child spawned OK pid=${child.pid} for sessionName=${entry.sessionName}`,
      );
    });
    child.on("error", (spawnErr) => {
      appendLog(
        `[acpx.sendAsync] child error: ${spawnErr.message} for sessionName=${entry.sessionName}`,
      );
    });

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
      appendLog(`[acpx.sendAsync] child closed exit=${code} sessionName=${entry.sessionName}`);
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
    appendLog(
      `[acpx.send] called for sessionId=${session.id} role=${session.role} status=${session.status} sessionsMapSize=${this.sessions.size} sessionIds=[${[...this.sessions.keys()].join(",")}]`,
    );
    let entry = this.sessions.get(session.id);
    // For reattached sessions (not spawned by this runtime), create a minimal entry
    if (!entry) {
      appendLog(
        `[acpx.send] sessionId=${session.id} NOT in sessions map → creating reattach entry`,
      );
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
    } else {
      appendLog(
        `[acpx.send] sessionId=${session.id} FOUND in sessions map, logFile=${entry.logFile}, sessionName=${entry.sessionName}`,
      );
    }
    appendLog(
      `[acpx.send] calling sendAsync for sessionId=${session.id} sessionName=${entry.sessionName}`,
    );
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

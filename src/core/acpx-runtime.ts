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
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AcpxTurnImpl } from "../acp/turn.js";
import type { AcpxTurn } from "../acp/types.js";
import { watchTurnError } from "../acp/watch-turn.js";
import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";
import { buildSessionId, parseAcpxSessionId, SESSION_ID_PREFIX } from "./session-id.js";
import { shellEscape } from "./shell-utils.js";
import type { AgentPlatformType } from "./topology.js";

function appendLog(msg: string): void {
  try {
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync("/tmp/grove-debug.log", `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

/** Default agent backend used by acpx when none is specified. */
const DEFAULT_AGENT = "codex";

/** Known acpx agent subcommands. */
export const KNOWN_ACPX_AGENTS: Set<string> = new Set([
  "claude",
  "codex",
  "gemini",
  "pi",
  "openclaw",
]);

/** Maps AgentPlatformType to the acpx agent subcommand. */
export const PLATFORM_TO_AGENT: Record<AgentPlatformType, string> = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
  custom: "codex", // custom falls back to default
};

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
  /**
   * Resolves when `activeProc` has exited (not just when the turn's result
   * frame arrived). Set inside startTurn and resolved by the child's
   * close/error handler. Read-only outside startTurn; send() uses
   * `sendChainTail` for serialization instead of awaiting this directly.
   */
  inflightTurn: Promise<void> | null;
  /**
   * Tail of the per-session send chain. Each incoming send() call appends
   * a new promise to this chain and awaits the predecessor, so N concurrent
   * send() callers are serialized into N sequential turns. Using a single
   * `await inflightTurn` gate would let every concurrent caller pass the
   * gate simultaneously when the predecessor resolved, and they would all
   * call startTurn at once — reintroducing overlapping acpx children.
   */
  sendChainTail: Promise<void> | null;
  /** Log write stream (opened at session creation, closed on session close). */
  logStream: import("node:fs").WriteStream | null;
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

  /** Cached availability result (acpx doesn't get uninstalled mid-session). */
  private cachedAvailable: boolean | undefined;

  /** Set of distinct agent backends that have been spawned (for multi-agent listSessions). */
  private readonly spawnedAgents: Set<string> = new Set();

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
    if (this.cachedAvailable !== undefined) return this.cachedAvailable;

    try {
      const out = execSync("acpx --version", { encoding: "utf-8", stdio: "pipe" }).trim();
      // acpx >=0.5.3 is required: 0.3.x uses the buggy @zed-industries/claude-agent-acp
      // adapter that fails session/new with "Query closed before response received".
      // 0.5.x switched to @agentclientprotocol/claude-agent-acp which works.
      const match = /^(\d+)\.(\d+)\.(\d+)/.exec(out);
      if (!match) {
        this.cachedAvailable = true;
        return true; // unparseable — don't block
      }
      const [, maj, min, patch] = match;
      const major = Number(maj);
      const minor = Number(min);
      const patchNum = Number(patch);
      if (major > 0 || minor > 5 || (minor === 5 && patchNum >= 3)) {
        this.cachedAvailable = true;
        return true;
      }
      process.stderr.write(
        `[acpx-runtime] acpx ${out} is too old — grove requires acpx >=0.5.3. ` +
          `Upgrade with: npm install -g acpx@latest\n`,
      );
      this.cachedAvailable = false;
      return false;
    } catch {
      this.cachedAvailable = false;
      return false;
    }
  }

  /**
   * Resolve the acpx agent backend for a spawn request.
   *
   * Priority: config.platform → parsed config.command → constructor default.
   */
  resolveAgent(config: AgentConfig): string {
    // 1. Explicit platform takes precedence
    if (config.platform) {
      const mapped = PLATFORM_TO_AGENT[config.platform];
      if (mapped && KNOWN_ACPX_AGENTS.has(mapped)) return mapped;
    }

    // 2. Fallback: parse agent name from command string (backward compat)
    if (config.command) {
      const stripped = config.command.replace(/^rm\s+[^;]+;\s*/, ""); // drop leading "rm -f ~/..." hooks
      const first = stripped.trim().split(/\s+/)[0] ?? "";
      if (KNOWN_ACPX_AGENTS.has(first)) return first;
    }

    // 3. Constructor-level default
    return this.agent;
  }

  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    if (!(await this.isAvailable())) {
      throw new Error("acpx is not installed or not in PATH");
    }

    const counter = this.nextId++;
    const sessionName = buildSessionId(role, counter);
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

    // Export platform/model as env vars so agent identity resolution picks them up
    if (config.platform) mergedEnv.GROVE_AGENT_PLATFORM = config.platform;
    if (config.model) mergedEnv.GROVE_AGENT_MODEL = config.model;

    // Resolve agent backend via platform → command → default chain
    const agent = this.resolveAgent(config);

    // Track this agent type for multi-backend listSessions
    this.spawnedAgents.add(agent);

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

    const session: AgentSession = {
      id,
      role,
      status: "running",
      platform: config.platform,
      model: config.model,
      agent,
    };
    const logFile = this.logDir ? join(this.logDir, `${role}-${counter}.log`) : null;
    let logStream: import("node:fs").WriteStream | null = null;
    if (logFile) {
      logStream = createWriteStream(logFile, { flags: "a" });
      logStream.write(
        `[${new Date().toISOString()}] === Session ${sessionName} (role: ${role}, agent: ${agent}, platform: ${config.platform ?? "unset"}, model: ${config.model ?? "unset"}) ===\n`,
      );
    }

    const entry: AcpxSessionEntry = {
      session,
      agent,
      sessionName,
      cwd: config.cwd,
      env: mergedEnv,
      idleCallbacks: [],
      idleTimer: null,
      activeProc: null,
      inflightTurn: null,
      sendChainTail: null,
      logStream,
      logFile,
    };
    this.sessions.set(id, entry);

    // Send initial prompt unless this role waits for push (e.g., reviewer waits for coder)
    if (!config.waitForPush) {
      const initialMessage = config.goal ?? config.prompt;
      if (initialMessage) {
        // Fire initial turn. Callers don't see this AcpxTurn (future turns
        // reach them via send()), so watch its result ourselves and log any
        // terminal error — otherwise bootstrap failures (malformed frames,
        // provider rejection, cancelled turn) would be silently swallowed
        // and the session would look successfully primed.
        const initialTurn = this.startTurn(entry, initialMessage);
        // Seed the send chain with the bootstrap turn's child-exit promise
        // so the first external send() waits for the initial goal to finish
        // instead of spawning a second overlapping acpx child.
        entry.sendChainTail = entry.inflightTurn;
        watchTurnError(initialTurn, `acpx spawn(role=${role})`, (msg) => {
          process.stderr.write(`${msg}\n`);
          if (entry.logStream) {
            entry.logStream.write(`${msg}\n`);
          }
        });
      }
    }

    return session;
  }

  /**
   * Fire a prompt and return a streaming AcpxTurn. Spawns acpx with
   * `--format json --json-strict` so stdout is NDJSON typed frames; the
   * returned turn wraps the child's stdout in AcpxTurnImpl. The log file
   * still mirrors stdout for forensics.
   */
  private startTurn(entry: AcpxSessionEntry, message: string): AcpxTurn {
    const turnId = `${entry.sessionName}-${Date.now().toString(36)}-${this.nextId++}`;
    appendLog(
      `[acpx.startTurn] sessionName=${entry.sessionName} role=${entry.session.role} logFile=${entry.logFile} agent=${entry.agent} cwd=${entry.cwd} turnId=${turnId}`,
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
    if (entry.logStream) {
      const ts = new Date().toISOString();
      entry.logStream.write(`\n[${ts}] >>> PROMPT >>>\n${message}\n[${ts}] <<< END PROMPT <<<\n`);
    }

    appendLog(
      `[acpx.startTurn] spawning: acpx --format json --json-strict --approve-all ${entry.agent} -s ${entry.sessionName} <message len=${wrappedMessage.length}>`,
    );
    const child = nodeSpawn(
      "acpx",
      [
        "--format",
        "json",
        "--json-strict",
        "--approve-all",
        entry.agent,
        "-s",
        entry.sessionName,
        wrappedMessage,
      ],
      {
        cwd: entry.cwd,
        env: entry.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    entry.activeProc = child;
    let markExited: () => void = () => undefined;
    entry.inflightTurn = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    child.on("spawn", () => {
      appendLog(
        `[acpx.startTurn] child spawned OK pid=${child.pid} for sessionName=${entry.sessionName}`,
      );
    });
    child.on("error", (spawnErr) => {
      appendLog(
        `[acpx.startTurn] child error: ${spawnErr.message} for sessionName=${entry.sessionName}`,
      );
    });

    // Mirror stdout to log file for forensics. AcpxTurnImpl installs its own
    // 'data' listener via AcpParser; Readable fans out to all listeners so
    // both observers see every chunk.
    if (entry.logStream && child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => entry.logStream?.write(chunk));
    }
    if (entry.logStream && child.stderr) {
      child.stderr.on("data", (chunk: Buffer) =>
        entry.logStream?.write(`[stderr] ${chunk.toString()}`),
      );
    }

    child.on("close", (code) => {
      appendLog(`[acpx.startTurn] child closed exit=${code} sessionName=${entry.sessionName}`);
      entry.activeProc = null;
      entry.inflightTurn = null;
      markExited();
      const ts = new Date().toISOString();
      if (code === 0) {
        entry.session = { ...entry.session, status: "idle" };
        if (entry.logStream) {
          entry.logStream.write(`\n[${ts}] === IDLE (exit 0) ===\n`);
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
        if (entry.logStream) {
          entry.logStream.write(`\n[${ts}] === CRASHED (exit ${code}) ===\n`);
        }
      }
    });

    child.on("error", (err) => {
      entry.activeProc = null;
      entry.inflightTurn = null;
      markExited();
      entry.session = { ...entry.session, status: "crashed" };
      if (entry.logStream) {
        entry.logStream.write(`\n[ERROR] ${err.message}\n`);
      }
    });

    if (!child.stdout) {
      throw new Error("acpx child spawned without stdout pipe");
    }

    return new AcpxTurnImpl({
      sessionId: entry.sessionName,
      turnId,
      stdout: child.stdout,
      cancelFn: async () => {
        // ACP session/cancel is not wired through acpx CLI args; SIGINT the
        // child so the provider sees a cancelled turn. Safe re-entry: cancel()
        // is single-flight inside AcpxTurnImpl.
        try {
          child.kill("SIGINT");
        } catch {
          /* ignore */
        }
      },
    });
  }

  async send(session: AgentSession, message: string): Promise<AcpxTurn> {
    appendLog(
      `[acpx.send] called for sessionId=${session.id} role=${session.role} status=${session.status} sessionsMapSize=${this.sessions.size} sessionIds=[${[...this.sessions.keys()].join(",")}]`,
    );
    let entry = this.sessions.get(session.id);
    // For reattached sessions (not spawned by this runtime), create a minimal entry
    if (!entry) {
      appendLog(
        `[acpx.send] sessionId=${session.id} NOT in sessions map → creating reattach entry`,
      );
      // Use session metadata if available, fall back to runtime default
      const agent = session.agent ?? this.agent;
      this.spawnedAgents.add(agent);
      entry = {
        session,
        agent,
        sessionName: session.id,
        cwd: process.cwd(),
        env: { ...process.env },
        idleCallbacks: [],
        idleTimer: null,
        activeProc: null,
        inflightTurn: null,
        sendChainTail: null,
        logStream: null,
        logFile: this.logDir ? join(this.logDir, `${session.role}-reattach.log`) : null,
      };
      if (entry.logFile) {
        entry.logStream = createWriteStream(entry.logFile, { flags: "a" });
      }
      this.sessions.set(session.id, entry);
    } else {
      appendLog(
        `[acpx.send] sessionId=${session.id} FOUND in sessions map, logFile=${entry.logFile}, sessionName=${entry.sessionName}`,
      );
    }
    // Serialize concurrent send() callers into a sequential chain so only
    // one acpx child exists per session at any time. We CANNOT use a bare
    // `await entry.inflightTurn` here: N concurrent callers all awaiting
    // the same promise would all pass the gate simultaneously once the
    // predecessor resolved, and each would start its own acpx child —
    // overlapping NDJSON streams, cancel()/close() targeting only the
    // newest. Instead, each call installs its own "my turn is done" promise
    // as the chain tail before awaiting the predecessor, so later arrivals
    // wait on us, not on the same promise we waited on.
    const predecessor = entry.sendChainTail ?? Promise.resolve();
    let releaseChain: () => void = () => undefined;
    const myCompletion = new Promise<void>((resolve) => {
      releaseChain = resolve;
    });
    entry.sendChainTail = myCompletion;

    try {
      await predecessor;
    } catch {
      // Predecessor rejected — treat as released so we don't deadlock.
    }

    // After the wait, close() may have run concurrently: killed the prior
    // child, closed the acpx session, and deleted the map entry. Re-check
    // before launching a new child, otherwise a queued send would spawn
    // acpx against a session the caller has already stopped.
    const current = this.sessions.get(session.id);
    if (!current || current !== entry || current.session.status === "stopped") {
      appendLog(
        `[acpx.send] sessionId=${session.id} session was stopped/replaced during chain wait — refusing to start new turn`,
      );
      releaseChain();
      return {
        sessionId: session.id,
        turnId: `${session.id}-closed`,
        messages: (async function* () {
          /* no messages */
        })(),
        result: Promise.resolve({
          turnId: `${session.id}-closed`,
          stopReason: "error" as const,
          error: {
            code: "session_closed",
            message: "session was closed before send could start a new turn",
          },
        }),
        cancel: async () => undefined,
        close: async () => undefined,
      };
    }

    appendLog(
      `[acpx.send] calling startTurn for sessionId=${session.id} sessionName=${entry.sessionName}`,
    );
    // Exception safety: if startTurn throws synchronously (malformed args,
    // spawn path errors, null-byte content, etc.), we must still release
    // the chain — otherwise every subsequent send() for this session would
    // wait forever on an orphan predecessor promise that nobody resolves.
    let turn: AcpxTurn;
    try {
      turn = this.startTurn(entry, message);
    } catch (err) {
      releaseChain();
      const errTurnId = `${entry.sessionName}-start-failed`;
      return {
        sessionId: entry.sessionName,
        turnId: errTurnId,
        messages: (async function* () {
          /* no messages */
        })(),
        result: Promise.resolve({
          turnId: errTurnId,
          stopReason: "error" as const,
          error: {
            code: "startTurn_threw",
            message: err instanceof Error ? err.message : String(err),
          },
        }),
        cancel: async () => undefined,
        close: async () => undefined,
      };
    }
    // Release the next queued send when this turn's child exits. Use
    // inflightTurn (set by startTurn and resolved by the child close/error
    // handler) so successors wait on the actual process lifecycle, not
    // just on message-iterator consumption.
    const inflight = entry.inflightTurn ?? Promise.resolve();
    void inflight.finally(() => releaseChain());
    return turn;
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
      // Close log stream
      if (entry.logStream) {
        entry.logStream.end();
        entry.logStream = null;
      }
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

  /**
   * List sessions tracked in-memory. For discovering orphaned sessions
   * from previous runs, use `discoverSessions()`.
   */
  async listSessions(): Promise<readonly AgentSession[]> {
    // Short-circuit: return in-memory sessions if we have any tracked
    if (this.sessions.size > 0) {
      return [...this.sessions.values()].map((e) => e.session);
    }

    // No in-memory sessions — fall back to discovery
    return this.discoverSessions();
  }

  /**
   * Discover sessions across all known agent backends via the acpx CLI.
   * Used for reattach scenarios where sessions may exist from a prior run.
   */
  async discoverSessions(): Promise<readonly AgentSession[]> {
    if (!(await this.isAvailable())) {
      return [];
    }

    // Query all agents: the default + any that have been spawned
    const agentsToQuery = new Set([this.agent, ...this.spawnedAgents, ...KNOWN_ACPX_AGENTS]);
    const result: AgentSession[] = [];
    const seenIds = new Set<string>();

    // Include all in-memory sessions first
    for (const entry of this.sessions.values()) {
      result.push(entry.session);
      seenIds.add(entry.session.id);
    }

    // Query each agent backend for grove sessions
    for (const agentName of agentsToQuery) {
      try {
        const output = execSync(`acpx ${shellEscape(agentName)} sessions list`, {
          encoding: "utf-8",
          stdio: "pipe",
        });

        const lines = output.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          // acpx output: UUID\tname\tpath\ttimestamp (tab-separated)
          const fields = line.split("\t");
          const name = (fields[1] ?? line).trim();
          const isClosed = line.includes("[closed]");
          if (name.startsWith(SESSION_ID_PREFIX) && !seenIds.has(name) && !isClosed) {
            // parseAcpxSessionId accepts the prior single-dash acpx contract
            // so an upgrade still rediscovers agents created on the previous
            // grove version. Source-narrow: safe here because acpx never
            // returns TUI-shaped names.
            const parsed = parseAcpxSessionId(name);
            if (!parsed) continue;
            result.push({ id: name, role: parsed.role, status: "idle", agent: agentName });
            seenIds.add(name);
          }
        }
      } catch {
        // Agent backend may not exist or have no sessions — continue
      }
    }

    return result;
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

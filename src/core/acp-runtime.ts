import { type ChildProcessByStdio, spawn as nodeSpawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import {
  type Client,
  ClientSideConnection,
  ndJsonStream,
  type RequestPermissionRequest,
  type Stream,
} from "@agentclientprotocol/sdk";
import { sessionUpdateToMessage } from "../acp/session-update-mapper.js";
import { AcpTurnImpl } from "../acp/turn-direct.js";
import type { AcpxTurn, Message, Result } from "../acp/types.js";
import { type AcpLaunch, resolveAcpLaunch } from "./acp-launch.js";
import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";
import type { AgentSessionEntity } from "./entity.js";
import { agentSessionToEntity } from "./entity.js";
import { DENY_ALL_RESOLVER, type PermissionResolver } from "./permission-resolver.js";
import { buildSessionId } from "./session-id.js";

export interface LaunchResult {
  readonly clientStream: Stream;
  readonly dispose: () => Promise<void>;
}

export type LaunchOverride = (
  agent: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
) => Promise<LaunchResult>;

export interface AcpRuntimeOptions {
  readonly permissionResolver?: PermissionResolver;
  readonly fsAuditor?: (op: "read" | "write", path: string, sessionId: string) => void;
  readonly logDir?: string;
  readonly launchOverride?: LaunchOverride;
  readonly eventSink?: AcpRuntimeEventSink;
}

export type AcpRuntimeEvent =
  | {
      readonly kind: "message";
      readonly sessionId: string;
      readonly turnId: string;
      readonly message: Message;
    }
  | {
      readonly kind: "result";
      readonly sessionId: string;
      readonly turnId: string;
      readonly result: Result;
    };

export type AcpRuntimeEventSink = (event: AcpRuntimeEvent) => void;

interface AcpSessionEntry {
  session: AgentSession;
  connection: ClientSideConnection;
  wireSessionId: string;
  dispose: () => Promise<void>;
  idleCallbacks: (() => void)[];
  currentTurn: AcpTurnImpl | null;
  /**
   * Tail of per-session send chain. Each send() appends a promise that
   * awaits its predecessor before starting connection.prompt(), so
   * currentTurn is never overwritten while an earlier prompt is in flight
   * (which would misroute session/update + requestPermission callbacks).
   */
  sendChainTail: Promise<void>;
  closed: boolean;
}

function resolveAgentFromConfig(config: AgentConfig): string {
  if (config.platform === "claude-code") return "claude";
  if (config.platform === "codex") return "codex";
  if (config.platform === "gemini") return "gemini";
  const tokens = config.command.trim().split(/[\s;|&]+/);
  for (const tok of tokens) {
    const base = tok.split("/").pop() ?? tok;
    if (base === "claude" || base === "codex" || base === "gemini") return base;
  }
  return "codex";
}

async function launchSubprocess(
  agent: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: {
    readonly model?: string | undefined;
    readonly command?: string | undefined;
    readonly mcpServers?: AgentConfig["mcpServers"] | undefined;
  } = {},
): Promise<LaunchResult> {
  const launch = resolveAcpLaunch(agent);
  const child = nodeSpawn(launch.command, buildAcpLaunchArgs(launch, opts, env), {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  const stdinWebWritable = NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const stdoutWebReadable = NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const clientStream = ndJsonStream(stdinWebWritable, stdoutWebReadable);

  // Optionally tee child stderr to our stderr with an [acp:agent:pid] prefix
  // so launch failures (auth errors, missing CLI, ACP shim crashes) are
  // observable instead of silently dropped. Gated behind GROVE_DEBUG_ACP=1
  // because: (a) parent stderr is persisted to managed-service log files,
  // so verbose or looping children can grow logs without bound; (b) child
  // stderr can carry repository content or credentials that should not be
  // captured by default. Always read from the pipe (drain) to avoid the
  // OS pipe buffer back-pressuring the child.
  //
  // Implementation notes:
  //   - Stream-decode via TextDecoder so UTF-8 code points split across
  //     chunk boundaries don't get mangled.
  //   - Cap by raw UTF-8 byte count (Buffer.byteLength), not JS string
  //     length (which is UTF-16 code units and undercounts non-BMP).
  //   - Truncate on a line boundary; the trailing partial line after a
  //     truncation is dropped along with everything after it.
  const pid = child.pid ?? 0;
  const teeEnabled = process.env.GROVE_DEBUG_ACP === "1";
  const prefix = `[acp:${agent}:${pid}] `;
  const MAX_BYTES = 1_048_576; // 1 MiB cap per session.
  let bytesWritten = 0;
  let truncationLogged = false;
  let lineCarry = "";
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const writeLine = (line: string): boolean => {
    // Returns false if the cap was hit; caller stops feeding more.
    if (bytesWritten >= MAX_BYTES) return false;
    const out = `${prefix}${line}\n`;
    const outBytes = Buffer.byteLength(out, "utf-8");
    if (bytesWritten + outBytes > MAX_BYTES) {
      bytesWritten = MAX_BYTES;
      return false;
    }
    process.stderr.write(out);
    bytesWritten += outBytes;
    return true;
  };
  child.stderr.on("data", (chunk: Buffer) => {
    if (!teeEnabled) return;
    if (bytesWritten >= MAX_BYTES) return;
    // `stream: true` keeps a partial multi-byte code point pending across
    // chunks instead of emitting a replacement char.
    const text = lineCarry + decoder.decode(chunk, { stream: true });
    const parts = text.split("\n");
    lineCarry = parts.pop() ?? "";
    for (const line of parts) {
      if (line.length === 0) continue;
      if (!writeLine(line) && !truncationLogged) {
        process.stderr.write(`${prefix}[truncated after ${MAX_BYTES} bytes]\n`);
        truncationLogged = true;
        return;
      }
    }
  });
  child.stderr.on("end", () => {
    if (!teeEnabled) return;
    // Flush any trailing partial line that didn't have a newline.
    const tail = lineCarry + decoder.decode();
    lineCarry = "";
    if (tail.length > 0 && bytesWritten < MAX_BYTES) {
      writeLine(tail);
    }
  });

  const dispose = async () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };
  return { clientStream, dispose };
}

/**
 * Build ACP adapter argv from the resolved launch target plus role/runtime
 * overrides. Codex ACP reads model selection from Codex config, not from ACP
 * session metadata, so pass model explicitly when Grove has one.
 */
export function buildAcpLaunchArgs(
  launch: AcpLaunch,
  opts: {
    readonly model?: string | undefined;
    readonly command?: string | undefined;
    readonly mcpServers?: AgentConfig["mcpServers"] | undefined;
  } = {},
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args = [...launch.args];
  if (launch.agent !== "codex") return args;

  const model = (opts.model ?? env.GROVE_CODEX_MODEL)?.trim();
  if (model) {
    args.push("-c", `model=${JSON.stringify(model)}`);
  }

  const allowAll =
    env.GROVE_ALLOW_ALL_PERMISSIONS === "1" ||
    opts.command?.includes("--full-auto") === true ||
    opts.command?.includes("--dangerously-bypass-approvals-and-sandbox") === true;
  if (allowAll) {
    args.push("-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"');
  }
  appendCodexMcpServerOverrides(args, opts.mcpServers);
  return args;
}

const SAFE_TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;
const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH(?:ORIZATION)?)(?:_|$)/i;
const SENSITIVE_ENV_VALUE = /\b(?:sk-[A-Za-z0-9_-]+|sk_[A-Za-z0-9_-]+|grv_[A-Za-z0-9_-]+)\b/;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlKeySegment(segment: string): string {
  return SAFE_TOML_BARE_KEY.test(segment) ? segment : tomlString(segment);
}

function shouldPassMcpEnvViaCodexConfig(name: string, value: string): boolean {
  return !SENSITIVE_ENV_NAME.test(name) && !SENSITIVE_ENV_VALUE.test(value);
}

function appendCodexMcpServerOverrides(
  args: string[],
  mcpServers: AgentConfig["mcpServers"] | undefined,
): void {
  for (const server of mcpServers ?? []) {
    const name = server.name.trim();
    const command = server.command.trim();
    if (!name || !command) continue;

    const serverKey = `mcp_servers.${tomlKeySegment(name)}`;
    args.push("-c", `${serverKey}.command=${tomlString(command)}`);
    args.push("-c", `${serverKey}.args=${tomlStringArray(server.args ?? [])}`);

    const envVars = new Set<string>();
    for (const [envName, envValue] of Object.entries(server.env ?? {})) {
      if (!shouldPassMcpEnvViaCodexConfig(envName, envValue)) {
        if (envName.length > 0) envVars.add(envName);
        continue;
      }
      args.push("-c", `${serverKey}.env.${tomlKeySegment(envName)}=${tomlString(envValue)}`);
    }
    if (envVars.size > 0) {
      args.push("-c", `${serverKey}.env_vars=${tomlStringArray([...envVars])}`);
    }
  }
}

export class AcpRuntime implements AgentRuntime {
  readonly sendsInitialPromptOnSpawn = true;

  private resolver: PermissionResolver;
  private readonly fsAuditor: AcpRuntimeOptions["fsAuditor"];
  private readonly logDir: string | undefined;
  private readonly launchOverride: LaunchOverride | undefined;
  private eventSink: AcpRuntimeEventSink | undefined;
  private readonly sessions: Map<string, AcpSessionEntry> = new Map();
  private nextId = 0;

  /**
   * Optional callback invoked after a session lifecycle transition that
   * matters for the local-mode WatchHub (#388 PR2). Fires on spawn (ADDED),
   * status change (MODIFIED), and close (DELETED). The `LocalRuntime`
   * adapter projects via `agentSessionToEntity` and calls
   * `WatchHub.recordWrite`.
   */
  onSessionWrite?: (op: "ADDED" | "MODIFIED" | "DELETED", s: AgentSession) => void;

  constructor(options: AcpRuntimeOptions = {}) {
    this.resolver = options.permissionResolver ?? DENY_ALL_RESOLVER;
    this.fsAuditor = options.fsAuditor;
    this.logDir = options.logDir;
    this.launchOverride = options.launchOverride;
    this.eventSink = options.eventSink;
  }

  get currentResolver(): PermissionResolver {
    return this.resolver;
  }

  setPermissionResolver(resolver: PermissionResolver): void {
    this.resolver = resolver;
  }

  setAcpEventSink(eventSink: AcpRuntimeEventSink | undefined): void {
    this.eventSink = eventSink;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    const counter = this.nextId++;
    const id = buildSessionId(role, counter);

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
    const mergedEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      ...config.env,
      GROVE_AGENT_ID: id,
      GROVE_AGENT_ROLE: role,
    };
    if (config.platform) mergedEnv.GROVE_AGENT_PLATFORM = config.platform;
    if (config.model) mergedEnv.GROVE_AGENT_MODEL = config.model;

    const agent = resolveAgentFromConfig(config);

    const launched = this.launchOverride
      ? await this.launchOverride(agent, config.cwd, mergedEnv)
      : await launchSubprocess(agent, config.cwd, mergedEnv, {
          model: config.model,
          command: config.command,
          mcpServers: config.mcpServers,
        });

    const client = this.buildClient(id);
    const connection = new ClientSideConnection(() => client, launched.clientStream);

    // Tear down the subprocess if either handshake step throws. Without this,
    // auth failures / protocol mismatches / adapter crashes leave the child
    // process and stdio streams alive after spawn rejects.
    let created: Awaited<ReturnType<typeof connection.newSession>>;
    try {
      await connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      const groveMcpEnv = Object.fromEntries(
        Object.entries(mergedEnv).filter(
          ([key]) => key.startsWith("GROVE_") || key === "NEXUS_API_KEY",
        ),
      ) as Record<string, string>;
      const mcpServers = (config.mcpServers ?? []).map((s) => {
        const inheritedEnv = s.name === "grove" ? groveMcpEnv : {};
        const env = { ...inheritedEnv, ...(s.env ?? {}) };
        return {
          name: s.name,
          command: s.command,
          args: [...(s.args ?? [])],
          env: Object.entries(env).map(([name, value]) => ({ name, value })),
        };
      });
      created = await connection.newSession({ cwd: config.cwd, mcpServers });
    } catch (err) {
      try {
        await launched.dispose();
      } catch {
        /* ignore */
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[acp-runtime] ACP handshake failed for agent ${agent}: ${msg}`);
    }

    const session: AgentSession = {
      id,
      role,
      status: "running",
      platform: config.platform,
      model: config.model,
      agent,
    };
    this.sessions.set(id, {
      session,
      connection,
      wireSessionId: created.sessionId,
      dispose: launched.dispose,
      idleCallbacks: [],
      currentTurn: null,
      sendChainTail: Promise.resolve(),
      closed: false,
    });
    this.fireSessionWrite("ADDED", session);

    const initialMessage = config.goal ?? config.prompt;
    if (!config.waitForPush && initialMessage && initialMessage.trim().length > 0) {
      const bootstrap = await this.send(session, initialMessage);
      // Surface bootstrap failure through the runtime contract: rewrite the
      // stored session to `crashed` and fire idle callbacks so listSessions()
      // + any onIdle listener observe the failure. Without this, a rejected
      // initial prompt would leave the session visible as "running" forever
      // while the agent never actually starts work.
      //
      // ACP stopReason values: end_turn | max_tokens | max_turn_requests |
      // refusal | cancelled | error. Only `end_turn` means the initial
      // prompt successfully completed its turn; every other value should
      // mark the bootstrap failed.
      void bootstrap.result
        .then((r) => {
          if (r.stopReason === "end_turn") return;
          const msg = r.error?.message ?? r.stopReason;
          process.stderr.write(
            `[acp-runtime] bootstrap prompt failed for ${id} (stopReason=${r.stopReason}): ${msg}\n`,
          );
          const current = this.sessions.get(id);
          if (!current) return;
          current.session = {
            ...current.session,
            status: "crashed",
          };
          this.fireSessionWrite("MODIFIED", current.session);
          for (const cb of current.idleCallbacks) {
            try {
              cb();
            } catch {
              /* ignore */
            }
          }
        })
        .catch(() => {
          /* result never rejects */
        });
    }

    return session;
  }

  async send(session: AgentSession, message: string): Promise<AcpxTurn> {
    const entry = this.sessions.get(session.id);
    if (!entry) throw new Error(`AcpRuntime.send: unknown session ${session.id}`);
    if (entry.closed) throw new Error(`AcpRuntime.send: session ${session.id} is closed`);

    const turnId = `${session.id}-${Date.now().toString(36)}-${this.nextId++}`;
    let resolveResult: (r: Result) => void = () => undefined;
    const resultPromise = new Promise<Result>((r) => {
      resolveResult = r;
    });
    const finishTurn = (result: Result): void => {
      resolveResult(result);
      this.emitAcpEvent({
        kind: "result",
        sessionId: entry.session.id,
        turnId,
        result,
      });
    };

    const turn = new AcpTurnImpl({
      sessionId: entry.wireSessionId,
      turnId,
      result: resultPromise,
      cancelFn: async () => {
        // Only cancel if this turn is actually in flight — otherwise we'd
        // cancel whichever later-queued turn happens to be active now.
        if (entry.currentTurn !== turn) return;
        try {
          await entry.connection.cancel({ sessionId: entry.wireSessionId });
        } catch {
          /* ignore */
        }
      },
    });

    // Serialize prompts per session. The adapter correlates session/update +
    // requestPermission to the single in-flight prompt via wireSessionId, so
    // overlapping prompts would misroute callbacks onto the wrong turn.
    const predecessor = entry.sendChainTail;
    const mine = (async () => {
      await predecessor;
      if (entry.closed) {
        finishTurn({
          turnId,
          stopReason: "error",
          error: { code: "session_closed", message: "session closed before turn started" },
        });
        return;
      }
      entry.currentTurn = turn;
      try {
        const ok = await entry.connection.prompt({
          sessionId: entry.wireSessionId,
          prompt: [{ type: "text", text: message }],
        });
        finishTurn({ turnId, stopReason: ok.stopReason });
      } catch (err) {
        finishTurn({
          turnId,
          stopReason: "error",
          error: {
            code: "prompt_rejected",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      } finally {
        if (entry.currentTurn === turn) entry.currentTurn = null;
        for (const cb of entry.idleCallbacks) {
          try {
            cb();
          } catch {
            /* ignore */
          }
        }
      }
    })();
    entry.sendChainTail = mine;

    return turn;
  }

  private emitAcpEvent(event: AcpRuntimeEvent): void {
    if (!this.eventSink) return;
    try {
      this.eventSink(event);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[acp-runtime] eventSink(${event.kind}) threw: ${detail}\n`);
    }
  }

  async close(session: AgentSession): Promise<void> {
    const entry = this.sessions.get(session.id);
    if (!entry) return;
    entry.closed = true;
    try {
      await entry.currentTurn?.cancel();
    } catch {
      /* best effort */
    }
    // Drain any pending sends so we don't leak prompt() promises past dispose.
    try {
      await entry.sendChainTail;
    } catch {
      /* ignore */
    }
    try {
      await entry.dispose();
    } catch {
      /* ignore */
    }
    this.sessions.delete(session.id);
    this.fireSessionWrite("DELETED", entry.session);
  }

  private fireSessionWrite(op: "ADDED" | "MODIFIED" | "DELETED", s: AgentSession): void {
    if (!this.onSessionWrite) return;
    try {
      this.onSessionWrite(op, s);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[acp-runtime] onSessionWrite(${op}) threw: ${detail}\n`);
    }
  }

  onIdle(session: AgentSession, callback: () => void): void {
    const entry = this.sessions.get(session.id);
    if (!entry) return;
    entry.idleCallbacks.push(callback);
  }

  async listSessions(): Promise<readonly AgentSession[]> {
    return [...this.sessions.values()].map((e) => e.session);
  }

  async listSessionEntities(): Promise<readonly AgentSessionEntity[]> {
    const items = await this.listSessions();
    return items.map((s) => agentSessionToEntity(s));
  }

  private findEntryByWireSession(wireId: string): AcpSessionEntry | undefined {
    for (const entry of this.sessions.values()) {
      if (entry.wireSessionId === wireId) return entry;
    }
    return undefined;
  }

  private buildClient(_groveSessionId: string): Client {
    const runtime = this;
    return {
      async requestPermission(
        params: RequestPermissionRequest,
      ): ReturnType<Client["requestPermission"]> {
        try {
          const entry = runtime.findEntryByWireSession(params.sessionId);
          const turn = entry?.currentTurn;
          if (turn) {
            const msg: Message = {
              kind: "permission_request",
              turnId: turn.turnId,
              request: {
                id: params.toolCall.toolCallId,
                tool: params.toolCall.kind ?? "other",
                input: params.toolCall.rawInput,
              },
            };
            turn.ingest(msg);
            runtime.emitAcpEvent({
              kind: "message",
              sessionId: entry.session.id,
              turnId: turn.turnId,
              message: msg,
            });
          }
          return await runtime.resolver.resolve(params);
        } catch (err) {
          process.stderr.write(
            `[acp-runtime] resolver threw: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          return { outcome: { outcome: "cancelled" } };
        }
      },
      async sessionUpdate(params) {
        const entry = runtime.findEntryByWireSession(params.sessionId);
        const turn = entry?.currentTurn;
        if (!turn) return;
        const msg = sessionUpdateToMessage(params, turn.turnId);
        turn.ingest(msg);
        runtime.emitAcpEvent({
          kind: "message",
          sessionId: entry.session.id,
          turnId: turn.turnId,
          message: msg,
        });
      },
      async readTextFile() {
        throw new Error("[acp-runtime] fs.readTextFile not supported; agents use local fs");
      },
      async writeTextFile() {
        throw new Error("[acp-runtime] fs.writeTextFile not supported; agents use local fs");
      },
    };
  }
}

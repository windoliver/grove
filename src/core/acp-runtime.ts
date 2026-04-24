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
import { resolveAcpLaunch } from "./acp-launch.js";
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
}

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
): Promise<LaunchResult> {
  const launch = resolveAcpLaunch(agent);
  const child = nodeSpawn(launch.command, [...launch.args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  const stdinWebWritable = NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const stdoutWebReadable = NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const clientStream = ndJsonStream(stdinWebWritable, stdoutWebReadable);

  const dispose = async () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };
  return { clientStream, dispose };
}

export class AcpRuntime implements AgentRuntime {
  private resolver: PermissionResolver;
  private readonly fsAuditor: AcpRuntimeOptions["fsAuditor"];
  private readonly logDir: string | undefined;
  private readonly launchOverride: LaunchOverride | undefined;
  private readonly sessions: Map<string, AcpSessionEntry> = new Map();
  private nextId = 0;

  constructor(options: AcpRuntimeOptions = {}) {
    this.resolver = options.permissionResolver ?? DENY_ALL_RESOLVER;
    this.fsAuditor = options.fsAuditor;
    this.logDir = options.logDir;
    this.launchOverride = options.launchOverride;
  }

  get currentResolver(): PermissionResolver {
    return this.resolver;
  }

  setPermissionResolver(resolver: PermissionResolver): void {
    this.resolver = resolver;
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
      : await launchSubprocess(agent, config.cwd, mergedEnv);

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
      const mcpServers = (config.mcpServers ?? []).map((s) => ({
        name: s.name,
        command: s.command,
        args: [...(s.args ?? [])],
        env: s.env ? Object.entries(s.env).map(([name, value]) => ({ name, value })) : [],
      }));
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
    let resolveResult: (r: Result) => void = () => {};
    const resultPromise = new Promise<Result>((r) => {
      resolveResult = r;
    });

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
        resolveResult({
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
        resolveResult({ turnId, stopReason: ok.stopReason });
      } catch (err) {
        resolveResult({
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

  async close(session: AgentSession): Promise<void> {
    const entry = this.sessions.get(session.id);
    if (!entry) return;
    entry.closed = true;
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
        turn.ingest(sessionUpdateToMessage(params, turn.turnId));
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

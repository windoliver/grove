import { type ChildProcessByStdio, spawn as nodeSpawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import {
  type Client,
  ClientSideConnection,
  ndJsonStream,
  RequestError,
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
  cwd: string;
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

interface TerminalEntry {
  readonly sessionId: string;
  readonly proc: ChildProcessByStdio<null, Readable, Readable>;
  readonly outputByteLimit: number;
  output: string;
  truncated: boolean;
  exitStatus?: { readonly exitCode?: number | null; readonly signal?: string | null };
  readonly exited: Promise<{ readonly exitCode?: number | null; readonly signal?: string | null }>;
}

const CLOSE_SEND_DRAIN_TIMEOUT_MS = 2_000;
const CHILD_TERM_TIMEOUT_MS = 2_000;
const CHILD_KILL_TIMEOUT_MS = 500;
const DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT = 128 * 1024;

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

function recordValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function stringRecordValue(value: unknown, key: string): string | undefined {
  const found = recordValue(value, key);
  return typeof found === "string" && found.trim().length > 0 ? found : undefined;
}

function acpErrorMessage(err: unknown): string {
  if (err instanceof RequestError) {
    const dataMessage =
      stringRecordValue(err.data, "message") ?? stringRecordValue(err.data, "details");
    if (dataMessage) return dataMessage;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

async function settleWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForChildExit(
  child: ChildProcessByStdio<Writable, Readable, Readable>,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function withSessionStatus(
  session: AgentSession,
  status: AgentSession["status"],
  statusMessage?: string,
): AgentSession {
  const { statusMessage: _oldStatusMessage, ...rest } = session;
  return statusMessage === undefined ? { ...rest, status } : { ...rest, status, statusMessage };
}

/**
 * Top-level scalar keys we copy from the user's `~/.codex/config.toml` into the
 * isolated CODEX_HOME. Restrict to safe, well-known keys: model preferences
 * and explicit grove-relevant settings. Anything else (notify hooks pointing
 * at desktop-app binaries, history backends, telemetry endpoints, …) is
 * dropped because we don't want grove-spawned children running side effects
 * the user wired into their interactive Codex.
 *
 * Tables (`[mcp_servers.X]`, `[projects.X]`, `[plugins]`) are always dropped
 * — grove provides its own MCP server set via `-c` flags in
 * `buildAcpLaunchArgs`, and per-project trust is bypassed entirely because
 * grove-spawned workspaces are ephemeral and explicitly approved by the
 * `GROVE_ALLOW_ALL_PERMISSIONS=1` / sandbox config the launcher passes.
 */
// Model-selection keys (`model`, `model_provider`) are deliberately excluded:
// users routinely bump `model` to a value codex-acp's bundled CLI hasn't
// caught up to yet (e.g. "gpt-5.5"), and copying it into the isolated config
// makes every grove-spawned codex agent fail at first prompt with
// `invalid_request_error: The '<model>' model requires a newer version of
// Codex`. Grove instead pins `DEFAULT_CODEX_MODEL` via `-c model=...` in
// `buildAcpLaunchArgs` so agents always run a model the launched codex CLI
// actually supports. Set GROVE_CODEX_MODEL to override.
const SAFE_CODEX_TOP_LEVEL_KEYS = new Set([
  "personality",
  "model_reasoning_effort",
  "model_reasoning_summaries",
  "approvals_reviewer",
]);

/**
 * Default model passed to codex when no role-level `model` and no
 * `GROVE_CODEX_MODEL` override is set. Pinned to a value that codex-acp
 * 0.11.1 (and the bundled CLI) accepts; bump as the supported floor moves.
 */
export const DEFAULT_CODEX_MODEL = "gpt-5.4";

/**
 * Match a top-level TOML scalar assignment: `key = ...` outside any table.
 * We bail at the first `[` line to switch to "inside-section" mode.
 */
const TOML_TOP_LEVEL_KEY_LINE = /^([A-Za-z0-9_-]+)\s*=/;
const CODEX_GENERATED_MCP_START = "# BEGIN GROVE GENERATED MCP";
const CODEX_GENERATED_MCP_END = "# END GROVE GENERATED MCP";

type McpServerConfig = NonNullable<AgentConfig["mcpServers"]>[number];

function buildCodexMcpConfigBlock(server: McpServerConfig, env: NodeJS.ProcessEnv): string {
  const name = server.name.trim();
  const command = server.command.trim();
  if (!name || !command) return "";

  const serverKey = `mcp_servers.${tomlKeySegment(name)}`;
  const { envEntries, envVars } = codexMcpEnvConfigEntries(server, env);
  const lines = [
    CODEX_GENERATED_MCP_START,
    `[${serverKey}]`,
    `command = ${tomlString(command)}`,
    `args = ${tomlStringArray(server.args ?? [])}`,
  ];
  if (server.startupTimeoutSec !== undefined) {
    lines.push(`startup_timeout_sec = ${server.startupTimeoutSec}`);
  }
  if (envVars.length > 0) {
    lines.push(`env_vars = ${tomlStringArray(envVars)}`);
  }
  if (envEntries.length > 0) {
    lines.push("", `[${serverKey}.env]`);
    for (const [envName, envValue] of envEntries) {
      lines.push(`${tomlKeySegment(envName)} = ${tomlString(envValue)}`);
    }
  }
  lines.push(CODEX_GENERATED_MCP_END);
  return lines.join("\n");
}

/**
 * Prepare an ephemeral CODEX_HOME for grove-spawned codex children. Links the
 * user's auth.json (so login persists without stale refresh-token copies),
 * then writes a minimal config.toml
 * containing ONLY allow-listed top-level scalars. Drops everything else —
 * `mcp_servers` (DNS-blocked enterprise endpoints crash codex's rmcp transport
 * on bootstrap), `projects.*` trust (grove uses its own permission gating),
 * `notify` hooks (would invoke desktop apps for grove turns), plugins.
 */
export async function prepareIsolatedCodexHome(
  env: NodeJS.ProcessEnv,
  mcpServers: AgentConfig["mcpServers"] = [],
): Promise<string> {
  const userHome = env.CODEX_HOME ?? join(env.HOME ?? "/tmp", ".codex");
  const isolated = mkdtempSync(join(tmpdir(), "grove-codex-"));
  // Link auth.json if present so login persists. Codex OAuth refresh tokens
  // rotate; copying auth.json into a throwaway CODEX_HOME can leave the child
  // with a refresh token that has already been superseded by the real global
  // Codex home. A symlink keeps isolation for config/plugins while letting the
  // adapter read the current auth material.
  const userAuth = join(userHome, "auth.json");
  if (existsSync(userAuth)) {
    try {
      symlinkSync(userAuth, join(isolated, "auth.json"));
    } catch {
      try {
        copyFileSync(userAuth, join(isolated, "auth.json"));
      } catch {
        /* best-effort */
      }
    }
  }

  const userConfigPath = join(userHome, "config.toml");
  const safeLines: string[] = [];
  if (existsSync(userConfigPath)) {
    try {
      const fs = await import("node:fs/promises");
      const text = await fs.readFile(userConfigPath, "utf8");
      let inSection = false;
      let currentLineKey: string | null = null;
      // Walk lines maintaining "are we inside a [table]" mode. Carry over
      // continuation lines for the most-recent allow-listed top-level key so
      // multi-line array values (e.g. `notify = [\n  "x",\n  "y"\n]`) are
      // dropped wholesale rather than half-copied. Any unknown key — even a
      // top-level scalar — is skipped.
      for (const raw of text.split("\n")) {
        const line = raw.trimEnd();
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
        if (trimmed.startsWith("[")) {
          inSection = true;
          currentLineKey = null;
          continue;
        }
        if (inSection) continue;
        const m = TOML_TOP_LEVEL_KEY_LINE.exec(trimmed);
        if (m) {
          const key = m[1];
          if (key !== undefined && SAFE_CODEX_TOP_LEVEL_KEYS.has(key)) {
            safeLines.push(line);
            currentLineKey = key;
          } else {
            currentLineKey = null;
          }
        } else if (currentLineKey !== null) {
          // Continuation of a previously-allowed key (e.g. multi-line array).
          safeLines.push(line);
        }
      }
    } catch {
      /* best-effort */
    }
  }
  if (safeLines.length === 0) {
    // Fallback: a minimal config codex will accept. Grove's `-c model=...`
    // flag in `buildAcpLaunchArgs` overrides this when a model is configured.
    safeLines.push('model = "gpt-5"');
  }
  const mcpBlocks = (mcpServers ?? [])
    .map((server) => buildCodexMcpConfigBlock(server, env))
    .filter((block) => block.length > 0);
  const configSections = [...safeLines, ...mcpBlocks.map((block) => `\n${block}`)];
  writeFileSync(join(isolated, "config.toml"), `${configSections.join("\n")}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  // Ensure plugins dir exists empty (some codex plugins bundle MCP servers).
  mkdirSync(join(isolated, "plugins"), { recursive: true });
  return isolated;
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

  // Codex loads MCP servers from the user's ~/.codex/config.toml at startup.
  // If any of those servers fail to connect (e.g., DNS-blocked enterprise MCP
  // endpoints reachable only on VPN), the codex `rmcp` worker quits fatal,
  // which closes the entire ACP stdio connection and breaks downstream sends.
  // Isolate codex from the user MCP config by pointing CODEX_HOME at an
  // ephemeral directory that contains only the user's auth (so login still
  // works), safe scalar settings, and the current Grove MCP server block.
  // The MCP block is written to config.toml so codex loads tools at startup
  // even when the ACP adapter does not surface session/new mcpServers.
  const childEnv = buildAcpLaunchEnv(agent, env, opts.mcpServers);
  let isolatedHomeForCleanup: string | undefined;
  if (agent === "codex" && env.GROVE_CODEX_NO_ISOLATION !== "1") {
    // Fail closed: if isolation prep throws, refuse the spawn rather than
    // launching against the user's live ~/.codex (which would re-introduce
    // the rmcp-fatal-on-bootstrap path this isolation exists to prevent,
    // and run user-level notify hooks against grove turns). Operators that
    // explicitly accept the risk can opt out with GROVE_CODEX_NO_ISOLATION=1.
    try {
      const isolatedHome = await prepareIsolatedCodexHome(childEnv, opts.mcpServers);
      childEnv.CODEX_HOME = isolatedHome;
      isolatedHomeForCleanup = isolatedHome;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[acp-runtime] codex isolated-home prep failed: ${detail}. ` +
          `Set GROVE_CODEX_NO_ISOLATION=1 to launch with the user's ~/.codex (NOT recommended).`,
      );
    }
  }

  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  try {
    child = nodeSpawn(launch.command, buildAcpLaunchArgs(launch, opts, childEnv), {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessByStdio<Writable, Readable, Readable>;
  } catch (err) {
    // Spawn itself failed — auth.json is on disk; clean up before bubbling.
    if (isolatedHomeForCleanup) {
      try {
        rmSync(isolatedHomeForCleanup, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    throw err;
  }

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
    // Wait briefly for the child to exit so we don't `rm -rf` the isolated
    // home out from under codex while it's still flushing session state.
    // Bounded so a stuck child doesn't block teardown indefinitely.
    let exited = await waitForChildExit(child, CHILD_TERM_TIMEOUT_MS);
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      exited = await waitForChildExit(child, CHILD_KILL_TIMEOUT_MS);
    }
    if (isolatedHomeForCleanup) {
      try {
        rmSync(isolatedHomeForCleanup, { recursive: true, force: true });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[acp-runtime] codex isolated-home cleanup failed (childExited=${exited}): ${detail}\n`,
        );
      }
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

  const model = (opts.model ?? env.GROVE_CODEX_MODEL)?.trim() || DEFAULT_CODEX_MODEL;
  args.push("-c", `model=${JSON.stringify(model)}`);

  const allowAll =
    env.GROVE_ALLOW_ALL_PERMISSIONS === "1" ||
    opts.command?.includes("--full-auto") === true ||
    opts.command?.includes("--dangerously-bypass-approvals-and-sandbox") === true;
  if (allowAll) {
    args.push("-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"');
  }
  if (env.GROVE_CODEX_WRITE_MCP_CONFIG !== "1") {
    appendCodexMcpServerOverrides(args, opts.mcpServers, env);
  }
  return args;
}

export function buildAcpLaunchEnv(
  agent: string,
  env: NodeJS.ProcessEnv,
  mcpServers: AgentConfig["mcpServers"] | undefined,
): NodeJS.ProcessEnv {
  const launchEnv: NodeJS.ProcessEnv = { ...env, PATH: withStandardUserBinPath(env) };
  if (agent !== "codex") return launchEnv;

  for (const server of mcpServers ?? []) {
    if (server.name.trim() !== "grove") continue;
    for (const [name, value] of Object.entries(server.env ?? {})) {
      launchEnv[name] = value;
    }
  }

  return launchEnv;
}

function withStandardUserBinPath(env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env.PATH;
  const home = env.HOME;
  if (home === undefined || home.length === 0) return pathValue;

  const entries = pathValue?.split(":").filter((entry) => entry.length > 0) ?? [];
  const seen = new Set(entries);
  const additions = [join(home, ".local", "bin"), join(home, ".bun", "bin")];
  for (const dir of additions) {
    if (!seen.has(dir) && existsSync(dir)) {
      entries.unshift(dir);
      seen.add(dir);
    }
  }
  return entries.length > 0 ? entries.join(":") : undefined;
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

function isGroveMcpInheritedEnv(name: string): boolean {
  return name.startsWith("GROVE_") || name === "NEXUS_API_KEY";
}

function stringEnvEntries(env: NodeJS.ProcessEnv): [string, string][] {
  return Object.entries(env).filter((entry): entry is [string, string] => {
    return typeof entry[1] === "string";
  });
}

function mergedCodexMcpServerEnv(
  server: NonNullable<AgentConfig["mcpServers"]>[number],
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const inherited =
    server.name.trim() === "grove"
      ? Object.fromEntries(stringEnvEntries(env).filter(([name]) => isGroveMcpInheritedEnv(name)))
      : {};
  return {
    ...inherited,
    ...(server.env ?? {}),
  };
}

function codexMcpEnvConfigEntries(
  server: NonNullable<AgentConfig["mcpServers"]>[number],
  env: NodeJS.ProcessEnv,
): { readonly envEntries: readonly [string, string][]; readonly envVars: readonly string[] } {
  const envVars = new Set<string>();
  const envEntries: [string, string][] = [];
  for (const [envName, envValue] of Object.entries(mergedCodexMcpServerEnv(server, env))) {
    if (!shouldPassMcpEnvViaCodexConfig(envName, envValue)) {
      if (envName.length > 0) envVars.add(envName);
      continue;
    }
    envEntries.push([envName, envValue]);
  }
  envEntries.sort(([left], [right]) => left.localeCompare(right));
  return { envEntries, envVars: [...envVars].sort((left, right) => left.localeCompare(right)) };
}

function appendCodexMcpServerOverrides(
  args: string[],
  mcpServers: AgentConfig["mcpServers"] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const server of mcpServers ?? []) {
    const name = server.name.trim();
    const command = server.command.trim();
    if (!name || !command) continue;

    const serverKey = `mcp_servers.${tomlKeySegment(name)}`;
    args.push("-c", `${serverKey}.command=${tomlString(command)}`);
    args.push("-c", `${serverKey}.args=${tomlStringArray(server.args ?? [])}`);
    if (server.startupTimeoutSec !== undefined) {
      args.push("-c", `${serverKey}.startup_timeout_sec=${server.startupTimeoutSec}`);
    }

    const { envEntries, envVars } = codexMcpEnvConfigEntries(server, env);

    for (const [envName, envValue] of envEntries) {
      args.push("-c", `${serverKey}.env.${tomlKeySegment(envName)}=${tomlString(envValue)}`);
    }
    if (envVars.length > 0) {
      args.push("-c", `${serverKey}.env_vars=${tomlStringArray(envVars)}`);
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
  private readonly terminals: Map<string, TerminalEntry> = new Map();
  private nextId = 0;
  private nextTerminalId = 0;

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
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
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
          type: "stdio" as const,
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
      const msg = acpErrorMessage(err);
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
      cwd: config.cwd,
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
            statusMessage: msg,
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
      const statusMessage = result.stopReason === "error" ? result.error?.message : undefined;
      entry.session = withSessionStatus(
        entry.session,
        result.stopReason === "error" ? "crashed" : "idle",
        statusMessage,
      );
      this.fireSessionWrite("MODIFIED", entry.session);
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
      entry.session = withSessionStatus(entry.session, "running");
      this.fireSessionWrite("MODIFIED", entry.session);
      entry.currentTurn = turn;
      try {
        const ok = await entry.connection.prompt({
          sessionId: entry.wireSessionId,
          prompt: [{ type: "text", text: message }],
        });
        finishTurn({ turnId, stopReason: ok.stopReason });
      } catch (err) {
        const message = acpErrorMessage(err);
        finishTurn({
          turnId,
          stopReason: "error",
          error: {
            code: "prompt_rejected",
            message,
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
      await settleWithTimeout(entry.sendChainTail, CLOSE_SEND_DRAIN_TIMEOUT_MS);
    } catch {
      /* ignore */
    }
    await this.releaseSessionTerminals(entry.wireSessionId);
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
      async readTextFile(params) {
        const text = readFileSync(params.path, "utf-8");
        const line = params.line ?? undefined;
        const limit = params.limit ?? undefined;
        if (line === undefined && limit === undefined) return { content: text };

        const lines = text.split(/(?<=\n)/);
        const start = line === undefined ? 0 : Math.max(0, line - 1);
        const end = limit === undefined ? lines.length : start + Math.max(0, limit);
        return { content: lines.slice(start, end).join("") };
      },
      async writeTextFile(params) {
        mkdirSync(dirname(params.path), { recursive: true });
        writeFileSync(params.path, params.content, "utf-8");
        return {};
      },
      async createTerminal(params) {
        const entry = runtime.findEntryByWireSession(params.sessionId);
        const env = { ...process.env };
        for (const item of params.env ?? []) {
          env[item.name] = item.value;
        }
        const proc = nodeSpawn(params.command, params.args ?? [], {
          cwd: params.cwd ?? entry?.cwd ?? process.cwd(),
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const terminalId = `term-${++runtime.nextTerminalId}`;
        const terminal: TerminalEntry = {
          sessionId: params.sessionId,
          proc,
          outputByteLimit: params.outputByteLimit ?? DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT,
          output: "",
          truncated: false,
          exited: new Promise((resolve) => {
            proc.once("exit", (code, signal) => {
              const exitStatus = { exitCode: code, signal };
              terminal.exitStatus = exitStatus;
              resolve(exitStatus);
            });
          }),
        };
        const append = (chunk: Buffer): void => {
          terminal.output += chunk.toString("utf-8");
          while (Buffer.byteLength(terminal.output, "utf-8") > terminal.outputByteLimit) {
            terminal.output = terminal.output.slice(1);
            terminal.truncated = true;
          }
        };
        proc.stdout.on("data", append);
        proc.stderr.on("data", append);
        runtime.terminals.set(terminalId, terminal);
        return { terminalId };
      },
      async terminalOutput(params) {
        const terminal = runtime.requireTerminal(params.terminalId);
        return {
          output: terminal.output,
          truncated: terminal.truncated,
          ...(terminal.exitStatus !== undefined ? { exitStatus: terminal.exitStatus } : {}),
        };
      },
      async waitForTerminalExit(params) {
        const terminal = runtime.requireTerminal(params.terminalId);
        return await terminal.exited;
      },
      async releaseTerminal(params) {
        await runtime.releaseTerminal(params.terminalId);
        return {};
      },
      async killTerminal(params) {
        const terminal = runtime.requireTerminal(params.terminalId);
        if (terminal.exitStatus === undefined) terminal.proc.kill("SIGTERM");
        return {};
      },
    };
  }

  private requireTerminal(terminalId: string): TerminalEntry {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`[acp-runtime] unknown terminal: ${terminalId}`);
    return terminal;
  }

  private async releaseTerminal(terminalId: string): Promise<void> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;
    if (terminal.exitStatus === undefined) {
      terminal.proc.kill("SIGTERM");
      await Promise.race([
        terminal.exited,
        new Promise((resolve) => setTimeout(resolve, CHILD_TERM_TIMEOUT_MS)),
      ]);
    }
    this.terminals.delete(terminalId);
  }

  private async releaseSessionTerminals(sessionId: string): Promise<void> {
    const ids = [...this.terminals.entries()]
      .filter(([, terminal]) => terminal.sessionId === sessionId)
      .map(([id]) => id);
    for (const id of ids) {
      await this.releaseTerminal(id);
    }
  }
}

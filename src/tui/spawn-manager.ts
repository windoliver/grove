/**
 * Spawn manager — encapsulates the spawn/kill lifecycle so it can be
 * tested independently of React components.
 *
 * Manages: workspace checkout → claim creation → tmux session → heartbeat loop.
 * On kill: stop heartbeat → release claim → clean workspace.
 * On tmux failure: roll back claim + workspace.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { watchTurnError } from "../acp/watch-turn.js";
import type { AcpRuntimeEvent, AcpRuntimeEventSink } from "../core/acp-runtime.js";
import type { AgentConfig, AgentRuntime, AgentSession } from "../core/agent-runtime.js";
import { parseGroveConfig } from "../core/config.js";
import type { AgentIdentity } from "../core/models.js";
import { type ResolvedRepo, type ResolveRepoOptions, resolveRepo } from "../core/repo-cache.js";
import type { RepoRef } from "../core/repo-ref.js";
import { resolveBundledSkillsRoot, resolveMcpServePath } from "../core/resolve-mcp-serve-path.js";
import { parseAcpxSessionId } from "../core/session-id.js";
import { injectSkills } from "../core/skill-injector.js";
import type { AgentTopology } from "../core/topology.js";
import { resolveRoleWorkspaceStrategies } from "../core/topology.js";
import type { WorkspaceIsolationPolicy, WorkspaceMode } from "../core/workspace-provisioner.js";
import { provisionWorkspace } from "../core/workspace-provisioner.js";
import { startInterval } from "../local/use-interval.js";
import { NexusHttpClient } from "../nexus/nexus-http-client.js";
import {
  type ResolvedSkillCatalogRoot,
  resolveNexusSkillCatalogRoot,
  type SkillResolutionWarning,
} from "../nexus/nexus-skill-catalog.js";
import { resolveConfiguredNexusUrl } from "../shared/nexus-url.js";
import { safeCleanup } from "../shared/safe-cleanup.js";
import type { SpawnOptions, TmuxManager } from "./agents/tmux-manager.js";
import { agentIdFromSession } from "./agents/tmux-manager.js";
// ---------------------------------------------------------------------------
import type { AcpSessionStore } from "./data/acp-session-store.js";
import { AgentLogBuffer } from "./data/agent-log-buffer.js";
import { projectSessionToBuffer } from "./data/session-log-projector.js";
import { loadTraceHistory, saveTraceHistory } from "./data/trace-persistence.js";
import { debugLog } from "./debug-log.js";
import type { NexusWsBridge } from "./nexus-ws-bridge.js";
import type { TuiDataProvider } from "./provider.js";
import type { PersistedSpawnRecord, SessionStore } from "./session-store.js";

const CODEX_GENERATED_MCP_START = "# BEGIN GROVE GENERATED MCP";
const CODEX_GENERATED_MCP_END = "# END GROVE GENERATED MCP";
const SAFE_TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlKeySegment(segment: string): string {
  return SAFE_TOML_BARE_KEY.test(segment) ? segment : tomlString(segment);
}

function stripGeneratedCodexMcpBlock(contents: string): string {
  const start = contents.indexOf(CODEX_GENERATED_MCP_START);
  if (start === -1) return contents.trimEnd();
  const end = contents.indexOf(CODEX_GENERATED_MCP_END, start);
  if (end === -1) return contents.slice(0, start).trimEnd();
  return `${contents.slice(0, start)}${contents.slice(end + CODEX_GENERATED_MCP_END.length)}`.trimEnd();
}

function buildCodexMcpConfigBlock(server: {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}): string {
  const serverKey = `mcp_servers.${tomlKeySegment(server.name)}`;
  const lines = [
    CODEX_GENERATED_MCP_START,
    `[${serverKey}]`,
    `command = ${tomlString(server.command)}`,
    `args = ${tomlStringArray(server.args)}`,
    "",
    `[${serverKey}.env]`,
  ];
  for (const [name, value] of Object.entries(server.env)) {
    lines.push(`${tomlKeySegment(name)} = ${tomlString(value)}`);
  }
  lines.push(CODEX_GENERATED_MCP_END, "");
  return lines.join("\n");
}

function isNotFoundError(err: unknown): boolean {
  return (
    err instanceof Error && "code" in err && (err as { readonly code?: unknown }).code === "ENOENT"
  );
}

/** PR context injected as env vars when spawning agents. */
export interface PrContext {
  readonly number: number;
  readonly title: string;
  readonly filesChanged: number;
}

/** Tracked state for a spawned agent. */
interface SpawnRecord {
  readonly claimId: string;
  readonly targetRef: string;
  readonly agentId: string;
  readonly workspacePath?: string | undefined;
  /**
   * Role name this spawn was registered under. Distinct from `agentId`
   * (which is the spawnId `role-timestamp`) — the bridge is role-keyed,
   * so kill() needs the role name to cancel the right SSE loop.
   */
  readonly role?: string;
}

interface AcpEventSinkRuntime {
  setAcpEventSink(eventSink: AcpRuntimeEventSink | undefined): void;
}

/** Result of a spawn attempt. */
export interface SpawnResult {
  readonly spawnId: string;
  readonly claimId: string;
  readonly workspacePath: string;
  /** Describes how this agent's workspace was provisioned. */
  readonly workspaceMode: WorkspaceMode;
}

class RequiredSkillCatalogResolutionError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "RequiredSkillCatalogResolutionError";
  }
}

function isRequiredSkillCatalogResolutionError(
  error: unknown,
): error is RequiredSkillCatalogResolutionError {
  return error instanceof RequiredSkillCatalogResolutionError;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSkillCatalogWarning(warning: SkillResolutionWarning): string {
  const fallback = warning.fallbackSource ? ` fallback: ${warning.fallbackSource};` : "";
  return `Nexus skill catalog warning for '${warning.skillName}': attempted ${warning.attemptedSource};${fallback} ${warning.reason}`;
}

/**
 * Manages the full spawn/kill lifecycle for TUI-spawned agents.
 *
 * Testable without React — timer setup/teardown and failure rollback
 * are exercised directly.
 */
export class SpawnManager {
  private readonly provider: TuiDataProvider;
  private readonly tmux: TmuxManager | undefined;
  private readonly agentRuntime: AgentRuntime | undefined;
  private readonly spawnRecords = new Map<string, SpawnRecord>();
  private readonly agentSessions = new Map<string, AgentSession>();
  private readonly logBuffers = new Map<string, AgentLogBuffer>();
  private readonly onError: (message: string) => void;
  private readonly sessionStore: SessionStore | undefined;
  private readonly acpSessionStore: AcpSessionStore | undefined;
  /** Per-session unsubscribe callbacks from projectSessionToBuffer. */
  private readonly acpProjections = new Map<string, () => void>();
  private wsBridge: NexusWsBridge | undefined;
  private prContext: PrContext | undefined;
  private sessionGoal: string | undefined;
  private sessionId: string | undefined;
  private groveDir: string | undefined;
  private workspaceIsolationPolicy: WorkspaceIsolationPolicy = "allow-fallback";
  private topology: AgentTopology | undefined;
  private logPollTimer: (() => void) | null = null;
  // spawnIds that should receive IPC routing — populated when agents are spawned
  // or explicitly reattached for the CURRENT session. Prevents routing to stale
  // sessions from previous sessions that reconcile() found still alive in acpx.
  private readonly routableSessions = new Set<string>();
  /**
   * Grove MCP server definition captured the first time writeMcpConfig runs.
   * Passed to AgentConfig.mcpServers so AcpRuntime forwards it via ACP's
   * session/new to agents that rely on protocol-level MCP discovery.
   */
  private groveMcpServer:
    | {
        readonly name: string;
        readonly command: string;
        readonly args: readonly string[];
        readonly env: Readonly<Record<string, string>>;
      }
    | undefined;
  private readonly repos: readonly RepoRef[];
  private repoCache: Partial<ResolveRepoOptions> | undefined;
  private resolvedRepos: readonly ResolvedRepo[] = [];

  constructor(
    provider: TuiDataProvider,
    tmux: TmuxManager | undefined,
    onError: (message: string) => void,
    repos: readonly RepoRef[],
    sessionStore?: SessionStore,
    groveDir?: string,
    agentRuntime?: AgentRuntime,
    acpSessionStore?: AcpSessionStore,
  ) {
    this.provider = provider;
    this.tmux = tmux;
    this.agentRuntime = agentRuntime;
    this.onError = onError;
    this.repos = repos;
    this.sessionStore = sessionStore;
    this.groveDir = groveDir;
    this.acpSessionStore = acpSessionStore;
    this.configureAcpEventSink();
  }

  /**
   * Return the AcpSessionStore this manager writes to, if one was provided
   * at construction. Views (notably SessionPanel) need this to subscribe
   * to typed message streams for a specific sessionId.
   */
  getAcpSessionStore(): AcpSessionStore | undefined {
    return this.acpSessionStore;
  }

  private configureAcpEventSink(): void {
    if (!this.agentRuntime || !this.acpSessionStore) return;
    const runtime = this.agentRuntime as Partial<AcpEventSinkRuntime>;
    if (typeof runtime.setAcpEventSink !== "function") return;
    runtime.setAcpEventSink((event: AcpRuntimeEvent) => {
      this.acpSessionStore?.register(event.sessionId);
      this.acpSessionStore?.ingest(event);
    });
  }

  /**
   * Delivery readiness state. Multi-role topologies need an attached
   * NexusWsBridge (polling was removed by design); single-role
   * topologies don't care. States:
   *   "pending"  — bridge init is in flight; spawn() for multi-role
   *                topologies must wait until resolve to avoid starting
   *                agents before their IPC subscriptions are live.
   *   "ready"    — bridge registered (or no delivery required); spawn
   *                freely.
   *   "disabled" — bridge permanently failed or misconfigured; spawn()
   *                rejects immediately regardless of topology (operator
   *                has been warned; don't accumulate more work).
   *
   * Default is "ready" — a manager without any declared topology has no
   * cross-role delivery needs, so spawn should proceed. A multi-role
   * topology assignment (via setTopology) flips the state to "pending"
   * until the bridge wires up (setWsBridge / markDeliveryReady) or
   * fails (markDeliveryDisabled).
   */
  private deliveryState: "pending" | "ready" | "disabled" = "ready";
  private deliveryDisabledReason: string | undefined;
  private deliveryReadyWaiters: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
  }> = [];

  markDeliveryDisabled(reason: string): void {
    this.deliveryState = "disabled";
    this.deliveryDisabledReason = reason;
    const err = new Error(`Inter-agent delivery disabled: ${reason}`);
    const waiters = this.deliveryReadyWaiters;
    this.deliveryReadyWaiters = [];
    for (const w of waiters) w.reject(err);
  }

  /**
   * Mark delivery ready without requiring a NexusWsBridge. Used by
   * tmux-only test harnesses that don't need cross-agent IPC: they
   * assert "this session has no IPC dependency" so `spawn()` can
   * proceed against the `pending` → `ready` state machine. Real
   * multi-role sessions flow through `setWsBridge()` instead.
   */
  markDeliveryReady(): void {
    if (this.deliveryState === "disabled") return;
    this.deliveryState = "ready";
    const waiters = this.deliveryReadyWaiters;
    this.deliveryReadyWaiters = [];
    for (const w of waiters) w.resolve();
  }

  /**
   * Recover from a `disabled` delivery state once the bridge reports a
   * role's SSE channel has resumed. Without this transition, a transient
   * Nexus restart that briefly exceeded the unhealthy threshold leaves
   * the session permanently fail-closed even after the channel is
   * delivering events again.
   *
   * Distinct from `markDeliveryReady()` so callers must opt in: only the
   * bridge's per-role `onRoleRecovered` should re-arm delivery, never the
   * normal startup path.
   */
  markDeliveryRecovered(): void {
    if (this.deliveryState !== "disabled") return;
    this.deliveryState = "ready";
    this.deliveryDisabledReason = undefined;
    const waiters = this.deliveryReadyWaiters;
    this.deliveryReadyWaiters = [];
    for (const w of waiters) w.resolve();
  }

  /** @internal — test surface for delivery state assertions */
  getDeliveryState(): "pending" | "ready" | "disabled" {
    return this.deliveryState;
  }

  /** @internal — test surface for delivery state assertions */
  getDeliveryDisabledReason(): string | undefined {
    return this.deliveryDisabledReason;
  }

  /** @internal — test surface for waitForDelivery() (private). */
  testWaitForDelivery(timeoutMs: number): Promise<void> {
    return this.waitForDelivery(timeoutMs);
  }

  /**
   * Wait until the bridge transitions to "ready" or "disabled". Default
   * timeout (120s) covers the full bridge init retry budget plus margin.
   * One connect() attempt = provisionAgents(10s) + probeStreams(10s) =
   * 20s; 4 attempts × 20s + exp backoff (0.5+1+2s = 3.5s) = ~83.5s worst
   * case. The timer here is only a safety net — bridge init always
   * resolves or rejects (finite retries, bounded fetches), so spawn
   * waiters normally settle via setWsBridge/markDeliveryDisabled, not
   * this timeout.
   */
  private async waitForDelivery(timeoutMs = 120000): Promise<void> {
    if (this.deliveryState === "ready") return;
    if (this.deliveryState === "disabled") {
      throw new Error(`Inter-agent delivery disabled: ${this.deliveryDisabledReason ?? "unknown"}`);
    }
    await new Promise<void>((resolve, reject) => {
      // Remove `entry` from the pending waiters list so repeated spawn
      // attempts while readiness never resolves don't accumulate stale
      // closures. Called from every terminal branch (timeout, resolve,
      // reject) to guarantee single-removal.
      let entry: { resolve: () => void; reject: (e: Error) => void };
      const cleanup = (): void => {
        const idx = this.deliveryReadyWaiters.indexOf(entry);
        if (idx !== -1) this.deliveryReadyWaiters.splice(idx, 1);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`bridge readiness timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Don't keep the event loop alive solely for a readiness timer —
      // a shutdown during init should be able to exit without waiting.
      (timer as unknown as { unref?: () => void }).unref?.();
      entry = {
        resolve: () => {
          clearTimeout(timer);
          cleanup();
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          cleanup();
          reject(e);
        },
      };
      this.deliveryReadyWaiters.push(entry);
    });
  }

  /** Attach a NexusWsBridge for push-based IPC. Call after construction. */
  setWsBridge(bridge: NexusWsBridge): void {
    // Topology-drift guard: if the topology changed while bridge init
    // was in flight (e.g. preset swap during connect()), the bridge we
    // just received was provisioned/probed against the OLD role set.
    // Attaching it and flipping delivery to `ready` would create a
    // fail-open window where spawns proceed against a bridge whose
    // registration and SSE loops don't cover the current roles. Fail
    // closed instead — operator must restart after topology settles.
    if (this.topology !== undefined) {
      const currentRoles = new Set(this.topology.roles.map((r) => r.name));
      const provisionedRoles = new Set(bridge.getProvisionedRoleNames());
      const mismatch =
        currentRoles.size !== provisionedRoles.size ||
        [...currentRoles].some((r) => !provisionedRoles.has(r));
      if (mismatch) {
        this.wsBridge = bridge;
        this.markDeliveryDisabled(
          "bridge provisioned for stale topology; restart TUI after topology settles",
        );
        return;
      }
    }
    this.wsBridge = bridge;
    this.markDeliveryReady();
    // Register any sessions that were spawned before the bridge was ready.
    // The bridge is created async (dynamic import) so agents may already be running.
    //
    // Use `session.role` (the orchestration role from spawn config) rather
    // than splitting the map key on `-`: the split would truncate hyphenated
    // roles like `code-reviewer` to `code` and drop inbound IPC. NexusWsBridge
    // does an exact role lookup downstream, so the registration key must match
    // the topology role exactly.
    for (const [spawnId, session] of this.agentSessions) {
      const role = session.role;
      if (role) {
        bridge.registerSession(role, session);
        this.registerAcpSession(role, session.id);
        debugLog("wsBridge", `late-registered ${role} (spawnId=${spawnId})`);
      }
    }
  }

  /**
   * Register a session with AcpSessionStore and bind a projection into the
   * role's AgentLogBuffer so TracePane receives typed events without a
   * parallel ingestion pipeline. Safe to call twice for the same sessionId
   * — AcpSessionStore.register is a no-op on duplicates.
   */
  private registerAcpSession(role: string, sessionId: string): void {
    if (!this.acpSessionStore) return;
    this.acpSessionStore.register(sessionId);
    if (this.acpProjections.has(sessionId)) return;
    const buffer = this.ensureLogBuffer(role);
    const unsubscribe = projectSessionToBuffer(this.acpSessionStore, sessionId, buffer);
    this.acpProjections.set(sessionId, unsubscribe);
  }

  private unregisterAcpSession(sessionId: string): void {
    const unsubscribe = this.acpProjections.get(sessionId);
    if (unsubscribe) {
      unsubscribe();
      this.acpProjections.delete(sessionId);
    }
    this.acpSessionStore?.unregister(sessionId);
  }

  getWsBridge(): NexusWsBridge | undefined {
    return this.wsBridge;
  }

  /**
   * Set PR context to inject into spawned agent environments.
   * When set, GROVE_PR_NUMBER, GROVE_PR_TITLE, and GROVE_PR_FILES
   * are passed as environment variables via the spawn options.
   */
  setPrContext(ctx: PrContext | undefined): void {
    this.prContext = ctx;
  }

  /** Get the current PR context (for testing). */
  getPrContext(): PrContext | undefined {
    return this.prContext;
  }

  /**
   * Set the session goal. When set, spawned agents receive this as their
   * initial prompt along with their role description.
   */
  setSessionGoal(goal: string | undefined): void {
    this.sessionGoal = goal;
  }

  /** Set the workspace isolation policy for subsequent spawns. */
  setIsolationPolicy(policy: WorkspaceIsolationPolicy): void {
    this.workspaceIsolationPolicy = policy;
  }

  private async ensureReposResolved(): Promise<void> {
    if (this.resolvedRepos.length > 0) return;
    if (this.repos.length === 0) {
      throw new Error(
        "SpawnManager: repos must be non-empty; pass at least one RepoRef at construction.",
      );
    }
    if (this.repos.length > 1) {
      throw new Error(
        "SpawnManager: multi-repo sessions are not yet supported; pass exactly one repo.",
      );
    }
    this.resolvedRepos = await Promise.all(
      this.repos.map((ref) => resolveRepo(ref, this.repoCache ?? {})),
    );
  }

  private reportSkillCatalogWarnings(warnings: readonly SkillResolutionWarning[]): void {
    for (const warning of warnings) {
      const message = formatSkillCatalogWarning(warning);
      this.onError(message);
      debugLog("spawn", message);
    }
  }

  private async resolveSkillRootForSpawn(
    roleSkills: readonly string[],
  ): Promise<ResolvedSkillCatalogRoot | undefined> {
    if (roleSkills.length === 0 || !this.groveDir) return undefined;
    const configPath = join(this.groveDir, "grove.json");
    if (!existsSync(configPath)) return undefined;
    const raw = await readFile(configPath, "utf-8");
    const config = parseGroveConfig(raw);
    if (config.mode !== "nexus" || config.skillCatalog === undefined) return undefined;

    const projectRoot = dirname(this.groveDir);
    const nexusUrl = resolveConfiguredNexusUrl({
      projectRoot,
      config,
      env: process.env,
    });
    if (!nexusUrl) {
      if (config.skillCatalog.policy !== "required") return undefined;
      throw new RequiredSkillCatalogResolutionError(
        "Nexus skill catalog required but no Nexus URL is configured",
        undefined,
      );
    }
    const client = new NexusHttpClient({
      url: nexusUrl,
      apiKey: process.env.NEXUS_API_KEY || undefined,
    });
    try {
      const result = await resolveNexusSkillCatalogRoot({
        client,
        zoneId: process.env.GROVE_ZONE_ID ?? "default",
        cacheRoot: join(this.groveDir, "cache", "skills"),
        skills: roleSkills,
        policy: config.skillCatalog.policy,
        trustedKeys: config.skillCatalog.trustedKeys,
        localFallbackRoots: [join(this.groveDir, "skills"), resolveBundledSkillsRoot(projectRoot)],
      });
      this.reportSkillCatalogWarnings(result.warnings);
      return result;
    } catch (error) {
      if (config.skillCatalog.policy === "required") {
        throw new RequiredSkillCatalogResolutionError(
          `Nexus skill catalog required but resolution failed: ${messageFromError(error)}`,
          error,
        );
      }
      throw error;
    }
  }

  /**
   * Set the session topology so spawn() can resolve edge-type-aware base branches.
   * Call before spawning when the topology is known (e.g. after preset selection).
   */
  setTopology(topology: AgentTopology | undefined): void {
    const prevRoles = new Set(this.topology?.roles.map((r) => r.name) ?? []);
    const nextRoles = new Set(topology?.roles.map((r) => r.name) ?? []);
    const prevRoleCount = prevRoles.size;
    this.topology = topology;
    const newRoleCount = nextRoles.size;

    // A session change to single-role or undefined topology clears
    // both "disabled" and "pending" states: both were scoped to a
    // prior multi-role topology's bridge requirement. Single-role
    // sessions don't need cross-role IPC, so spawn() should proceed
    // immediately without waiting. Resolve any pending waiters so
    // they can spawn now.
    if (newRoleCount <= 1 && prevRoleCount !== newRoleCount) {
      if (this.deliveryState === "disabled") {
        this.deliveryState = "ready";
        this.deliveryDisabledReason = undefined;
      } else if (this.deliveryState === "pending") {
        this.markDeliveryReady();
      }
    }

    // Multi-role topology means cross-role IPC is expected — the bridge
    // must be attached before spawning. Transition to pending so spawn()
    // waits for setWsBridge / markDeliveryDisabled to settle. Guards:
    //   - Never downgrade "disabled" (operator warning already fired
    //     for a multi-role session; don't mask it).
    //   - When a bridge is already attached AND the role set matches the
    //     bridge's provisioned set, skip the re-pending step — topology
    //     is often re-applied AFTER bridge init completes in the normal
    //     flow, and re-pending would stall every spawn its full 120s
    //     budget despite a healthy bridge.
    //   - When a bridge is attached but the role set CHANGED, the
    //     bridge was provisioned/probed for the old roles and cannot
    //     safely service the new ones (registration, SSE, and health
    //     are all per-role and scoped to construction-time topology).
    //     Fail closed rather than silently let spawns through against
    //     a bridge that never probed the new roles.
    if (this.deliveryState === "disabled") return;
    if (topology !== undefined && topology.roles.length > 1) {
      if (this.wsBridge !== undefined) {
        const roleSetChanged =
          prevRoles.size !== nextRoles.size || [...nextRoles].some((r) => !prevRoles.has(r));
        if (roleSetChanged) {
          this.markDeliveryDisabled(
            "topology role set changed after bridge attached; restart TUI to re-probe",
          );
        }
        return;
      }
      this.deliveryState = "pending";
    }
  }

  /**
   * Spawn a new agent session.
   *
   * Lifecycle: workspace checkout → claim → tmux session → heartbeat.
   * On failure at any step, all previously-created state is rolled back.
   */
  async spawn(
    roleId: string,
    command: string,
    _parentAgentId?: string,
    _depth: number = 0,
    context?: Record<string, unknown>,
  ): Promise<SpawnResult> {
    debugLog("spawn", `role=${roleId} command=${command}`);
    // Fail closed on delivery state:
    //   disabled → refuse ONLY when the current topology actually
    //              needs cross-role IPC (multi-role). A single-role
    //              topology arriving after a prior multi-role disable
    //              has no IPC dependency; spawn should proceed.
    //   pending  → wait for setWsBridge / markDeliveryDisabled to settle.
    //   ready    → spawn. Default state is "ready"; multi-role topology
    //              flips it to pending in setTopology.
    //
    // Gate scope is split into two axes:
    //   - isMultiRole  — cross-role IPC is part of the session's contract
    //   - hasRuntime   — there is an AgentRuntime that would actually deliver
    //
    // `disabled` must reject every multi-role spawn regardless of runtime:
    // failing closed is the whole point of the state. A tmux-only harness
    // that explicitly disabled delivery should also refuse to spawn — that's
    // how the operator signaled "this session cannot deliver."
    //
    // `pending` is fatal for multi-role regardless of runtime: the whole
    // point of the state is "cross-role IPC is contractually required but
    // not yet wired." With no runtime, there's no way to ever wire it —
    // waiting would deadlock, and skipping the wait would silently spawn
    // agents whose handoffs will never deliver. Fail closed. A tmux-only
    // harness that genuinely wants multi-role without IPC must explicitly
    // call markDeliveryDisabled (to flip the state to a loud-failure
    // mode) or markDeliveryReady (to assert IPC is not needed); pending
    // itself is never a valid green-light for multi-role spawns.
    const isMultiRole = (this.topology?.roles.length ?? 0) > 1;
    if (this.deliveryState === "disabled" && isMultiRole) {
      throw new Error(
        `Refusing to spawn ${roleId}: Inter-agent delivery disabled: ${
          this.deliveryDisabledReason ?? "unknown"
        }. Restart the TUI after Nexus is reachable.`,
      );
    }
    if (this.deliveryState === "pending" && isMultiRole) {
      if (this.agentRuntime === undefined) {
        throw new Error(
          `Refusing to spawn ${roleId}: Multi-role topology requires a runtime-backed NexusWsBridge, ` +
            `but no AgentRuntime is configured. Tmux-only harnesses must call ` +
            `markDeliveryDisabled() or markDeliveryReady() explicitly before spawning.`,
        );
      }
      try {
        await this.waitForDelivery();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Refusing to spawn ${roleId}: ${detail}. Restart the TUI after Nexus is reachable.`,
        );
      }
    }
    const spawnId = `${roleId}-${Date.now().toString(36)}`;
    const agent: AgentIdentity = {
      agentId: spawnId,
      ...(roleId !== spawnId ? { role: roleId } : {}),
    };

    // Step 1: Create git worktree for the agent.
    // Uses a real git worktree so the agent has actual source code,
    // can edit files, commit, push, and create PRs.
    let workspacePath: string;
    let workspaceMode!: WorkspaceMode;
    // Hoisted out of the inner block so the spawn-failure catch can clean
    // up the provisioned worktree even though the workspace registry path
    // (cleanWorkspace) won't see it (no spawn record was persisted yet).
    let provisionedWorkspacePath: string | undefined;
    let provisionedBranch: string | undefined;
    let provisionedRepoCwd: string | undefined;
    {
      const groveDir = this.groveDir;
      const projectRoot = groveDir ? resolve(groveDir, "..") : process.cwd();
      const baseDir = groveDir
        ? join(groveDir, "workspaces")
        : join(projectRoot, ".grove", "workspaces");

      // Resolve base branch from topology edge types.
      // delegates/feeds/escalates → target branches off source's grove branch.
      // All other edges (and no-topology case) → HEAD.
      const wsSessionId = this.sessionId ?? spawnId;
      const baseBranch = this.topology
        ? (resolveRoleWorkspaceStrategies(this.topology, wsSessionId).get(roleId) ?? "HEAD")
        : "HEAD";

      let provisioned: import("../core/workspace-provisioner.js").ProvisionedWorkspace | undefined;
      let fallbackReason: string | undefined;
      try {
        await this.ensureReposResolved();
        const primaryRepo = this.resolvedRepos[0];
        if (!primaryRepo) {
          throw new Error("SpawnManager: resolved repo list is empty after repository resolution.");
        }
        // Use wsSessionId (stable session-level ID) so branch names are predictable
        // and match what resolveRoleWorkspaceStrategies() computes for dependents.
        provisioned = await provisionWorkspace({
          role: roleId,
          sessionId: wsSessionId,
          baseDir,
          bareClonePath: primaryRepo.bareClonePath,
          baseBranch,
        });
        workspacePath = provisioned.path;
        provisionedWorkspacePath = provisioned.path;
        provisionedBranch = provisioned.branch;
        provisionedRepoCwd = primaryRepo.bareClonePath;
      } catch (provisionErr) {
        const reason = provisionErr instanceof Error ? provisionErr.message : String(provisionErr);
        debugLog("spawn", `workspace provisioning failed for role=${roleId}: ${reason}`);
        if (this.workspaceIsolationPolicy === "strict") {
          throw new Error(`Workspace provisioning failed for '${roleId}': ${reason}`);
        }
        // allow-fallback: try provider.checkoutWorkspace
        if (this.provider.checkoutWorkspace) {
          workspacePath = await this.provider.checkoutWorkspace(spawnId, agent);
          fallbackReason = reason;
          workspaceMode = { status: "fallback_workspace", path: workspacePath, reason };
        } else {
          throw new Error(`Failed to create git worktree and no fallback available: ${reason}`);
        }
      }

      // Step 2: Write config files.
      // Claims are NOT auto-created on spawn — agents create claims explicitly
      // via grove_claim MCP tool when they need swarm coordination.
      try {
        await mkdir(workspacePath, { recursive: true });
        await this.writeMcpConfig(workspacePath);
        await this.writeAgentInstructions(workspacePath, roleId, context);
        if (context?.rolePrompt || context?.roleDescription) {
          await this.writeAgentContext(workspacePath, roleId, context);
        }
        // Inject skills declared by the role. SpawnManager does not use the shared
        // bootstrapWorkspace; the parallel path performs the same injection to land
        // `.claude/skills/{name}/` and `.codex/skills/{name}/` in the workspace.
        const roleSkills = Array.isArray(context?.skills)
          ? (context.skills as readonly string[])
          : [];
        if (roleSkills.length > 0 && this.groveDir) {
          const resolvedSkillCatalog = await this.resolveSkillRootForSpawn(roleSkills);
          await injectSkills({
            workspacePath,
            skills: roleSkills,
            bundledSkillsRoot:
              resolvedSkillCatalog?.root ?? resolveBundledSkillsRoot(dirname(this.groveDir)),
            workspaceOverrideRoot: resolvedSkillCatalog ? undefined : join(this.groveDir, "skills"),
          });
        }
        // Protect config files from agent mutation (#7 Workspace Mutation Constraints)
        for (const protectedFile of [
          ".mcp.json",
          ".acpxrc.json",
          "CLAUDE.md",
          "CODEX.md",
          ".grove-role",
        ]) {
          const filePath = join(workspacePath, protectedFile);
          await chmod(filePath, 0o444).catch(() => {
            // File may not exist — non-fatal
          });
        }
        await this.hideBootstrapFilesFromGit(workspacePath);
        if (provisioned !== undefined) {
          workspaceMode = {
            status: "isolated_worktree",
            path: provisioned.path,
            branch: provisioned.branch,
          };
        } else {
          workspaceMode = {
            status: "fallback_workspace",
            path: workspacePath,
            reason: fallbackReason ?? "git worktree provisioning failed",
          };
        }
      } catch (configErr) {
        const reason = configErr instanceof Error ? configErr.message : String(configErr);
        if (
          this.workspaceIsolationPolicy === "strict" ||
          isRequiredSkillCatalogResolutionError(configErr)
        ) {
          throw new Error(`Bootstrap failed for '${roleId}': ${reason}`);
        }
        this.onError(`Config write failed: ${reason}`);
        if (provisioned !== undefined) {
          workspaceMode = { status: "bootstrap_failed", path: provisioned.path, reason };
        } else {
          workspaceMode = {
            status: "fallback_workspace",
            path: workspacePath,
            reason: `${fallbackReason ?? "git worktree provisioning failed"}; bootstrap failed: ${reason}`,
          };
        }
      }
    }

    // Step 3: Start agent session via AgentRuntime (preferred) or tmux (fallback).
    try {
      const roleEnv: Record<string, string> = {
        GROVE_AGENT_ID: spawnId,
        GROVE_AGENT_ROLE: roleId,
      };
      const prEnv: Record<string, string> = this.prContext
        ? {
            GROVE_PR_NUMBER: String(this.prContext.number),
            GROVE_PR_TITLE: this.prContext.title,
            GROVE_PR_FILES: String(this.prContext.filesChanged),
          }
        : {};

      // Build initial prompt from goal + role
      let initialPrompt: string | undefined;
      if (this.sessionGoal || context?.roleGoal || context?.rolePrompt) {
        const parts: string[] = [];
        if (this.sessionGoal) parts.push(this.sessionGoal);
        if (context?.roleGoal) parts.push(String(context.roleGoal));
        else if (context?.rolePrompt) parts.push(String(context.rolePrompt));
        else if (context?.roleDescription) parts.push(String(context.roleDescription));
        parts.push("Read CLAUDE.md for full instructions.");
        initialPrompt = parts.join(". ");
      }

      // Compose agent command with auto-approve flags.
      // The prompt is passed via AgentConfig.prompt, NOT embedded in the command
      // string — avoids shell injection and decouples "what to run" from "what to say".
      let agentCommand = command;
      const baseCmd = command.split(/\s+/)[0] ?? command;
      if (baseCmd === "claude") {
        agentCommand = `rm -f ~/.claude/remote-settings.json; ${command} --dangerously-skip-permissions`;
      } else if (baseCmd === "codex") {
        agentCommand = `${command} --full-auto`;
      }

      if (this.agentRuntime) {
        // Use AgentRuntime interface — works with acpx, subprocess, or any runtime
        // Only an explicit launch context can suppress the initial prompt.
        // Role prompts often say "wait for feedback" after the first action;
        // treating that as passive mode prevents starter roles from ever
        // receiving their first instruction.
        const waitForPush = context?.waitForPush === true;

        // Extract platform/model from context (set by topology role or profile overlay)
        const platform = context?.platform as
          | import("../core/topology.js").AgentPlatformType
          | undefined;
        const model = context?.model as string | undefined;

        const agentConfig: AgentConfig = {
          role: roleId,
          command: agentCommand,
          cwd: workspacePath,
          env: { ...roleEnv, ...prEnv },
          // initialPrompt already contains the session goal + role details + "Read CLAUDE.md".
          // Use it as goal so runtimes send the complete message (not just the bare session goal).
          goal: initialPrompt ?? this.sessionGoal,
          prompt: initialPrompt,
          waitForPush,
          platform,
          model,
          // Forward grove's MCP server so AcpRuntime hands grove_submit_work /
          // grove_submit_review / grove_done to the agent via ACP's session/new.
          // Workspace-local .mcp.json is still written (see writeMcpConfig)
          // for CLIs that discover MCP from disk, but adapters that rely on
          // ACP's mcpServers parameter need it on the protocol level.
          ...(this.groveMcpServer ? { mcpServers: [this.groveMcpServer] } : {}),
        };
        const session = await this.agentRuntime.spawn(roleId, agentConfig);
        this.agentSessions.set(spawnId, session);
        this.routableSessions.add(spawnId);
      } else if (this.tmux) {
        // Fallback: tmux (for TUI testing)
        const options: SpawnOptions = {
          agentId: spawnId,
          command: agentCommand,
          targetRef: spawnId,
          workspacePath,
          env: { ...roleEnv, ...prEnv },
        };
        await this.tmux.spawn(options);
      } else {
        throw new Error("No agent runtime or tmux available for spawning");
      }
    } catch (spawnErr) {
      // Roll back workspace on spawn failure.
      //
      // `cleanWorkspace` is keyed off the workspace registry (getWorkspace
      // returns undefined when there's no row) and the spawn record isn't
      // persisted until after this catch, so the registry path can no-op.
      // Explicitly remove the provisioned worktree path so failures here
      // (e.g. codex isolation prep throw on disk-full / quota) don't strand
      // an orphaned git worktree + branch on disk for later operators to
      // discover. `git worktree remove` is preferred (cleans the parent
      // repo's metadata too); fall back to `rm -rf` for non-worktree paths.
      if (this.provider.cleanWorkspace) {
        await safeCleanup(
          this.provider.cleanWorkspace(spawnId, spawnId),
          "rollback workspace after spawn failure",
          { silent: true },
        );
      }
      if (provisionedWorkspacePath) {
        // Use execFileSync with argv (NOT execSync with a shell-interpolated
        // command string) so role names containing shell metacharacters
        // can't escape into command substitution.
        // Run from the owning bare-clone repo so `git worktree remove`
        // touches the correct .git/worktrees/* metadata; the operator's
        // current cwd may not be the repo that owns this worktree.
        const gitOpts: { stdio: "ignore"; cwd?: string } = { stdio: "ignore" };
        if (provisionedRepoCwd) gitOpts.cwd = provisionedRepoCwd;
        try {
          execFileSync("git", ["worktree", "remove", "--force", provisionedWorkspacePath], gitOpts);
        } catch {
          try {
            const { rmSync } = await import("node:fs");
            rmSync(provisionedWorkspacePath, { recursive: true, force: true });
          } catch {
            /* best-effort */
          }
        }
        // Always also delete the branch — `git worktree remove` skips it,
        // and rm -rf doesn't touch repo metadata. Without this, retrying
        // the same role/session hits "branch already exists" on the next
        // provision attempt.
        if (provisionedBranch) {
          try {
            execFileSync("git", ["branch", "-D", provisionedBranch], gitOpts);
          } catch {
            /* best-effort — branch may already be gone */
          }
        }
      }
      throw spawnErr;
    }

    // Step 3b: Inbox provisioning is handled by Nexus during agent
    // registration (see nexus/system_services/agent_registration.py — the
    // post-#3912 code path materializes `/ipc/{role}/inbox/` on first
    // touch). The legacy `/api/v2/ipc/provision/{role}` route was removed,
    // so no explicit call is needed here.

    // Step 4: Record spawn + register for IPC push + create log buffer.
    // No claims, no heartbeats — agents create claims themselves via grove_claim
    // when they need swarm coordination.
    this.ensureLogBuffer(roleId);
    this.spawnRecords.set(spawnId, {
      claimId: "",
      targetRef: spawnId,
      agentId: spawnId,
      workspacePath,
      role: roleId,
    });
    // Store the actual runtime session ID so reconcile() can correctly
    // match stored records to live acpx sessions. Without this, reconcile
    // constructs "grove-{spawnId}" which never matches the acpx name
    // "grove-{role}-{counter}-{ts}", causing fallback on every TUI restart.
    const acpxSessionId = this.agentSessions.get(spawnId)?.id;
    this.sessionStore?.save({
      spawnId,
      claimId: "",
      targetRef: spawnId,
      agentId: spawnId,
      workspacePath,
      spawnedAt: new Date().toISOString(),
      ...(acpxSessionId ? { acpxSessionId } : {}),
    });

    // Step 5: Register session with NexusWsBridge for push-based IPC.
    // When another agent contributes, Nexus pushes via WebSocket → bridge
    // forwards to this agent via runtime.send(). No polling.
    const agentSession = this.agentSessions.get(spawnId);
    if (agentSession && this.wsBridge) {
      this.wsBridge.registerSession(roleId, agentSession);
    }
    if (agentSession) {
      this.registerAcpSession(roleId, agentSession.id);
    }

    return {
      spawnId,
      claimId: "",
      workspacePath,
      workspaceMode: workspaceMode,
    };
  }

  /**
   * Kill an agent session and clean up all associated state.
   *
   * Uses local spawn records so cleanup works even if the claim's
   * lease has expired (no longer returned by active claim queries).
   */
  async kill(sessionName: string): Promise<void> {
    // Step 1: Kill agent session via runtime or tmux
    const killedAgentId = agentIdFromSession(sessionName);
    const agentSession = killedAgentId ? this.agentSessions.get(killedAgentId) : undefined;
    if (agentSession && this.agentRuntime) {
      await this.agentRuntime.close(agentSession);
      if (killedAgentId) this.agentSessions.delete(killedAgentId);
    } else {
      await this.tmux?.kill(sessionName);
    }

    // Step 2: Clean up local records + workspace
    if (!killedAgentId) return;

    const tracked = this.spawnRecords.get(killedAgentId);
    if (tracked) {
      this.spawnRecords.delete(killedAgentId);
      this.sessionStore?.remove(killedAgentId);
      // Bridge is role-keyed (NexusWsBridge tracks sessions + per-role
      // AbortControllers by role name), but `killedAgentId` is the
      // spawnId (`role-timestamp`). Passing spawnId here would miss the
      // registered entry, leave the SSE loop running, and allow the
      // stale loop to fire onRoleUnhealthy or consume events after kill.
      //
      // Ownership-check the unregister so killing one spawn of a role
      // does not cut off a sibling spawn sharing the same role (e.g. two
      // `coder` instances under `maxInstances > 1`). The bridge only
      // releases the role binding when the currently-registered session
      // id matches the killed session's id.
      const roleKey = tracked.role ?? agentSession?.role ?? killedAgentId;
      this.wsBridge?.unregisterSession(roleKey, agentSession?.id);
      // AcpSessionStore is keyed by the runtime's agentSession.id (e.g.
      // `grove-coder-0-abc123`), which may differ from `killedAgentId`
      // (the spawn-manager's agentId key). Prefer the captured
      // agentSession.id; fall back to killedAgentId for legacy paths.
      this.unregisterAcpSession(agentSession?.id ?? killedAgentId);

      if (this.provider.cleanWorkspace) {
        await safeCleanup(
          this.provider.cleanWorkspace(tracked.targetRef, killedAgentId),
          "clean workspace during kill",
          { silent: true },
        );
      }
    }
  }

  /** Get the spawn record for an agentId (for testing). */
  getSpawnRecord(agentId: string): SpawnRecord | undefined {
    return this.spawnRecords.get(agentId);
  }

  /** Count active spawns per role — used by palette for capacity checks. */
  getActiveSpawnCounts(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const [spawnId] of this.spawnRecords) {
      // spawnId format: "roleName-timestamp"
      const role = spawnId.replace(/-[a-z0-9]+$/i, "");
      counts.set(role, (counts.get(role) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Reconcile persisted session state with live tmux sessions.
   *
   * Called on TUI startup to recover from crashes. Uses two data sources:
   * 1. Local file store (.grove/tui-sessions.json) — fast, survives crashes
   * 2. Claim store (SQLite/Nexus) — authoritative, survives machine migration
   *
   * For each persisted record:
   * - Live tmux session → reattach (restore in-memory state + restart heartbeat)
   * - Dead tmux session → release claim + clean workspace + remove record
   */
  async reconcile(): Promise<{ reattached: number; released: number }> {
    // Collect records from local file store
    const fileRecords = this.sessionStore?.loadAll() ?? [];

    // Also query claims with tuiSpawned context as Nexus-backed fallback.
    // This catches records that survive across machines or when the local
    // file store is lost (e.g., different checkout, wiped .grove).
    const claimRecords = await this.loadRecordsFromClaims();

    // Merge: file records take precedence (more fields), claim records fill gaps
    const seen = new Set<string>();
    const allRecords: PersistedSpawnRecord[] = [];
    for (const r of fileRecords) {
      seen.add(r.spawnId);
      allRecords.push(r);
    }
    for (const r of claimRecords) {
      if (!seen.has(r.spawnId)) {
        allRecords.push(r);
      }
    }

    // Get live agent sessions from runtime or tmux
    let liveSet: Set<string>;
    if (this.agentRuntime) {
      const sessions = await this.agentRuntime.listSessions();
      liveSet = new Set(sessions.map((s) => s.id));
    } else {
      const liveSessions = (await this.tmux?.listSessions()) ?? [];
      liveSet = new Set(liveSessions);
    }

    let reattached = 0;
    let released = 0;

    // Build a map of live sessions for quick lookup
    const liveSessionMap = new Map<string, import("../core/agent-runtime.js").AgentSession>();
    if (this.agentRuntime) {
      for (const session of await this.agentRuntime.listSessions()) {
        liveSessionMap.set(session.id, session);
      }
    }

    for (const record of allRecords) {
      // Use the stored acpx session ID when available. Without it, we'd construct
      // "grove-{spawnId}" which never matches the actual acpx name format
      // "grove-{role}-{counter}-{timestamp}" — causing reattached=0 every time.
      const acpxId = (record as { acpxSessionId?: string }).acpxSessionId;
      const lookupId = acpxId ?? `grove-${record.spawnId}`;
      debugLog(
        "reconcile",
        `checking record spawnId=${record.spawnId} lookupId=${lookupId} inLiveSet=${liveSet.has(lookupId)}`,
      );

      if (liveSet.has(lookupId)) {
        // Re-attach: restore in-memory state
        this.spawnRecords.set(record.spawnId, {
          claimId: record.claimId,
          targetRef: record.targetRef,
          agentId: record.agentId,
          workspacePath: record.workspacePath,
        });
        // Also restore agent session so sendToAgent/getActiveRoles work
        const liveSession = liveSessionMap.get(lookupId);
        if (liveSession) {
          this.agentSessions.set(record.spawnId, liveSession);
          // Mark as routable — this is a verified session from our store
          this.routableSessions.add(record.spawnId);
        }
        // Ensure log buffer exists for reconciled agents
        const role = record.spawnId.replace(/-[a-z0-9]+$/i, "");
        this.ensureLogBuffer(role);
        reattached++;
        debugLog("reconcile", `reattached spawnId=${record.spawnId} acpxId=${lookupId}`);
      } else {
        // Dead session: clean workspace + remove record
        debugLog("reconcile", `dead session spawnId=${record.spawnId} — cleaning up`);
        if (this.provider.cleanWorkspace) {
          await safeCleanup(
            this.provider.cleanWorkspace(record.targetRef, record.agentId),
            `clean orphaned workspace for ${record.spawnId}`,
            { silent: true },
          );
        }
        this.sessionStore?.remove(record.spawnId);
        released++;
      }
    }

    // Fallback: scan live acpx sessions and reattach those whose workspace
    // is under this grove's workspaces directory (filters out other projects).
    //
    // This path fires when the session store has no records (first launch ever,
    // store was lost, or all sessions were cleaned up). With acpxSessionId stored,
    // this should be rare in normal operation.
    //
    // IMPORTANT: Only the MOST RECENT session per role is added here, and it is
    // marked routable. This matches the expected "single active session per role"
    // invariant. With 200+ stale sessions, the list is sorted newest-first by
    // acpx so the most recent match is used.
    if (reattached === 0 && this.agentRuntime && this.groveDir) {
      const workspacesPrefix = join(this.groveDir, "workspaces");
      // acpx sessions list includes the cwd — use it to filter
      try {
        const output = execSync("acpx codex sessions list", { encoding: "utf-8", stdio: "pipe" });
        debugLog("reconcile", `fallback: scanning acpx sessions (reattached=0)`);
        for (const line of output.trim().split("\n").filter(Boolean)) {
          const fields = line.split("\t");
          const name = (fields[1] ?? "").trim();
          const cwd = (fields[2] ?? "").trim();
          const isClosed = line.includes("[closed]");
          if (!name.startsWith("grove-") || isClosed) continue;
          if (!cwd.startsWith(workspacesPrefix) && !cwd.startsWith(`/private${workspacesPrefix}`))
            continue;

          // Acpx names follow the canonical runtime contract; the acpx-aware
          // parser also accepts the prior single-dash shape so rediscovery
          // still works for live agents created on the previous grove version.
          const parsed = parseAcpxSessionId(name);
          if (!parsed) continue;
          const role = parsed.role;
          if (role && !this.agentSessions.has(role)) {
            const session = liveSessionMap.get(name);
            if (session) {
              this.agentSessions.set(role, session);
              this.routableSessions.add(role); // mark as routable — first (newest) match per role
              this.spawnRecords.set(role, {
                claimId: "",
                targetRef: role,
                agentId: role,
                workspacePath: cwd,
                role,
              });
              reattached++;
              debugLog("reconcile", `fallback reattached role=${role} acpxId=${name}`);
            }
          }
        }
      } catch {
        // Best-effort
      }
    }

    return { reattached, released };
  }

  /**
   * Query active claims with `tuiSpawned: true` context and convert to
   * PersistedSpawnRecords. This is the Nexus-backed recovery path.
   */
  private async loadRecordsFromClaims(): Promise<readonly PersistedSpawnRecord[]> {
    try {
      const claims = await this.provider.getClaims({ status: "active" });
      const records: PersistedSpawnRecord[] = [];
      for (const claim of claims) {
        const ctx = claim.context as Record<string, unknown> | undefined;
        if (ctx?.tuiSpawned === true && typeof ctx.spawnId === "string") {
          records.push({
            spawnId: ctx.spawnId as string,
            claimId: claim.claimId,
            targetRef: claim.targetRef,
            agentId: claim.agent.agentId,
            workspacePath:
              typeof ctx.workspacePath === "string" ? (ctx.workspacePath as string) : "",
            spawnedAt: claim.createdAt,
          });
        }
      }
      return records;
    } catch {
      // Claims query may fail (e.g., Nexus unreachable) — degrade gracefully
      return [];
    }
  }

  /**
   * Send a user message to a specific agent role.
   *
   * Looks up the active agent session for the given role and pushes the
   * message via runtime.send(). This triggers the agent to process the
   * message as if it were an IPC notification.
   */
  async sendToAgent(role: string, message: string): Promise<boolean> {
    if (!this.agentRuntime) return false;

    for (const [spawnId, session] of this.agentSessions) {
      if (spawnId.startsWith(role)) {
        const turn = await this.agentRuntime.send(session, message);
        watchTurnError(turn, `sendToAgent(${role})`, (m) => {
          debugLog("route", m);
          process.stderr.write(`${m}\n`);
        });
        return true;
      }
    }
    return false;
  }

  /** Get list of active agent roles (for UI display). */
  getActiveRoles(): string[] {
    const roles: string[] = [];
    for (const spawnId of this.agentSessions.keys()) {
      const role = spawnId.replace(/-[a-z0-9]+$/i, "");
      if (!roles.includes(role)) roles.push(role);
    }
    return roles;
  }

  // ─── Log buffer management (issue #183) ───

  /** Get all per-agent log buffers (for TracePane). */
  /** Current topology. Read by external callers (e.g. tui-app bridge
   * callbacks) that need to decide fail-closed behavior based on the
   * live session topology rather than a stale appProps capture. */
  getTopology(): AgentTopology | undefined {
    return this.topology;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getLogBuffers(): ReadonlyMap<string, AgentLogBuffer> {
    return this.logBuffers;
  }

  /** Set the session ID for log buffer naming and persistence. */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  /**
   * Ensure an AgentLogBuffer exists for a role. Creates one if missing.
   * Called at spawn time and on reconcile.
   */
  ensureLogBuffer(role: string): AgentLogBuffer {
    let buffer = this.logBuffers.get(role);
    if (!buffer) {
      buffer = new AgentLogBuffer(role, this.sessionId ?? "unknown");
      this.logBuffers.set(role, buffer);
    }
    return buffer;
  }

  /**
   * Start polling log files for all active agent roles.
   * Call once after spawn/reconcile. Subsequent calls restart the timer.
   */
  startLogPolling(intervalMs: number = 2000, seekToEnd = false): void {
    this.stopLogPolling();
    if (!this.groveDir) return;
    const logDir = `${this.groveDir}/agent-logs`;

    // On fresh session start, record the current end-of-file byte offset for
    // ALL existing log files for each role. This prevents old data from being
    // shown when a new session starts.
    //
    // WHY per-path, not just newest file:
    //   acpx recycles numbered log files (coder-0.log, coder-1.log) — the new
    //   session might write to ANY of them. recordSeekPosition() stores the
    //   current size of each file; pollLogFile() restores the offset when it
    //   creates a new reader, even if the path differs from the current reader.
    //
    // WHY synchronous statSync (not async seekToEnd):
    //   reconcile() calls startLogPolling() shortly after (same async chain).
    //   If we used async seeks, the positions might not be set yet when the
    //   first pollAll() fires → read from byte 0 → old data included.
    if (seekToEnd) {
      try {
        const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
        const files = readdirSync(logDir).filter((f: string) => f.endsWith(".log"));
        for (const [role, buffer] of this.logBuffers) {
          const roleFiles = files.filter(
            (f: string) => f === `${role}.log` || f.startsWith(`${role}-`),
          );
          let seekCount = 0;
          for (const roleFile of roleFiles) {
            try {
              const fileSize = statSync(`${logDir}/${roleFile}`).size;
              buffer.recordSeekPosition(`${logDir}/${roleFile}`, fileSize);
              seekCount++;
            } catch {
              // File unreadable — skip
            }
          }
          buffer.clearForNewSession();
          debugLog(
            "seekToEnd",
            `role=${role} seeked ${seekCount} file(s): [${roleFiles.join(",")}]`,
          );
        }
      } catch (e) {
        debugLog("seekToEnd", `error: ${String(e)}`);
      }
    }

    let pollCount = 0;
    const pollAll = () => {
      // Scan log directory for files matching each role (e.g., coder-0.log, coder-1.log)
      try {
        const { readdirSync } = require("node:fs") as typeof import("node:fs");
        const files = readdirSync(logDir).filter((f: string) => f.endsWith(".log"));
        if (pollCount < 3 || pollCount % 10 === 0) {
          debugLog(
            "poll",
            `#${pollCount} logDir=${logDir} files=[${files.join(",")}] buffers=[${[...this.logBuffers.keys()].join(",")}]`,
          );
        }
        for (const [role, buffer] of this.logBuffers) {
          // Find the most recently modified log file for this role
          const { statSync } = require("node:fs") as typeof import("node:fs");
          const roleFile = files
            .filter((f: string) => f === `${role}.log` || f.startsWith(`${role}-`))
            .sort((a: string, b: string) => {
              try {
                return statSync(`${logDir}/${b}`).mtimeMs - statSync(`${logDir}/${a}`).mtimeMs;
              } catch {
                return 0;
              }
            })[0];
          if (roleFile) {
            void buffer
              .pollLogFile(`${logDir}/${roleFile}`)
              .then(() => {
                if (buffer.size > 0 && (pollCount < 5 || pollCount % 10 === 0)) {
                  debugLog("poll", `role=${role} file=${roleFile} bufferSize=${buffer.size}`);
                }
              })
              .catch(() => {
                /* non-fatal */
              });
          }
        }
        pollCount++;
      } catch (err) {
        debugLog("poll", `error: ${String(err)}`);
      }
    };

    this.logPollTimer = startInterval(pollAll, intervalMs);
    if (!seekToEnd) {
      pollAll(); // Also poll immediately (skip initial sync poll when seekToEnd — async seek must complete first)
    }
  }

  /** Stop the log polling timer. */
  stopLogPolling(): void {
    if (this.logPollTimer !== null) {
      this.logPollTimer();
      this.logPollTimer = null;
    }
    // NOTE: do NOT clear routableSessions here — spawn() populates it before the session runs.
  }

  /**
   * Save all trace buffers to JSONL. Called on session end.
   * Returns immediately if no groveDir or sessionId.
   */
  async saveTraces(): Promise<void> {
    debugLog(
      "save",
      `groveDir=${this.groveDir} sessionId=${this.sessionId} bufferCount=${this.logBuffers.size} sizes=[${[...this.logBuffers.entries()].map(([r, b]) => `${r}:${b.size}`).join(",")}]`,
    );
    if (!this.groveDir || !this.sessionId) return;
    await saveTraceHistory(this.groveDir, this.sessionId, this.logBuffers);
    debugLog("save", "done");
  }

  /**
   * Load trace history from JSONL into buffers. Called on resume.
   * Creates buffers for each role found in the session directory.
   */
  async loadTraces(sessionIdToLoad: string): Promise<void> {
    if (!this.groveDir) return;
    const loaded = await loadTraceHistory(this.groveDir, sessionIdToLoad);
    for (const [role, buffer] of loaded) {
      this.logBuffers.set(role, buffer);
    }
  }

  /**
   * Rsync workspace files from sender role to recipient role.
   * Called by NexusWsBridge.onBeforeDeliver — ensures the recipient sees
   * the sender's latest files before receiving the IPC notification.
   */
  syncWorkspaces(senderRole: string, recipientRole: string): void {
    if (!this.groveDir) return;
    const sourceWs = this.workspacePathForRole(senderRole);
    const targetWs = this.workspacePathForRole(recipientRole);
    if (!sourceWs || !targetWs) return;
    try {
      execSync(
        `rsync -a --exclude='.git' --exclude='.mcp.json' --exclude='CODEX.md' --exclude='CLAUDE.md' --exclude='.grove-role' "${sourceWs}/" "${targetWs}/"`,
        { stdio: "pipe", timeout: 10_000 },
      );
      debugLog("syncWorkspaces", `${senderRole}→${recipientRole} OK`);
    } catch (err) {
      debugLog(
        "syncWorkspaces",
        `${senderRole}→${recipientRole} FAIL: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private workspacePathForRole(role: string): string | undefined {
    if (!this.groveDir) return undefined;
    for (const [spawnId, record] of this.spawnRecords) {
      const recordRole = record.role ?? spawnId.replace(/-[a-z0-9]+$/i, "");
      if (recordRole !== role) continue;
      if (record.workspacePath && existsSync(record.workspacePath)) {
        return record.workspacePath;
      }
      // Legacy records from before workspacePath was tracked used the
      // spawnId as the workspace directory name.
      const legacyPath = join(this.groveDir, "workspaces", spawnId);
      if (existsSync(legacyPath)) return legacyPath;
    }
    return undefined;
  }

  /**
   * Close bridge and clear state.
   *
   * Closes all active agent sessions so they don't accumulate in acpx
   * across TUI restarts. Without this, each test run leaves sessions that
   * interfere with reconcile fallback and make `acpx sessions list` noisy.
   */
  /**
   * Async variant that awaits a bounded final dead-letter drain before
   * synchronous teardown. Prefer this over `destroy()` in process-exit
   * shutdown paths where recovery-state preservation matters. React
   * useEffect cleanups (which cannot await) still use the sync `destroy()`
   * and accept a best-effort detached drain.
   */
  async destroyAsync(shutdownTimeoutMs = 10000): Promise<void> {
    if (this.wsBridge) {
      await this.wsBridge.shutdown(shutdownTimeoutMs).catch(() => {
        /* best-effort */
      });
    }
    this.destroy();
  }

  destroy(): void {
    this.stopLogPolling();
    this.routableSessions.clear();
    // Settle any in-flight waitForDelivery calls so destroy() doesn't
    // leave per-waiter timers holding the event loop open. Route via
    // markDeliveryDisabled to reject all waiters and clear their timers
    // through the existing cleanup() path registered in waitForDelivery.
    if (this.deliveryReadyWaiters.length > 0) {
      this.markDeliveryDisabled("SpawnManager destroyed");
    }
    // Close all agent sessions via runtime to prevent accumulation
    if (this.agentRuntime) {
      const runtime = this.agentRuntime as Partial<AcpEventSinkRuntime>;
      runtime.setAcpEventSink?.(undefined);
      for (const session of this.agentSessions.values()) {
        void this.agentRuntime.close(session).catch(() => {
          /* best-effort — session may already be gone */
        });
      }
    }
    for (const buffer of this.logBuffers.values()) {
      buffer.dispose();
    }
    this.logBuffers.clear();
    this.spawnRecords.clear();
    for (const unsubscribe of this.acpProjections.values()) {
      unsubscribe();
    }
    this.acpProjections.clear();
    this.acpSessionStore?.dispose();
    this.agentSessions.clear();
    this.wsBridge?.close();
  }

  /**
   * Write .mcp.json into the agent workspace so the agent CLI (claude, codex)
   * discovers grove MCP tools automatically.
   */
  private async writeMcpConfig(workspacePath: string): Promise<void> {
    // Prefer the active session's .grove directory. Fallback workspaces for
    // Nexus-backed providers can live outside `.grove/workspaces`, so deriving
    // the Grove root from `workspacePath` can point MCP at the wrong project.
    const groveDir = this.groveDir ?? join(workspacePath, "..", "..");
    // Resolve the project root (parent of .grove) for finding src/mcp/serve.ts.
    const projectRoot = join(groveDir, "..");

    // Resolve Nexus URL: env var takes precedence (explicit override), then
    // fall back to managed nexus.yaml or the nexusUrl stored in the session's
    // .grove/grove.json.
    //
    // Note: `groveDir` here is the SHARED nexus-workspaces dir (parent of all
    // workspace folders), not the per-session .grove dir — so we can't read
    // grove.json from it. Use `this.groveDir` (the SpawnManager's session-level
    // .grove path) for the config lookup instead.
    //
    // Agents' MCP servers need GROVE_NEXUS_URL so contributions go to Nexus
    // (enables IPC push via NexusEventBus + TopologyRouter). Without it,
    // contributions only land in local SQLite and the reviewer is never notified.
    let resolvedNexusUrl: string | undefined = process.env.GROVE_NEXUS_URL;
    if (!resolvedNexusUrl && this.groveDir) {
      try {
        const configPath = join(this.groveDir, "grove.json");
        if (existsSync(configPath)) {
          const raw = await readFile(configPath, "utf-8");
          try {
            const config = parseGroveConfig(raw);
            resolvedNexusUrl = resolveConfiguredNexusUrl({
              projectRoot,
              config,
              env: process.env,
            });
          } catch {
            const config = JSON.parse(raw) as {
              readonly mode?: string | undefined;
              readonly nexusManaged?: boolean | undefined;
              readonly nexusUrl?: string | undefined;
            };
            resolvedNexusUrl = resolveConfiguredNexusUrl({
              projectRoot,
              config,
              env: process.env,
            });
          }
        }
      } catch {
        /* best-effort */
      }
    }

    // MCP server needs GROVE_NEXUS_URL so contributions are written to Nexus
    // (enables IPC push via NexusEventBus + TopologyRouter for agent routing).
    // Without it, contributions only go to local SQLite and reviewer never gets notified.
    const mcpEnv: Record<string, string> = {
      GROVE_DIR: groveDir,
    };
    if (resolvedNexusUrl) {
      mcpEnv.GROVE_NEXUS_URL = resolvedNexusUrl;
    }
    if (process.env.NEXUS_API_KEY) {
      mcpEnv.NEXUS_API_KEY = process.env.NEXUS_API_KEY;
    }
    // Pass session ID so MCP stores scope contributions + handoffs to this session
    if (this.sessionId) {
      mcpEnv.GROVE_SESSION_ID = this.sessionId;
    }
    // Forward GROVE_DEBUG to spawned MCP agents. debugLog() in the agent-side
    // NexusContributionStore / NexusHandoffStore reads this env var at module
    // load, but those run inside a separate child process whose env is dictated
    // by .mcp.json / .acpxrc.json — not inherited from the parent shell. Without
    // this passthrough, GROVE_DEBUG=1 in the TUI never enables agent-side traces.
    if (process.env.GROVE_DEBUG) {
      mcpEnv.GROVE_DEBUG = process.env.GROVE_DEBUG;
    }

    // Find the grove MCP server: check dist/ first (installed), then src/ (dev)
    const mcpServePath = resolveMcpServePath(projectRoot);
    const mcpCommand = process.execPath;
    debugLog("mcpConfig", `selected mcpServePath=${mcpServePath}`);

    // Cache the grove MCP server definition so AgentConfig.mcpServers can
    // forward it via ACP's session/new. Otherwise AcpRuntime would spawn with
    // mcpServers=[] and agents that rely on ACP-forwarded MCP (rather than
    // discovering .mcp.json locally) have no grove_* tools available.
    this.groveMcpServer = {
      name: "grove",
      command: mcpCommand,
      args: ["run", mcpServePath],
      env: { ...mcpEnv },
    };
    if (process.env.GROVE_CODEX_WRITE_MCP_CONFIG === "1") {
      await this.writeCodexMcpHomeConfig(this.groveMcpServer);
    }

    const mcpConfig = {
      mcpServers: {
        grove: {
          command: mcpCommand,
          args: ["run", mcpServePath],
          env: mcpEnv,
        },
      },
    };
    await writeFile(join(workspacePath, ".mcp.json"), JSON.stringify(mcpConfig, null, 2), "utf-8");
    debugLog(
      "mcpConfig",
      `wrote .mcp.json: serve=${mcpServePath} hasNexusUrl=${!!mcpEnv.GROVE_NEXUS_URL} GROVE_DIR=${mcpEnv.GROVE_DIR}`,
    );

    // Also write .acpxrc.json — acpx (>=0.5.3) reads this, NOT .mcp.json.
    // acpx forwards mcpServers to claude-agent-acp via ACP protocol, enabling
    // native grove_* tool calls in the agent. Without this file, acpx launches
    // claude with mcpServers=[] and the agent falls back to curling the HTTP
    // MCP endpoint, which bypasses per-session Nexus scoping and handoff routing.
    // Schema: array of servers with `name`, `type`, `command`, `args`, `env: [{name,value}]`.
    const acpxRcConfig = {
      mcpServers: [
        {
          name: "grove",
          type: "stdio",
          command: mcpCommand,
          args: ["run", mcpServePath],
          env: Object.entries(mcpEnv).map(([name, value]) => ({ name, value })),
        },
      ],
    };
    await writeFile(
      join(workspacePath, ".acpxrc.json"),
      JSON.stringify(acpxRcConfig, null, 2),
      "utf-8",
    );
    debugLog("mcpConfig", `wrote .acpxrc.json for acpx mcpServers forwarding`);
  }

  private async writeCodexMcpHomeConfig(server: {
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  }): Promise<void> {
    const codexHome = process.env.CODEX_HOME?.trim();
    if (!codexHome) {
      debugLog("mcpConfig", "GROVE_CODEX_WRITE_MCP_CONFIG set but CODEX_HOME is empty");
      return;
    }

    await mkdir(codexHome, { recursive: true });
    const configPath = join(codexHome, "config.toml");
    let existing = "";
    try {
      existing = await readFile(configPath, "utf-8");
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }

    const stripped = stripGeneratedCodexMcpBlock(existing);
    const block = buildCodexMcpConfigBlock(server);
    const next = `${stripped}${stripped.length > 0 ? "\n\n" : ""}${block}`;
    await writeFile(configPath, next, "utf-8");
    await chmod(configPath, 0o600).catch(() => {
      /* best-effort */
    });
    debugLog(
      "mcpConfig",
      `wrote CODEX_HOME config.toml MCP block: path=${configPath} hasNexusUrl=${!!server.env.GROVE_NEXUS_URL} hasApiKey=${!!server.env.NEXUS_API_KEY}`,
    );
  }

  private async hideBootstrapFilesFromGit(workspacePath: string): Promise<void> {
    let excludePath: string;
    try {
      excludePath = execSync("git rev-parse --git-path info/exclude", {
        cwd: workspacePath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return;
    }
    if (excludePath.length === 0) return;

    const patterns = [
      ".mcp.json",
      ".acpxrc.json",
      "CLAUDE.md",
      "CODEX.md",
      ".grove-role",
      ".grove/",
      ".claude/",
      ".codex/",
    ];
    let existing = "";
    try {
      existing = await readFile(excludePath, "utf-8");
    } catch {
      await mkdir(dirname(excludePath), { recursive: true });
    }

    const existingLines = new Set(existing.split(/\r?\n/));
    const missing = patterns.filter((pattern) => !existingLines.has(pattern));
    if (missing.length === 0) return;
    const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    await appendFile(excludePath, `${prefix}# Grove runtime files\n${missing.join("\n")}\n`);
  }

  /**
   * Write CLAUDE.md (agent instructions) into the workspace.
   * Tells the agent its role. Communication happens automatically via
   * Nexus IPC — agents receive events when other agents contribute.
   */
  private async writeAgentInstructions(
    workspacePath: string,
    roleId: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const roleDescription = context?.roleDescription ?? "";
    const rolePrompt = context?.rolePrompt ?? "";
    const roleGoal = context?.roleGoal ?? "";
    const sessionGoal = this.sessionGoal || "Follow your role instructions below.";

    const instructions = `# Grove Agent: ${roleId}

## Session Goal
${sessionGoal}

## Your Role: ${roleId}
${roleDescription}
${roleGoal ? `\nObjective: ${roleGoal}\n` : ""}
${rolePrompt ? `## Instructions\n${rolePrompt}\n` : ""}

## Identity

You are the **${roleId}** agent. Always pass \`agent: { role: "${roleId}" }\` in all grove tool calls. This is set once here — do not worry about it after this.

## Communication

You will receive push notifications from the system when other agents produce work relevant to you. These arrive as messages in your session — you do NOT need to poll or check for them. Just work on the session goal, and when a notification arrives, act on it.

## MCP Tools — YOU MUST USE THESE

Each tool has specific required fields. Do NOT skip them.

Call Grove through the MCP tool-call interface only. In Codex these tools may
appear with the \`mcp__grove__\` prefix, for example
\`mcp__grove__grove_submit_work\`, \`mcp__grove__grove_submit_review\`, and
\`mcp__grove__grove_done\`. Use those tool calls when present; do not write
custom MCP clients, do not run \`bun --eval\` to call MCP, and do not read or
print \`.mcp.json\` / \`.acpxrc.json\` because those files can contain runtime
credentials.

### Submitting work (coder)

**Preferred path: submit the git commit hash.** After editing files, commit your workspace and call \`grove_submit_work\` with \`commitHash\`:
\`\`\`
git add -A && git commit -m "description"
git rev-parse HEAD
\`\`\`
\`\`\`
grove_submit_work({
  summary: "Created hello.txt",
  commitHash: "<hash from git rev-parse HEAD>",
  agent: { role: "${roleId}" }
})
\`\`\`

Use CAS artifacts only when there is no git commit. If Grove MCP tools are not visible, stop and report that the MCP tools are unavailable instead of shelling out to the MCP server or HTTP endpoint.

### Submitting reviews (reviewer)

First find work to review with \`grove_frontier\` or \`grove_log\`, then:
\`\`\`
grove_submit_review({
  targetCid: "blake3:...",
  summary: "Code is correct, minor style issue",
  scores: { "correctness": { "value": 0.9, "direction": "maximize" } },
  agent: { role: "${roleId}" }
})
\`\`\`

You MUST include at least one score. Without scores the frontier cannot rank work.

### Other tools
- \`grove_discuss\` — Questions and clarifications. NOT for code reviews.
- \`grove_adopt\` — Build on another agent's contribution. Requires \`targetCid\`.
- \`grove_frontier\` — See ranked contributions.
- \`grove_log\` — See all contributions chronologically.
- \`grove_done\` — Signal session complete. See STRICT RULES below.

**CRITICAL: Always call grove_submit_work after making code changes. Without it, nobody sees your work.**
**CRITICAL: Always call grove_submit_review when reviewing. Include scores so the frontier can rank work.**

## STRICT RULES FOR grove_done — READ CAREFULLY

**grove_done TERMINATES THE ENTIRE SESSION. Calling it prematurely will destroy the collaboration.**

### If you are a CODER:
- After calling \`grove_submit_work\`, **STOP and WAIT** for a review message.
- **NEVER** call grove_done yourself. Only the reviewer ends the session.
- When review feedback arrives, fix the issues and call \`grove_submit_work\` again.

### If you are a REVIEWER:
- **Requesting changes?** Call \`grove_submit_review\` with low scores, then **STOP and WAIT** for the coder to fix.
- **Approving?** Call \`grove_submit_review\` with high scores, then **IMMEDIATELY call \`grove_done\`** in the same turn. Do not stop between them.

## Workflow

### Coder workflow:
1. Write code, commit it, and call \`grove_submit_work\` with \`commitHash\`.
2. **STOP. Wait for review.** Do NOT call grove_done.
3. When review arrives, fix issues and \`grove_submit_work\` again.
4. Repeat until reviewer approves.

### Reviewer workflow:
1. Wait for coder's work to arrive.
2. Review the code. Call \`grove_submit_review\` with scores.
3. If requesting changes: **STOP. Wait for coder to fix.**
4. If approving: **Call \`grove_done\` immediately after \`grove_submit_review\`.** This ends the session.
`;

    await writeFile(join(workspacePath, "CLAUDE.md"), instructions, "utf-8");
    // Also write CODEX.md for codex agents (codex reads CODEX.md, not CLAUDE.md)
    await writeFile(join(workspacePath, "CODEX.md"), instructions, "utf-8");
    // Write .grove-role so serve.ts can discover GROVE_AGENT_ROLE at startup
    // if the runtime does not propagate the role environment.
    await writeFile(join(workspacePath, ".grove-role"), roleId, "utf-8");
  }

  private async writeAgentContext(
    workspacePath: string,
    roleId: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    const contextDir = join(workspacePath, ".grove");
    await mkdir(contextDir, { recursive: true });

    const lines: string[] = [`# Agent Context: ${roleId}`, ""];
    if (context.roleDescription) {
      lines.push(`## Role`, "", String(context.roleDescription), "");
    }
    if (context.roleGoal) {
      lines.push(`## Objective`, "", String(context.roleGoal), "");
    }
    if (context.rolePrompt) {
      lines.push(`## Instructions`, "", String(context.rolePrompt), "");
    }
    lines.push(
      `## Available MCP Tools`,
      "",
      "Use MCP tool calls directly. In Codex, these may be exposed as `mcp__grove__<tool>` names. Do not create ad hoc MCP clients or print MCP config files.",
      "",
      "- grove_submit_work — submit work with a git commit hash (preferred) or CAS artifacts",
      "- grove_submit_review — submit a code review with scores (required: targetCid, summary, scores)",
      "- grove_discuss — post a discussion or reply",
      "- grove_reproduce — submit a reproduction attempt",
      "- grove_adopt — adopt a contribution to build on (required: targetCid)",
      "- grove_done — signal session completion",
      "- grove_frontier — discover best contributions to build on",
      "- grove_claim / grove_release — coordinate work to avoid duplication",
      "- grove_checkout — materialize artifacts into your workspace",
      "- grove_send_message / grove_read_inbox — agent-to-agent messaging",
      "- grove_create_plan / grove_update_plan — maintain project plans",
      "- grove_check_stop — check if stop conditions are met",
      "",
    );

    await writeFile(join(contextDir, "agent-context.md"), lines.join("\n"), "utf-8");
  }
}

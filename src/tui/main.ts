/**
 * TUI entry point — launched via `grove tui` or bare `grove`.
 *
 * Always renders the setup screen first so the user can choose what to do
 * (resume existing grove, create new, or connect to remote Nexus).
 * Services start inside the TUI with progress feedback — no raw stderr
 * output before the TUI renders.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildRepos } from "../cli/utils/build-repos.js";
import { findGroveDir as findNearestGroveDir } from "../cli/utils/grove-dir.js";
import type { RunningServices } from "../shared/service-lifecycle.js";
import type { SessionRecord, TuiDataProvider } from "./provider.js";
import {
  backendLabel,
  checkNexusHealth,
  loadContract,
  loadTopology,
  type ResolvedBackend,
  resolveBackend,
} from "./resolve-backend.js";

/** Default polling interval: 30s safety net. Primary updates are via Nexus SSE (instant). */
const DEFAULT_INTERVAL_MS = 30_000;

/** Parse TUI command-line arguments. */
export function parseTuiArgs(args: readonly string[]): {
  readonly intervalMs: number;
  readonly url: string | undefined;
  readonly nexus: string | undefined;
  readonly groveOverride: string | undefined;
  readonly repos: readonly string[];
} {
  const { values } = parseArgs({
    args: [...args],
    options: {
      interval: { type: "string", short: "i" },
      url: { type: "string", short: "u" },
      nexus: { type: "string", short: "n" },
      grove: { type: "string", short: "g" },
      repo: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    console.log(`grove tui — agent command center for swarm visibility

Usage:
  grove tui [options]

Options:
  -i, --interval <seconds>  Polling interval in seconds (default: 30, fallback only — live updates via SSE)
  -u, --url <url>           Remote grove-server URL
  -n, --nexus <url>         Override Nexus URL (bypasses auto-detection)
  -g, --grove <path>        Path to .grove directory (not the repo root)
      --repo <url-or-path>  Target repo (URL or local path). Repeatable, but today only one honored.
  -h, --help                Show this help message

Backend auto-detection:
  Nexus is auto-selected when configured via GROVE_NEXUS_URL env var
  or nexusUrl in .grove/grove.json. Use --nexus to override explicitly.

Environment:
  GROVE_NEXUS_URL            Nexus zone URL (auto-detected as backend)

Keybindings:
  1-4       Focus protocol core panel (DAG, Detail, Frontier, Claims)
  5-8       Toggle operator panels on/off
  Tab       Cycle focus between visible panels
  j/k \u2191/\u2193   Navigate within focused panel
  Enter     Drill-down / select
  Esc       Back / close overlay
  r         Refresh
  Ctrl+P    Command palette
  q         Quit`);
    process.exit(0);
  }

  const intervalSeconds = values.interval ? Number(values.interval) : undefined;
  const intervalMs =
    intervalSeconds !== undefined && !Number.isNaN(intervalSeconds) && intervalSeconds > 0
      ? intervalSeconds * 1000
      : DEFAULT_INTERVAL_MS;

  return {
    intervalMs,
    url: values.url as string | undefined,
    nexus: values.nexus as string | undefined,
    groveOverride: values.grove as string | undefined,
    repos: (values.repo as readonly string[] | undefined) ?? [],
  };
}

/** Create a data provider from a resolved backend (delegates to shared factory). */
async function createProviderForTui(
  backend: ResolvedBackend,
  label: string,
): Promise<TuiDataProvider> {
  const { createProvider } = await import("../shared/provider-factory.js");
  return createProvider(backend, label);
}

// ---------------------------------------------------------------------------
// Grove directory detection
// ---------------------------------------------------------------------------

/**
 * Resolve a fully-initialized grove (.grove/ + grove.json) for the TUI.
 *
 * Fence semantics (#315): walk-up stops at the first ancestor containing a
 * `.grove/` directory. If that .grove/ lacks grove.json, returns undefined —
 * we do NOT silently walk past to find a parent's grove.json. This prevents
 * git worktrees from inheriting the parent repo's grove state when their
 * own .grove/ is incomplete.
 *
 * Exported for regression testing.
 */
export function findGroveDir(groveOverride?: string): string | undefined {
  if (groveOverride) {
    const configPath = join(groveOverride, "grove.json");
    return existsSync(configPath) ? groveOverride : undefined;
  }

  const envDir = process.env.GROVE_DIR;
  if (envDir) {
    const configPath = join(envDir, "grove.json");
    return existsSync(configPath) ? envDir : undefined;
  }

  const nearest = findNearestGroveDir(process.cwd());
  if (nearest === undefined) return undefined;
  if (existsSync(join(nearest, "grove.json"))) return nearest;
  // Found .grove/ but no grove.json — caller will route to setup screen.
  // Do NOT walk past: that would silently use a parent's grove state.
  return undefined;
}

// ---------------------------------------------------------------------------
// Welcome mode helpers
// ---------------------------------------------------------------------------

/** Build extended details string from a preset config for the welcome overlay. */
function buildPresetDetails(preset: {
  readonly mode: string;
  readonly backend: string;
  readonly topology?: { readonly roles: readonly { readonly name: string }[] } | undefined;
  readonly metrics?: readonly { readonly name: string; readonly direction: string }[] | undefined;
  readonly gates?: readonly { readonly type: string }[] | undefined;
  readonly stopConditions?: object | undefined;
  readonly services: { readonly server: boolean; readonly mcp: boolean };
}): string {
  const lines: string[] = [];
  lines.push(`Mode: ${preset.mode}`);
  lines.push(`Backend: ${preset.backend}`);
  if (preset.topology) {
    const roleNames = preset.topology.roles.map((r) => r.name).join(", ");
    lines.push(`Roles: ${roleNames}`);
  }
  if (preset.metrics && preset.metrics.length > 0) {
    const metricStrs = preset.metrics.map((m) => `${m.name} (${m.direction})`);
    lines.push(`Metrics: ${metricStrs.join(", ")}`);
  } else {
    lines.push("Metrics: none (exploration mode)");
  }
  if (preset.gates && preset.gates.length > 0) {
    lines.push(`Gates: ${preset.gates.map((g) => g.type).join(", ")}`);
  }
  if (preset.stopConditions) {
    const stops = Object.entries(preset.stopConditions as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${String(v)}`);
    if (stops.length > 0) lines.push(`Stop: ${stops.join(", ")}`);
  }
  const services: string[] = [];
  if (preset.services.server) services.push("HTTP server");
  if (preset.services.mcp) services.push("MCP server");
  if (services.length > 0) lines.push(`Services: ${services.join(", ")}`);
  return lines.join("\n");
}

/** Load all preset names and descriptions for the welcome screen. */
async function loadPresetList(): Promise<
  readonly { name: string; description: string; details?: string | undefined }[]
> {
  const { getPresetRegistry } = await import("../cli/presets/index.js");
  const registry = getPresetRegistry();
  return Object.entries(registry).map(([name, preset]) => ({
    name,
    description: preset.description,
    details: buildPresetDetails(preset),
  }));
}

/**
 * Build boardroom AppProps from a resolved backend.
 *
 * Shared between the direct boardroom path and the post-init transition.
 */
async function buildAppProps(
  effectiveGrove: string | undefined,
  opts: { intervalMs: number; url?: string | undefined; nexus?: string | undefined },
  presetName?: string,
): Promise<{
  appProps: import("./app.js").AppProps;
  provider: TuiDataProvider;
  stopGc?: (() => void) | undefined;
}> {
  let backend = await resolveBackend({
    url: opts.url,
    nexus: opts.nexus,
    groveOverride: effectiveGrove,
  });

  // Server and MCP write to Nexus (single source of truth).
  // TUI reads from the co-located grove server (port 4515) via RemoteProvider.
  // This avoids hitting Nexus rate limits (the server already reads from Nexus).
  // NOTE: RemoteProvider (localhost:4515) override disabled — it doesn't support
  // session-scoped contribution paths. NexusDataProvider reads Nexus VFS directly
  // with session scoping to avoid N+1 reads on old contributions.

  // Health check for explicit --nexus flag (direct Nexus connection)
  if (backend.mode === "nexus") {
    const health = await checkNexusHealth(backend.url);
    if (health !== "ok") {
      if (backend.source === "flag") {
        if (health === "auth_required") {
          throw new Error(
            `Nexus at ${backend.url} requires authentication (HTTP 401/403). No credential path is configured.`,
          );
        }
        throw new Error(`Nexus at ${backend.url} is unreachable (${health})`);
      }
      backend = { mode: "local", groveOverride: effectiveGrove, source: "default" };
    }
  }

  const label = backendLabel(backend);

  // For remote backends, read the local API key so topology/contract probes authenticate.
  let remoteAuthHeaders: Record<string, string> | undefined;
  if (backend.mode === "remote") {
    const { resolveGroveDir } = await import("../cli/utils/grove-dir.js");
    const { readClientKey } = await import("../core/project-key.js");
    try {
      const { groveDir } = resolveGroveDir(effectiveGrove);
      const apiKey = readClientKey(groveDir);
      if (apiKey) remoteAuthHeaders = { Authorization: `Bearer ${apiKey}` };
    } catch {
      /* no key available */
    }
  }

  const [provider, topology, contract] = await Promise.all([
    createProviderForTui(backend, label),
    loadTopology(backend, remoteAuthHeaders),
    loadContract(backend, remoteAuthHeaders),
  ]);

  // Pre-fetch dashboard data before the renderer starts so the first render
  // has content even when usePolledData hooks can't fire (e.g. Zig render loop).
  let initialDashboard: import("./provider.js").DashboardData | undefined;
  try {
    initialDashboard = await provider.getDashboard();
  } catch {
    // Non-fatal — TUI renders with empty dashboard and polls on next cycle.
  }

  // Create TmuxManager for agent management
  let tmux: import("./agents/tmux-manager.js").TmuxManager | undefined;
  {
    const { ShellTmuxManager } = await import("./agents/tmux-manager.js");
    const mgr = new ShellTmuxManager();
    const available = await mgr.isAvailable();
    tmux = available ? mgr : undefined;
  }

  // Resolve groveDir once — used for AcpxRuntime logDir, workspace GC, and event bus.
  const groveDir = effectiveGrove ?? findGroveDir(effectiveGrove);

  // Preload user config (theme + keymap) before React mounts so configureTheme()
  // patches the theme object in-place before the first render (Issue 14A).
  const { loadGroveConfig } = await import("./config-loader.js");
  const { configureTheme } = await import("./theme.js");
  const userConfig = await loadGroveConfig(groveDir);
  configureTheme(userConfig.theme);

  // Create agent runtime via selectRuntime (honors GROVE_RUNTIME env)
  let agentRuntime: import("../core/agent-runtime.js").AgentRuntime | undefined;
  {
    const { selectRuntime } = await import("../core/select-runtime.js");
    const { ALLOW_ALL_RESOLVER, ChainResolver, DENY_ALL_RESOLVER } = await import(
      "../core/permission-resolver.js"
    );
    const { RulesResolver } = await import("../core/permission-rules.js");
    const effectiveGrovePath = groveDir;
    // Note: no `agent` override — runtime.spawn() derives the agent
    // (claude/codex/gemini) from each role's AgentConfig.command, which comes
    // from the launch-preview role→CLI mapping. Setting it here would force
    // every role to the same agent regardless of the user's selection.
    //
    // Permission resolver selection (safe-by-default):
    // - default → RulesResolver allowing read/search/fetch/think/other only,
    //   falling back to DENY_ALL. Destructive tools are not auto-approved.
    // - GROVE_ALLOW_ALL_PERMISSIONS=1 → ALLOW_ALL_RESOLVER (legacy
    //   `acpx --approve-all` parity; required for agents to edit/execute
    //   until interactive approval lands via issue #193).
    const allowAll = process.env.GROVE_ALLOW_ALL_PERMISSIONS === "1";
    const permissionResolver = allowAll
      ? ALLOW_ALL_RESOLVER
      : new ChainResolver([
          // Allow only kinds that cannot cross a trust boundary by default.
          // Excluded on purpose:
          //  - `other`: ACP's catch-all; would bypass DENY_ALL for unknown tools.
          //  - `fetch`: network egress; combined with `read` an agent could
          //    exfiltrate workspace data without operator approval.
          new RulesResolver({
            allowKinds: ["read", "search", "think"],
            denyTitleSubstrings: ["rm -rf", "sudo", "shutdown"],
          }),
          DENY_ALL_RESOLVER,
        ]);
    if (allowAll) {
      process.stderr.write(
        "[grove] permission-resolver: ALLOW_ALL (GROVE_ALLOW_ALL_PERMISSIONS=1). " +
          "Destructive tool calls are auto-approved — match acpx --approve-all.\n",
      );
    } else {
      process.stderr.write(
        "[grove] permission-resolver: RulesResolver (read/search/think only). " +
          "Edit/execute/fetch tool calls will be denied until issue #193 lands — " +
          "set GROVE_ALLOW_ALL_PERMISSIONS=1 for legacy acpx parity.\n",
      );
    }
    const acpOpts: import("../core/acp-runtime.js").AcpRuntimeOptions = effectiveGrovePath
      ? { permissionResolver, logDir: join(effectiveGrovePath, "agent-logs") }
      : { permissionResolver };
    const runtime = selectRuntime({
      acpx: effectiveGrovePath ? { logDir: join(effectiveGrovePath, "agent-logs") } : {},
      acp: acpOpts,
    });
    const available = await runtime.isAvailable();
    agentRuntime = available ? runtime : undefined;
  }

  // Start workspace GC for modes that have lifecycle support
  const stopCallbacks: Array<() => void> = [];
  if (provider.cleanWorkspace) {
    const { startWorkspaceGc } = await import("./workspace-gc.js");
    stopCallbacks.push(startWorkspaceGc(provider));
  }

  // Use groveDir for workspace management (agent spawning, file sync).
  // Always resolved — even in "remote" mode, agents need workspace paths.
  if (groveDir) {
    const { createLocalRuntime } = await import("../local/runtime.js");
    const { runCleanup, runArtifactGc, runSessionGc } = await import("../local/cleanup.js");
    const cleanupRuntime = createLocalRuntime({
      groveDir,
      frontierCacheTtlMs: 0,
      workspace: false,
      parseContract: false,
    });

    const claimTimer = setInterval(async () => {
      try {
        const result = await runCleanup({ claimStore: cleanupRuntime.claimStore });
        if (result.expiredClaims > 0 || result.cleanedClaims > 0) {
          process.stderr.write(
            `[cleanup] expired ${result.expiredClaims} stale claim(s), cleaned ${result.cleanedClaims} old claim(s)\n`,
          );
        }
      } catch {
        // Cleanup errors are non-fatal
      }
    }, 60_000);

    const gcTimer = setInterval(async () => {
      try {
        const result = await runArtifactGc({
          contributionStore: cleanupRuntime.contributionStore,
          cas: cleanupRuntime.cas,
        });
        if (result.deletedBlobs > 0) {
          process.stderr.write(
            `[cleanup] garbage-collected ${result.deletedBlobs} unreferenced blob(s)\n`,
          );
        }
      } catch {
        // GC errors are non-fatal
      }
    }, 10 * 60_000);

    // Archive stale sessions (not active/pending, older than 24h) every 5 minutes.
    // Run once eagerly on startup so the session picker is clean immediately.
    const runSessionGcOnce = () => {
      try {
        const result = runSessionGc({ goalSessionStore: cleanupRuntime.goalSessionStore });
        if (result.archivedSessions > 0) {
          process.stderr.write(`[cleanup] archived ${result.archivedSessions} stale session(s)\n`);
        }
      } catch {
        // GC errors are non-fatal
      }
    };
    runSessionGcOnce();
    const sessionGcTimer = setInterval(runSessionGcOnce, 5 * 60_000);

    stopCallbacks.push(() => {
      clearInterval(claimTimer);
      clearInterval(gcTimer);
      clearInterval(sessionGcTimer);
      cleanupRuntime.close();
    });
  }

  const stopGc =
    stopCallbacks.length > 0
      ? () => {
          for (const fn of stopCallbacks) fn();
        }
      : undefined;

  // Create EventBus when Nexus is available. NexusWsBridge (in screen-manager.tsx)
  // connects SSE and publishes events into this bus, which triggers re-fetches
  // in RunningView via useEventDrivenData. Without bridge connection, the
  // usePolledData fallback (30s interval) handles updates.
  let eventBus: import("../core/event-bus.js").EventBus | undefined;
  {
    const nexusUrl = process.env.GROVE_NEXUS_URL;
    const apiKey = process.env.NEXUS_API_KEY;
    if (nexusUrl && apiKey) {
      const { LocalEventBus } = await import("../core/local-event-bus.js");
      eventBus = new LocalEventBus();
      stopCallbacks.push(() => eventBus?.close());
    }
  }

  return {
    appProps: {
      provider,
      intervalMs: opts.intervalMs,
      tmux,
      topology,
      presetName,
      groveDir,
      eventBus,
      agentRuntime,
      contract,
      userConfig,
      initialDashboard,
    },
    provider,
    stopGc,
  };
}

// ---------------------------------------------------------------------------
// Post-startup skill update
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget reinstall of SKILL.md after services start.
 *
 * The on-disk catalog refactor (b3580a2) removed per-install URL
 * substitution — SKILL.md is now copied verbatim from the bundled
 * catalog. This helper retains the post-startup reinstall so the
 * user's skill directories get refreshed on every `grove tui` boot,
 * picking up catalog updates shipped with new grove releases.
 */
function updateSkillAfterStartup(): void {
  void import("../cli/commands/skill.js")
    .then(({ handleSkillInstall }) => handleSkillInstall({}))
    .catch(() => {
      /* skill update is best-effort */
    });
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

/**
 * Main TUI entry point.
 *
 * Always shows the setup screen first so the user can choose what to do,
 * then starts services inside the TUI with progress feedback.
 *
 * @param args - CLI arguments for the TUI
 * @param groveOverride - Explicit .grove path override
 * @param serviceOpts - Service start options forwarded from `grove up` (build, nexusSource)
 */
export async function handleTui(
  args: readonly string[],
  groveOverride?: string,
  serviceOpts?: { build?: boolean | undefined; nexusSource?: string | undefined },
): Promise<void> {
  const opts = parseTuiArgs(args);
  const effectiveGrove = opts.groveOverride ?? groveOverride;

  // Check if grove is initialized
  const groveDir = findGroveDir(effectiveGrove);
  const groveExists = groveDir !== undefined;

  // Load grove info if it exists (name + preset for the setup screen)
  let groveInfo: { name: string; preset: string } | undefined;
  if (groveDir) {
    try {
      const raw = readFileSync(join(groveDir, "grove.json"), "utf-8");
      const parsed = JSON.parse(raw);
      groveInfo = { name: parsed.name ?? "unnamed", preset: parsed.preset ?? "unknown" };
    } catch {
      // grove.json unreadable — treat as no grove info
    }
  }

  // Nexus lifecycle is handled by startServices() during grove setup.
  // No pre-flight discovery — each project/worktree has its own Nexus
  // instance initialized during "New session" setup flow.

  // Load past sessions for the welcome screen (informational context).
  // Active sessions are fetched explicitly (no LIMIT) so that a resume target
  // is never missed when > 20 non-archived sessions exist. Archived sessions
  // are loaded too so the fast-path `[a]` archive toggle has something to
  // reveal; the welcome component filters them client-side (hidden by
  // default). The default listSessions() is capped at 20 for display.
  let sessions: SessionRecord[] = [];
  if (groveDir) {
    try {
      const { createSqliteStores } = await import("../local/sqlite-store.js");
      const dbPath = join(groveDir, "grove.db");
      if (existsSync(dbPath)) {
        const stores = createSqliteStores(dbPath);
        const [activeSessions, recentSessions, archivedSessions] = await Promise.all([
          stores.goalSessionStore.listSessions({ status: "active" }),
          stores.goalSessionStore.listSessions(),
          stores.goalSessionStore.listSessions({ includeArchived: true }),
        ]);
        // Active first (keeps resume detection correct beyond the top-20
        // recent window), then the recent unarchived list, then archived
        // sessions that weren't already covered — deduped.
        const seenIds = new Set(activeSessions.map((s) => s.id));
        const recentNew = recentSessions.filter((s) => !seenIds.has(s.id));
        for (const s of recentNew) seenIds.add(s.id);
        const archivedOnly = archivedSessions.filter(
          (s) => s.status === "archived" && !seenIds.has(s.id),
        );
        sessions = [...activeSessions, ...recentNew, ...archivedOnly];
        stores.close();
      }
    } catch {
      // Sessions are optional context — don't block startup
    }
  }

  // Bun compatibility: ensure stdin is in raw mode for keyboard input
  process.stdin.resume();

  // Tmux compatibility: OpenTUI sends Ptmux passthrough sequences for
  // terminal capability negotiation. With `allow-passthrough off` (tmux
  // default) those queries hang the TUI on startup.
  const { ensureTmuxPassthrough } = await import("../cli/utils/tmux-compat.js");
  const tmuxResult = ensureTmuxPassthrough();
  if (!tmuxResult.applied && tmuxResult.reason === "tmux-failed") {
    process.stderr.write(
      `grove: tmux is set in the environment but 'tmux set-option allow-passthrough on' failed. ` +
        `The TUI may hang on startup. Add 'set -g allow-passthrough on' to ~/.tmux.conf as a workaround.\n` +
        (tmuxResult.stderr ? `tmux stderr: ${tmuxResult.stderr}\n` : ""),
    );
  }

  // Dynamic import of React/OpenTUI — only loaded when TUI is actually used
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const React = await import("react");
  const { Toaster } = await import("@opentui-ui/toast/react");
  const { DialogProvider } = await import("@opentui-ui/dialog/react");

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: !process.env.GROVE_NO_ALT_SCREEN,
    // In tmux, force stdout-based I/O (useThread=false) so capture-pane can see
    // the rendered output. By default on macOS, useThread=true routes writes
    // through a Zig FFI background thread, bypassing Node stdout and tmux's
    // cell-grid tracking. Linux already forces useThread=false.
    useThread: process.env.TMUX ? false : undefined,
  });

  const root = createRoot(renderer);

  // Track services + cleanup references
  let runningServices: RunningServices | undefined;
  let activeProvider: TuiDataProvider | undefined;
  let activeStopGc: (() => void) | undefined;

  /** Shutdown handler — stops services, GC, kills agent processes. */
  const cleanup = async () => {
    activeStopGc?.();
    activeProvider?.close();
    // Kill orphan MCP server processes spawned by agent CLIs (codex/claude).
    // These are children of agent processes, not of the TUI, so they survive
    // even after agentRuntime.close() kills the agent. Without this, each
    // TUI session leaks MCP server processes that accumulate memory.
    try {
      const { execSync } = await import("node:child_process");
      execSync("pkill -f 'bun.*mcp/serve' 2>/dev/null || true", { stdio: "pipe", timeout: 5000 });
    } catch {
      // best-effort
    }
    if (runningServices) {
      const { stopServices } = await import("../shared/service-lifecycle.js");
      await stopServices(runningServices);
    }
  };

  // Register signal handlers for graceful shutdown
  const onSignal = () => {
    cleanup().then(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // Reap orphan MCP processes from previous crashed TUI sessions on startup.
  // Each agent CLI (codex/claude) spawns an MCP server child process that
  // survives the parent when the TUI crashes without cleanup.
  try {
    const { execSync } = await import("node:child_process");
    const orphanCount = execSync("pgrep -f 'bun.*mcp/serve' 2>/dev/null | wc -l", {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    if (Number(orphanCount) > 0) {
      execSync("pkill -f 'bun.*mcp/serve' 2>/dev/null || true", { stdio: "pipe", timeout: 5000 });
      process.stderr.write(`[startup] reaped ${orphanCount} orphan MCP server process(es)\n`);
    }
  } catch {
    // best-effort
  }

  try {
    // --url flag: legacy direct boardroom mode (no interactive screens)
    if (opts.url && !opts.nexus) {
      if (groveDir) {
        const { startServices, persistNexusUrlToConfig } = await import(
          "../shared/service-lifecycle.js"
        );
        runningServices = await startServices({
          groveDir,
          build: serviceOpts?.build,
          nexusSource: serviceOpts?.nexusSource,
        });
        if (runningServices.resolvedNexusUrl) {
          persistNexusUrlToConfig(groveDir, runningServices.resolvedNexusUrl);
        }
      }
      const result = await buildAppProps(effectiveGrove, opts, groveInfo?.preset);
      activeProvider = result.provider;
      activeStopGc = result.stopGc;
      updateSkillAfterStartup();
      const { App } = await import("./app.js");
      const { SpawnManagerContext } = await import("./spawn-manager-context.js");
      const { SpawnManager } = await import("./spawn-manager.js");
      const { FileSessionStore } = await import("./session-store.js");
      // Legacy --url path: create SpawnManager and wrap App in context
      // (same pattern as tui-app.tsx for the interactive path).
      let sessionStore: import("./session-store.js").SessionStore | undefined;
      if (result.appProps.groveDir) {
        try {
          sessionStore = new FileSessionStore(result.appProps.groveDir);
        } catch {
          // best-effort
        }
      }
      const { AcpSessionStore } = await import("./data/acp-session-store.js");
      const { createAcpMessageSink } = await import("./data/acp-message-sink.js");
      const acpSessionStore = new AcpSessionStore();
      const acpSink = createAcpMessageSink(acpSessionStore);
      // Track subscriptions so we can unsubscribe before teardown — an
      // orphaned handler would retain a stale sink closure and process
      // events against a disposed store.
      const acpBusUnsubscribes: Array<() => void> = [];
      if (result.appProps.eventBus && result.appProps.topology) {
        const bus = result.appProps.eventBus;
        for (const role of result.appProps.topology.roles) {
          const handler = (ev: import("../core/event-bus.js").GroveEvent): void => {
            acpSink.handleGroveEvent(ev);
          };
          bus.subscribe(role.name, handler);
          acpBusUnsubscribes.push(() => bus.unsubscribe(role.name, handler));
        }
      }
      const spawnManager = new SpawnManager(
        result.appProps.provider,
        result.appProps.tmux,
        (msg) => process.stderr.write(`[spawn] ${msg}\n`),
        buildRepos({
          rawRepo: opts.repos,
          cwd: result.appProps.groveDir ? join(result.appProps.groveDir, "..") : process.cwd(),
        }),
        sessionStore,
        result.appProps.groveDir,
        result.appProps.agentRuntime,
        acpSessionStore,
      );
      // Declare topology up-front so the delivery-ready gate sees the
      // actual role count. --url mode does NOT wire the NexusWsBridge
      // (bridge setup lives in tui-app.tsx's interactive flow), so for
      // multi-role topologies fail closed explicitly — otherwise spawn
      // would stall the full 120s budget waiting for a bridge that
      // will never arrive. Single-role --url sessions have no cross-
      // role traffic, so leave them in "ready" state and let them spawn.
      if (result.appProps.topology) {
        spawnManager.setTopology(result.appProps.topology);
        if (result.appProps.topology.roles.length > 1) {
          spawnManager.markDeliveryDisabled(
            "--url mode does not initialize NexusWsBridge — use the interactive flow for multi-role topologies",
          );
        }
      }
      root.render(
        React.createElement(
          DialogProvider,
          null,
          React.createElement(
            SpawnManagerContext,
            { value: spawnManager },
            React.createElement(App, result.appProps),
          ),
          React.createElement(Toaster, { position: "bottom-right" }),
        ),
      );
      renderer.start();
      await renderer.idle();
      for (const unsubscribe of acpBusUnsubscribes) {
        unsubscribe();
      }
      // destroyAsync awaits bridge.shutdown() so pending dead-letters
      // get a bounded final drain before the sync teardown path. This
      // is the process-exit preservation path; React cleanups use the
      // sync destroy() which accepts a best-effort detached drain.
      await spawnManager.destroyAsync();
      return;
    }

    // --nexus flag: Nexus is the default backend. Go through interactive
    // ScreenManager flow (goal → prompts → run) with Nexus pre-configured.
    // Falls through to the TuiApp below which handles the full flow.

    const presets = await loadPresetList();

    // onInit: handles "New session" in an existing grove, or full init for a new grove.
    // When GROVE_DIR/groveExists — skip executeInit entirely (don't touch Nexus or GROVE.md).
    // Only run executeInit when truly creating a new grove from scratch.
    const onInit = async (
      presetName: string,
      groveName: string,
      onProgress?: (step: string) => void,
    ): Promise<import("./app.js").AppProps> => {
      const newGroveDir = groveDir ?? join(process.cwd(), ".grove");

      if (!groveExists) {
        // Truly new grove — run full init (creates .grove/, nexus.yaml, GROVE.md)
        const { executeInit } = await import("../cli/commands/init.js");
        await executeInit(
          {
            name: groveName,
            mode: "evaluation",
            seed: [],
            metric: [],
            force: true,
            agentOverrides: {},
            cwd: join(newGroveDir, ".."),
            preset: presetName,
          },
          undefined,
          // TUI owns stdin/stdout; force non-interactive identity flow so
          // the project-id `Unify? [y/N]` prompt cannot fire from inside
          // OpenTUI. The non-TTY default ("new") matches docs.
          { isTTY: false },
        );
      }
      if (groveExists) {
        // Grove exists — start services to ensure Nexus is running (handles resume/reuse/cold-start).
        // Even for "New session", Nexus may be stopped (e.g. machine restart).
        // startServices + ensureNexusRunning is idempotent: reuses running Nexus if already up.
        onProgress?.("[grove up] ensuring services are running...");
        const { startServices, persistNexusUrlToConfig } = await import(
          "../shared/service-lifecycle.js"
        );
        runningServices = await startServices({
          groveDir: newGroveDir,
          build: serviceOpts?.build,
          nexusSource: serviceOpts?.nexusSource,
          onProgress,
          force: false,
        });
        if (runningServices.resolvedNexusUrl) {
          persistNexusUrlToConfig(newGroveDir, runningServices.resolvedNexusUrl);
        }
      } else {
        // New grove — start services (Nexus, HTTP server, MCP server).
        const { startServices, persistNexusUrlToConfig } = await import(
          "../shared/service-lifecycle.js"
        );
        runningServices = await startServices({
          groveDir: newGroveDir,
          build: serviceOpts?.build,
          nexusSource: serviceOpts?.nexusSource,
          onProgress,
          force: false,
        });
        if (runningServices.resolvedNexusUrl) {
          persistNexusUrlToConfig(newGroveDir, runningServices.resolvedNexusUrl);
        }
      }

      // Pass the grove dir so buildAppProps can find GROVE.md
      const result = await buildAppProps(newGroveDir, opts, presetName);
      activeProvider = result.provider;
      activeStopGc = result.stopGc;

      // Post-startup: update agent skill SKILL.md (non-blocking)
      updateSkillAfterStartup();

      return result.appProps;
    };

    // onStart: handles "Resume" path — start services for existing grove
    const onStart = async (
      onProgress?: (step: string) => void,
      sessionId?: string,
    ): Promise<import("./app.js").AppProps> => {
      const resolvedGrove = groveDir ?? join(process.cwd(), ".grove");
      const { startServices, persistNexusUrlToConfig } = await import(
        "../shared/service-lifecycle.js"
      );
      runningServices = await startServices({
        groveDir: resolvedGrove,
        build: serviceOpts?.build,
        nexusSource: serviceOpts?.nexusSource,
        onProgress,
      });
      if (runningServices.resolvedNexusUrl) {
        persistNexusUrlToConfig(resolvedGrove, runningServices.resolvedNexusUrl);
      }

      const result = await buildAppProps(effectiveGrove, opts, groveInfo?.preset);
      activeProvider = result.provider;
      activeStopGc = result.stopGc;

      // Post-startup: update agent skill SKILL.md (non-blocking)
      updateSkillAfterStartup();

      return { ...result.appProps, resumeSessionId: sessionId };
    };

    // onNewSession: handles `n` on fast-path — reuse existing grove, start a new
    // session with the user-picked preset. Delegates to `onInit` which already
    // handles the `groveExists=true` branch (just startServices + buildAppProps).
    const onNewSession = async (presetName: string): Promise<import("./app.js").AppProps> => {
      if (!groveInfo?.name) {
        throw new Error("onNewSession called without existing grove");
      }
      const baseProps = await onInit(presetName, groveInfo.name);
      return { ...baseProps, newSessionPreset: presetName };
    };

    // onConnect: handles "Connect to remote Nexus" path — no local services
    const onConnect = async (nexusUrl: string): Promise<import("./app.js").AppProps> => {
      const result = await buildAppProps(effectiveGrove, { ...opts, nexus: nexusUrl });
      activeProvider = result.provider;
      activeStopGc = result.stopGc;
      return result.appProps;
    };

    const { TuiApp } = await import("./tui-app.js");

    root.render(
      React.createElement(
        DialogProvider,
        null,
        React.createElement(TuiApp, {
          groveExists,
          groveInfo,
          presets,
          sessions,
          onInit,
          onStart,
          onConnect,
          onNewSession,
          autoConnectNexus: opts.nexus,
        }),
        React.createElement(Toaster, { position: "bottom-right" }),
      ),
    );

    renderer.start();
    await renderer.idle();
  } finally {
    // TUI exited — clean up everything
    await cleanup();
  }
}

/**
 * Direct TUI entry point for the CLI dispatcher.
 *
 * Called when `grove` is run with no subcommand. Delegates to handleTui
 * which internally handles both initialized and uninitialized states.
 */
export async function handleTuiDirect(groveOverride?: string): Promise<void> {
  await handleTui([], groveOverride);
}

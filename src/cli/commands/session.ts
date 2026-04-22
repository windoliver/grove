/**
 * `grove session` command — headless session lifecycle management.
 *
 * Exercises the full Phase 5/6 flow:
 *   grove session start --goal "Build auth module" [--preset review-loop]
 *   grove session list
 *   grove session status
 *   grove session stop [--reason "Done"]
 *
 * For TUI-based sessions, use `grove up` which will integrate with
 * SessionOrchestrator in its React UI.
 */

import { parseArgs } from "node:util";

import type { GroveContract } from "../../core/contract.js";
import { parseGroveContract } from "../../core/contract.js";
import { LocalEventBus } from "../../core/local-event-bus.js";
import { MockRuntime } from "../../core/mock-runtime.js";
import { lookupPresetTopology } from "../../core/presets.js";
import { SessionOrchestrator } from "../../core/session-orchestrator.js";
import type { AgentTopology } from "../../core/topology.js";
import { resolveTopology } from "../../core/topology-resolver.js";
import { SqliteGoalSessionStore } from "../../local/sqlite-goal-session-store.js";
import { outputJson, outputJsonError } from "../format.js";
import { buildRepos } from "../utils/build-repos.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Subcommand dispatch
// ---------------------------------------------------------------------------

export async function executeSession(args: readonly string[]): Promise<void> {
  const subcommand = args[0];
  const rest = args.slice(1);

  switch (subcommand) {
    case "start":
      return sessionStart(rest);
    case "list":
      return sessionList(rest);
    case "status":
      return sessionStatus();
    case "stop":
      return sessionStop(rest);
    default:
      console.log(`grove session <subcommand>

Subcommands:
  start --goal <goal> [--preset <name>] [--roles a,b,c]   Start a new session
  list                                                     List all sessions
  status                                                   Show current session status
  stop [--reason <r>]                                      Stop the current session

Topology precedence: --roles > --preset > GROVE.md default`);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function sessionStart(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      goal: { type: "string" },
      preset: { type: "string" },
      roles: { type: "string" },
      runtime: { type: "string", default: "mock" },
      repo: { type: "string", multiple: true },
    },
    strict: false,
  });

  const goal = values.goal as string | undefined;
  if (!goal) {
    outputJsonError({ code: "VALIDATION_ERROR", message: "--goal is required" });
    process.exitCode = 1;
    return;
  }

  // Find .grove and load contract
  const { findGroveDir } = await import("../context.js");
  const groveDir = findGroveDir(process.cwd());
  if (!groveDir) {
    outputJsonError({ code: "NOT_FOUND", message: "Not inside a grove. Run 'grove init' first." });
    process.exitCode = 1;
    return;
  }

  const { readFileSync, existsSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");

  const groveRoot = resolve(groveDir, "..");
  const contractPath = join(groveRoot, "GROVE.md");

  const rawRepo = (values.repo as readonly string[] | undefined) ?? [];
  let repos: readonly import("../../core/repo-ref.js").RepoRef[];
  try {
    repos = buildRepos({ rawRepo, cwd: groveRoot });
  } catch (err) {
    outputJsonError({
      code: "VALIDATION_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
    return;
  }

  let contract: GroveContract | undefined;
  if (existsSync(contractPath)) {
    contract = parseGroveContract(readFileSync(contractPath, "utf-8"));
  }

  // Build inline topology from --roles if provided
  const rolesArg = values.roles as string | undefined;
  let inlineTopology: AgentTopology | undefined;
  if (rolesArg) {
    const roleNames = rolesArg
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    if (roleNames.length === 0) {
      outputJsonError({
        code: "VALIDATION_ERROR",
        message: "--roles must be a comma-separated list of role names",
      });
      process.exitCode = 1;
      return;
    }
    inlineTopology = {
      structure: "flat",
      roles: roleNames.map((name) => ({
        name,
        description: `Agent role: ${name}`,
        platform: "claude-code" as const,
      })),
    };
  }

  // Resolve topology: inline (--roles) > preset (--preset) > GROVE.md default
  const presetName = values.preset as string | undefined;
  const resolution = resolveTopology(
    {
      inlineTopology,
      presetName,
      contractDefault: contract?.topology,
    },
    lookupPresetTopology,
  );

  if (!resolution.ok) {
    outputJsonError({ code: "VALIDATION_ERROR", message: resolution.error });
    process.exitCode = 1;
    return;
  }

  // Create runtime — prefer acpx, fall back to mock
  const { AcpxRuntime } = await import("../../core/acpx-runtime.js");
  const acpx = new AcpxRuntime({ logDir: join(groveDir, "agent-logs") });
  const runtime = (await acpx.isAvailable()) ? acpx : new MockRuntime();
  const eventBus = new LocalEventBus();

  // Open SQLite database and create session
  const { initSqliteDb } = await import("../../local/sqlite-store.js");
  const db = initSqliteDb(join(groveDir, "grove.db"));

  // Everything below must run under try/finally so db.close() always fires.
  // Signal handlers are installed early (before orchestrator.start) so a
  // Ctrl-C during startup still records a stopReason.
  let shuttingDown = false;
  const sigintHandler = () => void handleSignal(130, "User interrupted (SIGINT)");
  const sigtermHandler = () => void handleSignal(143, "Terminated (SIGTERM)");
  let sessionId: string | undefined;
  const goalSessionStore = new SqliteGoalSessionStore(db);

  const markDone = async (reason: string): Promise<void> => {
    if (sessionId === undefined) return;
    try {
      await goalSessionStore.updateSession(sessionId, {
        status: "completed",
        completedAt: new Date().toISOString(),
        stopReason: reason,
      });
    } catch {
      // Best-effort — DB may already be closed or session archived.
    }
  };

  const handleSignal = async (exitCode: number, reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await markDone(reason);
    } finally {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      process.exit(exitCode);
    }
  };

  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  try {
    const session = await goalSessionStore.createSession({
      goal,
      presetName: presetName ?? contract?.name,
      topology: resolution.topology,
      config: contract,
    });
    sessionId = session.id;

    // Mirror the session to Nexus so MCP servers spawned by agents (which set
    // `GROVE_NEXUS_URL`) can resolve the frozen contract. Parallels the TUI
    // path in NexusProvider.createSession — without this, grove-mcp's
    // fail-closed check kills every agent spawned through `grove session
    // start`. Best-effort with retries; a hard failure archives the orphan
    // SQLite record and rethrows so the user sees the problem up front.
    const nexusUrl = process.env.GROVE_NEXUS_URL;
    const nexusApiKey = process.env.NEXUS_API_KEY;
    if (nexusUrl) {
      const { NexusHttpClient } = await import("../../nexus/nexus-http-client.js");
      const { NexusSessionStore } = await import("../../nexus/nexus-session-store.js");
      const nexusClient = new NexusHttpClient({
        url: nexusUrl,
        ...(nexusApiKey ? { apiKey: nexusApiKey } : {}),
      });
      const zoneId = process.env.GROVE_ZONE_ID ?? "default";
      const nexusSessionStore = new NexusSessionStore(nexusClient, zoneId);

      const retryDelaysMs = [0, 200, 500, 1000];
      let lastErr: unknown;
      for (const delay of retryDelaysMs) {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        try {
          await nexusSessionStore.putSession(session);
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) {
        await goalSessionStore.archiveSession(session.id).catch(() => undefined);
        throw new Error(
          `Failed to mirror session ${session.id} to Nexus at ${nexusUrl}: ` +
            `${lastErr instanceof Error ? lastErr.message : String(lastErr)}. ` +
            `The local session has been archived; please retry.`,
        );
      }
    }

    // Create contribution store for polling-based routing (MCP runs in child processes)
    const { SqliteContributionStore } = await import("../../local/sqlite-store.js");
    const contributionStore = new SqliteContributionStore(db);

    const orchestrator = new SessionOrchestrator({
      goal,
      contract: contract ?? { contractVersion: 3, name: presetName ?? "default" },
      topology: resolution.topology,
      runtime,
      eventBus,
      projectRoot: groveRoot,
      repos,
      workspaceBaseDir: join(groveDir, "workspaces"),
      sessionId: session.id,
      contributionStore,
    });

    let status: import("../../core/session-orchestrator.js").SessionStatus;
    try {
      status = await orchestrator.start();
    } catch (err) {
      // Mark session as cancelled on spawn failure. The outer finally still
      // closes db and removes signal listeners.
      await goalSessionStore.archiveSession(session.id);
      throw err;
    }

    // Output initial status
    outputJson({
      sessionId: session.id,
      goal,
      preset: presetName ?? contract?.name,
      agents: status.agents.map((a) => ({
        role: a.role,
        sessionId: a.session.id,
        status: a.session.status,
      })),
      message: `Session started with ${status.agents.length} agents`,
    });

    // Wait for session to complete — agents need time to work, submit, review, and call grove_done.
    // Without this, the CLI exits immediately and the reviewer never gets routed events.
    const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const stopReason = await orchestrator.waitForCompletion(SESSION_TIMEOUT_MS);
    await markDone(stopReason);
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigtermHandler);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

async function sessionList(_args: readonly string[]): Promise<void> {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { resolveGroveDir } = await import("../utils/grove-dir.js");

  let sessions: unknown[] = [];
  try {
    const { groveDir } = resolveGroveDir();
    const dbPath = join(groveDir, "grove.db");
    if (existsSync(dbPath)) {
      const { initSqliteDb } = await import("../../local/sqlite-store.js");
      const db = initSqliteDb(dbPath);
      const store = new SqliteGoalSessionStore(db);
      sessions = [...(await store.listSessions({ includeArchived: true }))];
      db.close();
    }
  } catch {
    // Fall through with empty list
  }

  outputJson({ sessions, count: sessions.length });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function sessionStatus(): Promise<void> {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { resolveGroveDir } = await import("../utils/grove-dir.js");

  try {
    const { groveDir } = resolveGroveDir();
    const dbPath = join(groveDir, "grove.db");
    if (!existsSync(dbPath)) {
      outputJson({ status: "no_sessions", message: "No grove database found" });
      return;
    }
    const { initSqliteDb } = await import("../../local/sqlite-store.js");
    const db = initSqliteDb(dbPath);
    const store = new SqliteGoalSessionStore(db);
    const allSessions = await store.listSessions();
    const latest = allSessions.length > 0 ? allSessions[0] : undefined;
    db.close();

    if (!latest) {
      outputJson({ status: "no_sessions", message: "No sessions found" });
      return;
    }

    outputJson({
      sessionId: latest.id,
      status: latest.status,
      goal: latest.goal,
      startedAt: latest.createdAt,
      completedAt: latest.completedAt,
      contributionCount: latest.contributionCount,
    });
  } catch (err) {
    outputJsonError({
      code: "SESSION_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

async function sessionStop(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      reason: { type: "string", default: "User stopped" },
    },
    strict: false,
  });

  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { resolveGroveDir } = await import("../utils/grove-dir.js");

  try {
    const { groveDir } = resolveGroveDir();
    const dbPath = join(groveDir, "grove.db");
    if (!existsSync(dbPath)) {
      outputJsonError({ code: "NOT_FOUND", message: "No grove database found" });
      process.exitCode = 1;
      return;
    }

    const { initSqliteDb } = await import("../../local/sqlite-store.js");
    const db = initSqliteDb(dbPath);
    const store = new SqliteGoalSessionStore(db);

    // Find the latest active session and archive it
    const sessions = await store.listSessions({ status: "active" });
    const latest = sessions[0];
    if (!latest) {
      outputJson({ message: "No active session to stop" });
      db.close();
      return;
    }
    const reason = (values.reason as string | undefined) ?? "User stopped";
    await store.updateSession(latest.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      stopReason: reason,
    });

    // Best-effort: kill agent processes associated with this session.
    // The orchestrator spawns agents via acpx/subprocess — try to signal them.
    try {
      const { execSync } = await import("node:child_process");
      // Agent processes have GROVE_SESSION_ID in their env
      execSync(`pkill -f "GROVE_SESSION_ID=${latest.id}" 2>/dev/null || true`, {
        stdio: "pipe",
        encoding: "utf-8",
      });
    } catch {
      // pkill not available or no matching processes — acceptable
    }

    db.close();

    outputJson({
      sessionId: latest.id,
      status: "completed",
      reason,
      message: `Session ${latest.id} stopped`,
      warning:
        "Agent processes may still be running if they don't respond to signals. Use 'ps aux | grep grove' to check.",
    });
  } catch (err) {
    outputJsonError({
      code: "SESSION_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

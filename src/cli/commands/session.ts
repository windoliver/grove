/**
 * `grove session` command — headless session lifecycle management.
 *
 * Exercises the full Phase 5/6 flow:
 *   grove session start --goal "Build auth module" [--preset review-loop]
 *   grove session list
 *   grove session status
 *   grove session stop [--reason "Done"]
 *   grove session delete <session-id> [--force]
 *
 * For TUI-based sessions, use `grove up` which will integrate with
 * SessionOrchestrator in its React UI.
 */

import { parseArgs } from "node:util";

import type { GroveContract } from "../../core/contract.js";
import { parseGroveContract } from "../../core/contract.js";
import { LocalEventBus } from "../../core/local-event-bus.js";
import {
  createFallbackRoadmap,
  GroveLoopRunner,
  installProcessInterruptHandlers,
  LoopStopStatus,
  type SessionAssessment,
  type WorkflowStateStore,
} from "../../core/loop-runner.js";
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
    case "delete":
      return sessionDelete(rest);
    default:
      console.log(`grove session <subcommand>

Subcommands:
  start --goal <goal> [--preset <name>] [--roles a,b,c]   Start a new session
  list                                                     List all sessions
  status                                                   Show current session status
  stop [--reason <r>]                                      Stop the current session
  delete <session-id> [--force]                            Delete a session

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

  // Create runtime via selectRuntime (honors GROVE_RUNTIME env), fall back to mock
  const { selectRuntime } = await import("../../core/select-runtime.js");
  const { ALLOW_ALL_RESOLVER, ChainResolver, DENY_ALL_RESOLVER } = await import(
    "../../core/permission-resolver.js"
  );
  const { RulesResolver } = await import("../../core/permission-rules.js");
  const allowAllPermissions = process.env.GROVE_ALLOW_ALL_PERMISSIONS === "1";
  const permissionResolver = allowAllPermissions
    ? ALLOW_ALL_RESOLVER
    : new ChainResolver([
        new RulesResolver({
          allowKinds: ["read", "search", "think"],
          denyTitleSubstrings: ["rm -rf", "sudo", "shutdown"],
        }),
        DENY_ALL_RESOLVER,
      ]);
  if (allowAllPermissions) {
    process.stderr.write(
      "[grove] permission-resolver: ALLOW_ALL (GROVE_ALLOW_ALL_PERMISSIONS=1). " +
        "Destructive tool calls are auto-approved.\n",
    );
  }
  const picked = selectRuntime({
    acpx: { logDir: join(groveDir, "agent-logs") },
    acp: { logDir: join(groveDir, "agent-logs"), permissionResolver },
  });
  const runtime = (await picked.isAvailable()) ? picked : new MockRuntime();
  const eventBus = new LocalEventBus();

  // Open SQLite database and create session
  const { initSqliteDb } = await import("../../local/sqlite-store.js");
  const db = initSqliteDb(join(groveDir, "grove.db"));

  // Everything below must run under try/finally so db.close() always fires.
  // Signal handlers are installed early (before orchestrator.start) so a
  // Ctrl-C during startup still records a stopReason.
  let sessionId: string | undefined;
  let orchestrator: SessionOrchestrator | undefined;
  let workflowStore: WorkflowStateStore | undefined;
  const goalSessionStore = new SqliteGoalSessionStore(db);

  const markDone = async (reason: string, stopStatus: LoopStopStatus): Promise<void> => {
    if (sessionId === undefined) return;
    try {
      await goalSessionStore.updateSession(sessionId, {
        status: terminalSessionStatus(stopStatus),
        completedAt: new Date().toISOString(),
        stopReason: reason,
        stopStatus,
      });
    } catch {
      // Best-effort — DB may already be closed or session archived.
    }
  };

  const interruptHandlers = installProcessInterruptHandlers(process, {
    forceExit: (code) => process.exit(code),
    onInterrupt: (reason) => {
      void orchestrator?.stop(reason, LoopStopStatus.Interrupted);
      void markDone(reason, LoopStopStatus.Interrupted);
    },
  });

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
      const { NexusWorkflowStore } = await import("../../nexus/nexus-workflow-store.js");
      const nexusClient = new NexusHttpClient({
        url: nexusUrl,
        ...(nexusApiKey ? { apiKey: nexusApiKey } : {}),
      });
      const zoneId = process.env.GROVE_ZONE_ID ?? "default";
      const nexusSessionStore = new NexusSessionStore(nexusClient, zoneId);
      workflowStore = new NexusWorkflowStore({ client: nexusClient, zoneId });

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

    orchestrator = new SessionOrchestrator({
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

    // Wait for session completion through the deterministic external loop.
    // The session orchestrator owns agent routing; the loop owns final status,
    // interrupt observation, and durable workflow state.
    const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const assessment = sessionAssessment(goal, resolution.topology);
    const loop = new GroveLoopRunner({
      workflowId: `workflow-${session.id}`,
      sessionId: session.id,
      assessment,
      roadmap: createFallbackRoadmap(assessment),
      maxIterations: 1,
      interrupt: interruptHandlers.interrupt,
      workflowStore,
      executeIteration: async () => {
        const stopReason = await orchestrator?.waitForCompletion(SESSION_TIMEOUT_MS);
        const current = orchestrator?.getStatus();
        return {
          stopStatus:
            current?.stopStatus ??
            (interruptHandlers.interrupt.interruptRequested
              ? LoopStopStatus.Interrupted
              : LoopStopStatus.Achieved),
          summary: stopReason ?? current?.stopReason ?? "Session complete",
        };
      },
    });
    const finalState = await loop.run();
    const finalStopStatus =
      finalState.status === "running" ? LoopStopStatus.Error : finalState.status;
    await markDone(finalState.reason ?? "Session complete", finalStopStatus);
  } finally {
    interruptHandlers.dispose();
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

function terminalSessionStatus(stopStatus: LoopStopStatus): "completed" | "cancelled" {
  return stopStatus === LoopStopStatus.Interrupted || stopStatus === LoopStopStatus.Error
    ? "cancelled"
    : "completed";
}

function sessionAssessment(goal: string, topology: AgentTopology): SessionAssessment {
  return {
    goal,
    roles: topology.roles.map((role) => role.name),
    successCriteria: ["session reaches a deterministic terminal status"],
    constraints: ["stop decisions are made by GroveLoopRunner, not by agent prose"],
  };
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
      stopReason: latest.stopReason,
      stopStatus: latest.stopStatus,
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
      status: terminalSessionStatus(LoopStopStatus.Interrupted),
      completedAt: new Date().toISOString(),
      stopReason: reason,
      stopStatus: LoopStopStatus.Interrupted,
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
      status: terminalSessionStatus(LoopStopStatus.Interrupted),
      reason,
      stopStatus: LoopStopStatus.Interrupted,
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

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

async function sessionDelete(args: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      force: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const sessionId = positionals[0];
  if (!sessionId) {
    outputJsonError({ code: "VALIDATION_ERROR", message: "session id is required" });
    process.exitCode = 1;
    return;
  }

  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { findGroveDir } = await import("../context.js");
  const groveDir = findGroveDir(process.cwd());
  const dbPath = groveDir === undefined ? undefined : join(groveDir, "grove.db");
  if (dbPath === undefined || !existsSync(dbPath)) {
    outputJsonError({ code: "NOT_FOUND", message: "No grove database found" });
    process.exitCode = 1;
    return;
  }

  const { initSqliteDb } = await import("../../local/sqlite-store.js");
  const db = initSqliteDb(dbPath);
  try {
    const store = new SqliteGoalSessionStore(db);
    const session = await store.getSession(sessionId);
    if (session === undefined) {
      outputJsonError({ code: "NOT_FOUND", message: `Session not found: ${sessionId}` });
      process.exitCode = 1;
      return;
    }

    const force = values.force === true;
    const result = await store.deleteSession(sessionId, { force, actor: "cli" });
    outputJson(result);
    if (!result.deleted && !result.forced) {
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

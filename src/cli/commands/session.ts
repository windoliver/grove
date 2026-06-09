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

import { expectCasOk } from "../../core/cas.js";
import type { GroveContract } from "../../core/contract.js";
import { parseGroveContract } from "../../core/contract.js";
import { LoopStopStatus } from "../../core/loop-runner.js";
import { lookupPresetTopology } from "../../core/presets.js";
import { readNamespace } from "../../core/project-key.js";
import type { TopologyResolutionResult } from "../../core/topology-resolver.js";
import { SqliteGoalSessionStore } from "../../local/sqlite-goal-session-store.js";
import { outputJson, outputJsonError } from "../format.js";
import { buildRepos } from "../utils/build-repos.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionNexusZoneEnv {
  readonly GROVE_ZONE_ID?: string | undefined;
}

export function resolveSessionNexusZoneId(
  groveDir: string,
  env: SessionNexusZoneEnv = { GROVE_ZONE_ID: process.env.GROVE_ZONE_ID },
): string {
  return readNamespace(groveDir) ?? env.GROVE_ZONE_ID ?? "default";
}

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
  start --goal <goal> [--preset <name>] [--roles a,b,c] [--skills <clause>]...   Start a new session
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
      skills: { type: "string", multiple: true },
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

  const presetName = values.preset as string | undefined;
  let resolution: TopologyResolutionResult;
  try {
    const { resolveSessionStartTopology } = await import("./session-start-topology.js");
    resolution = resolveSessionStartTopology(
      {
        rolesArg: values.roles as string | undefined,
        presetName,
        contractDefault: contract?.topology,
        skillArgs: (values.skills as readonly string[] | undefined) ?? [],
      },
      lookupPresetTopology,
    );
  } catch (err) {
    outputJsonError({
      code: "VALIDATION_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
    return;
  }

  if (!resolution.ok) {
    outputJsonError({ code: "VALIDATION_ERROR", message: resolution.error });
    process.exitCode = 1;
    return;
  }

  const { launchGoalSession } = await import("../utils/launch-session.js");
  await launchGoalSession({
    groveDir,
    groveRoot,
    goal,
    topology: resolution.topology,
    contract,
    presetName,
    repos,
    onAgentsStarted: ({ sessionId, agents }) => {
      outputJson({
        sessionId,
        goal,
        preset: presetName ?? contract?.name,
        agents: agents.map((a) => ({
          role: a.role,
          sessionId: a.session.id,
          status: a.session.status,
        })),
        message: `Session started with ${agents.length} agents`,
      });
    },
  });
}

function terminalSessionStatus(stopStatus: LoopStopStatus): "completed" | "cancelled" {
  return stopStatus === LoopStopStatus.Interrupted || stopStatus === LoopStopStatus.Error
    ? "cancelled"
    : "completed";
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
      ...(latest.recipeProvenance && { recipeDigest: latest.recipeProvenance.recipeDigest }),
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
    const stopResult = await store.updateSession(latest.id, {
      status: terminalSessionStatus(LoopStopStatus.Interrupted),
      completedAt: new Date().toISOString(),
      stopReason: reason,
      stopStatus: LoopStopStatus.Interrupted,
    });
    expectCasOk(stopResult, `cli grove session stop (${latest.id})`);

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
    const deleteResult = await store.deleteSession(sessionId, { force, actor: "cli" });
    const result = expectCasOk(deleteResult, `cli grove session delete (${sessionId})`);
    outputJson(result);
    if (!result.deleted && !result.forced) {
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

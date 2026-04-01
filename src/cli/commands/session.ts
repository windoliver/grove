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
  const acpx = new AcpxRuntime();
  const runtime = (await acpx.isAvailable()) ? acpx : new MockRuntime();
  const eventBus = new LocalEventBus();

  // Open SQLite database and create session
  const { initSqliteDb } = await import("../../local/sqlite-store.js");
  const db = initSqliteDb(join(groveDir, "grove.db"));
  const goalSessionStore = new SqliteGoalSessionStore(db);

  const session = await goalSessionStore.createSession({
    goal,
    presetName: presetName ?? contract?.name,
    topology: resolution.topology,
  });

  const orchestrator = new SessionOrchestrator({
    goal,
    contract: contract ?? { contractVersion: 3, name: presetName ?? "default" },
    topology: resolution.topology,
    runtime,
    eventBus,
    projectRoot: groveRoot,
    workspaceBaseDir: join(groveDir, "workspaces"),
    sessionId: session.id,
  });

  const status = await orchestrator.start();

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
      sessions = [...(await store.listSessions())];
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

  outputJson({
    message: "Session stop requires persistent orchestrator reference (not yet wired)",
    reason: values.reason,
  });
}

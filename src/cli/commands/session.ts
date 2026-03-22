/**
 * `grove session` command — headless session lifecycle management.
 *
 * Exercises the full Phase 5/6 flow:
 *   grove session start --goal "Build auth module"
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
import { InMemorySessionStore } from "../../core/in-memory-session-store.js";
import { SessionManager } from "../../core/session-manager.js";
import { SessionOrchestrator } from "../../core/session-orchestrator.js";
import { outputJson, outputJsonError } from "../format.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionStartOptions {
  readonly goal: string;
  readonly groveDir: string;
  readonly runtime?: string;
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
    default:
      console.log(`grove session <subcommand>

Subcommands:
  start --goal <goal>   Start a new session
  list                  List all sessions
  status                Show current session status
  stop [--reason <r>]   Stop the current session`);
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

  if (!contract?.topology) {
    outputJsonError({ code: "VALIDATION_ERROR", message: "GROVE.md must define a topology for session management" });
    process.exitCode = 1;
    return;
  }

  // Create runtime (mock for now — real runtimes require agent CLIs)
  const runtime = new MockRuntime();
  const eventBus = new LocalEventBus();

  const store = new InMemorySessionStore();
  const manager = new SessionManager(store);

  const session = await manager.createSession({
    goal,
    presetName: contract.name,
  });

  const orchestrator = new SessionOrchestrator({
    goal,
    contract,
    runtime,
    eventBus,
    projectRoot: groveRoot,
    workspaceBaseDir: join(groveDir, "workspaces"),
    sessionId: session.id,
  });

  await manager.startSession(session.id);
  const status = await orchestrator.start();

  outputJson({
    sessionId: session.id,
    goal,
    preset: contract.name,
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
  // Sessions are in-memory for now — list from the store
  outputJson({
    message: "Session list requires persistent store (not yet wired to SQLite)",
    sessions: [],
  });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function sessionStatus(): Promise<void> {
  outputJson({
    message: "Session status requires persistent store (not yet wired to SQLite)",
  });
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

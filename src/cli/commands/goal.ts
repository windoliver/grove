/**
 * `grove goal` command — view or set the current goal.
 *
 * Usage:
 *   grove goal                          Show current goal
 *   grove goal set "Fix auth bug"       Set a new goal
 *   grove goal set "Fix auth bug" --acceptance "Tests pass" --acceptance "TTL respected"
 */

import { parseArgs } from "node:util";

import { createSqliteStores } from "../../local/sqlite-store.js";
import { resolveAgentId, resolveGroveDir } from "../utils/grove-dir.js";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Handle the `grove goal` CLI command.
 *
 * - No subcommand: display the current goal.
 * - `set`: create or replace the current goal.
 */
export async function handleGoal(args: readonly string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === "get") {
    await showGoal();
    return;
  }

  if (subcommand === "set") {
    await setGoal(args.slice(1));
    return;
  }

  console.error(`grove goal: unknown subcommand '${subcommand}'.`);
  console.error("Usage: grove goal [set <text> [--acceptance <criterion>...]]");
  process.exitCode = 2;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** Display the current goal. */
async function showGoal(): Promise<void> {
  const { dbPath } = resolveGroveDir();
  const stores = createSqliteStores(dbPath);
  try {
    const goal = await stores.goalSessionStore.getGoal();
    if (!goal) {
      console.log("No goal set. Use 'grove goal set <text>' to set one.");
      return;
    }

    console.log(`Goal: ${goal.goal}`);
    console.log(`Status: ${goal.status}`);
    if (goal.acceptance.length > 0) {
      console.log("Acceptance criteria:");
      for (const criterion of goal.acceptance) {
        console.log(`  - ${criterion}`);
      }
    }
    console.log(`Set at: ${goal.setAt}`);
    console.log(`Set by: ${goal.setBy}`);
  } finally {
    stores.close();
  }
}

/** Parse args and set a new goal. */
async function setGoal(args: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: args as string[],
    options: {
      acceptance: { type: "string", multiple: true, default: [] },
    },
    allowPositionals: true,
    strict: true,
  });

  const goalText = positionals[0];
  if (!goalText) {
    console.error("grove goal set: goal text is required.");
    console.error('Usage: grove goal set "Fix auth bug" [--acceptance "Tests pass"]');
    process.exitCode = 2;
    return;
  }

  const acceptance = (values.acceptance as string[]) ?? [];
  const setBy = resolveAgentId();

  const { dbPath } = resolveGroveDir();
  const stores = createSqliteStores(dbPath);
  try {
    const goal = await stores.goalSessionStore.setGoal(goalText, acceptance, setBy);
    console.log(`Goal set: ${goal.goal}`);
    if (goal.acceptance.length > 0) {
      console.log("Acceptance criteria:");
      for (const criterion of goal.acceptance) {
        console.log(`  - ${criterion}`);
      }
    }
  } finally {
    stores.close();
  }
}

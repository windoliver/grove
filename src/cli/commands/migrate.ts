/**
 * `grove migrate` command — upgrade a legacy grove to namespaced identity.
 *
 * Targets installations that predate A2/A3 (no project-id, no credentials).
 * Fresh installs (already have `.grove/project-id`) are skipped.
 *
 * Usage:
 *   grove migrate              Execute migration
 *   grove migrate --dry-run    Print plan without writing
 *   grove migrate --rollback   Reverse a previous migration
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { generateProjectId, readProjectId, writeProjectId } from "../../core/project-id.js";
import {
  appendServerKey,
  generateApiKey,
  writeClientKey,
  writeNamespace,
} from "../../core/project-key.js";
import { initSqliteDb, readStoreNamespace, writeStoreNamespace } from "../../local/sqlite-store.js";
import { resolveGroveDir } from "../utils/grove-dir.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrateOptions {
  readonly dryRun: boolean;
  readonly rollback: boolean;
  readonly cwd: string;
  readonly groveOverride?: string | undefined;
}

interface MigrationPlan {
  readonly projectId: string;
  readonly namespace: string;
  readonly apiKey: string;
  readonly contributionCount: number;
  readonly claimCount: number;
  readonly previousNamespace: string;
}

interface InversePlan {
  readonly type: "namespace-migration";
  readonly version: 1;
  readonly appliedAt: string;
  readonly namespace: string;
  readonly filesCreated: readonly string[];
  readonly previousNamespace: string;
  readonly contributionCount: number;
  readonly claimCount: number;
}

const MIGRATIONS_DIR = "migrations";
const INVERSE_PLAN_FILE = "inverse-plan.json";
const WORKTREE_NAME = "main";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function parseMigrateArgs(args: readonly string[]): MigrateOptions {
  const { values } = parseArgs({
    args: [...args],
    options: {
      "dry-run": { type: "boolean", default: false },
      rollback: { type: "boolean", default: false },
      grove: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  return {
    dryRun: (values["dry-run"] as boolean) ?? false,
    rollback: (values.rollback as boolean) ?? false,
    cwd: process.cwd(),
    groveOverride: values.grove as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export async function handleMigrate(
  args: readonly string[],
  groveOverride?: string,
): Promise<void> {
  const opts = parseMigrateArgs(args);
  const effectiveGroveOverride = opts.groveOverride ?? groveOverride;

  const { groveDir, dbPath } = resolveGroveDir(effectiveGroveOverride);

  if (opts.rollback) {
    await executeRollback(groveDir, dbPath);
    return;
  }

  // Fresh-install guard: project-id already exists → skip migration.
  const existingId = readProjectId(groveDir);
  if (existingId !== null) {
    console.log(
      `grove migrate: project-id already present (${existingId}). Fresh install — no migration needed.`,
    );
    return;
  }

  const db = initSqliteDb(dbPath);
  try {
    const plan = buildPlan(groveDir, db);
    printPlan(plan);

    if (opts.dryRun) {
      console.log("\nDry run — no changes written.");
      return;
    }

    applyMigration(plan, groveDir, db);
    console.log(`\nMigration complete. Namespace: ${plan.namespace}`);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function buildPlan(_groveDir: string, db: ReturnType<typeof initSqliteDb>): MigrationPlan {
  const projectId = generateProjectId();
  const namespace = `${projectId}/${WORKTREE_NAME}`;
  const apiKey = generateApiKey();

  const previousNamespace = readStoreNamespace(db);

  const contribRow = db.prepare("SELECT COUNT(*) as n FROM contributions").get() as { n: number };
  const claimRow = db.prepare("SELECT COUNT(*) as n FROM claims").get() as { n: number };

  return {
    projectId,
    namespace,
    apiKey,
    contributionCount: contribRow.n,
    claimCount: claimRow.n,
    previousNamespace,
  };
}

function printPlan(plan: MigrationPlan): void {
  console.log("grove migrate: migration plan");
  console.log(`  project-id:           ${plan.projectId}`);
  console.log(`  namespace:            ${plan.namespace}`);
  console.log(`  previous namespace:   ${plan.previousNamespace}`);
  console.log(`  contributions:        ${plan.contributionCount}`);
  console.log(`  claims:               ${plan.claimCount}`);
  console.log(`  files to create:      project-id, api-key, server-keys.yaml, namespace`);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function applyMigration(
  plan: MigrationPlan,
  groveDir: string,
  db: ReturnType<typeof initSqliteDb>,
): void {
  const filesCreated: string[] = [];

  // 1. Write project-id.
  writeProjectId(groveDir, plan.projectId);
  filesCreated.push("project-id");

  // 2. Write credentials.
  writeClientKey(groveDir, plan.apiKey);
  filesCreated.push("api-key");
  appendServerKey(groveDir, plan.apiKey, plan.namespace);
  filesCreated.push("server-keys.yaml");
  writeNamespace(groveDir, plan.namespace);
  filesCreated.push("namespace");

  // 3. Write namespace into the SQLite store so listEntities projects correctly.
  writeStoreNamespace(db, plan.namespace);

  // 4. Record inverse plan for rollback.
  const migrationsDir = join(groveDir, MIGRATIONS_DIR);
  mkdirSync(migrationsDir, { recursive: true });
  const inversePlan: InversePlan = {
    type: "namespace-migration",
    version: 1,
    appliedAt: new Date().toISOString(),
    namespace: plan.namespace,
    filesCreated,
    previousNamespace: plan.previousNamespace,
    contributionCount: plan.contributionCount,
    claimCount: plan.claimCount,
  };
  writeFileSync(
    join(migrationsDir, INVERSE_PLAN_FILE),
    `${JSON.stringify(inversePlan, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

async function executeRollback(groveDir: string, dbPath: string): Promise<void> {
  const inversePlanPath = join(groveDir, MIGRATIONS_DIR, INVERSE_PLAN_FILE);

  let raw: string;
  try {
    raw = readFileSync(inversePlanPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "grove migrate --rollback: no inverse-plan.json found. Has the migration been applied?",
      );
    }
    throw err;
  }

  const plan = JSON.parse(raw) as InversePlan;

  if (plan.type !== "namespace-migration" || plan.version !== 1) {
    throw new Error(
      `grove migrate --rollback: unrecognized inverse-plan format (type=${plan.type}, version=${plan.version})`,
    );
  }

  console.log(`grove migrate --rollback: reversing migration applied at ${plan.appliedAt}`);
  console.log(`  namespace was:  ${plan.namespace}`);
  console.log(`  reverting to:   ${plan.previousNamespace}`);

  // Remove credential files.
  for (const file of plan.filesCreated) {
    const filePath = join(groveDir, file);
    try {
      rmSync(filePath, { force: true });
      console.log(`  removed: .grove/${file}`);
    } catch (err) {
      console.warn(`  warning: could not remove .grove/${file}: ${(err as Error).message}`);
    }
  }

  // Restore previous namespace in the SQLite store.
  const db = initSqliteDb(dbPath);
  try {
    if (plan.previousNamespace === "default") {
      // No explicit namespace was set before; remove the row.
      db.run("DELETE FROM project_settings WHERE key = 'namespace'");
    } else {
      writeStoreNamespace(db, plan.previousNamespace);
    }
  } finally {
    db.close();
  }

  // Remove inverse-plan.json so rollback is idempotent.
  rmSync(inversePlanPath, { force: true });

  console.log("\nRollback complete.");
}

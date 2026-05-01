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

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { generateProjectId, readProjectId, writeProjectId } from "../../core/project-id.js";
import {
  appendServerKey,
  CLIENT_KEY_FILE,
  generateApiKey,
  NAMESPACE_FILE,
  parseServerKeys,
  removeServerKey,
  SERVER_KEYS_FILE,
  writeClientKey,
  writeNamespace,
} from "../../core/project-key.js";
import { initSqliteDb, readStoreNamespace, writeStoreNamespace } from "../../local/sqlite-store.js";
import { resolveGroveDir } from "../utils/grove-dir.js";

/**
 * Files the migration is allowed to create or remove inside the grove dir.
 * Used as a whitelist for rollback to prevent a tampered inverse-plan.json
 * from deleting unrelated files (e.g. grove.db, grove.json).
 *
 * Note: server-keys.yaml is intentionally absent — rollback removes only
 * the migrated key from it via removeServerKey, never the whole file
 * (other worktrees may have entries there).
 */
const ALLOWED_FILES = new Set(["project-id", "api-key", "namespace"]);

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
  /**
   * Bearer token added to server-keys.yaml by this migration. Recorded so
   * rollback can surgically remove only this key — preserving any other
   * keys an operator may have added — instead of deleting the whole file.
   */
  readonly apiKey: string;
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

  const dryRun = (values["dry-run"] as boolean) ?? false;
  const rollback = (values.rollback as boolean) ?? false;
  if (dryRun && rollback) {
    throw new Error(
      "grove migrate: --dry-run and --rollback are mutually exclusive (rollback is destructive).",
    );
  }
  return {
    dryRun,
    rollback,
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

  // Require an existing grove.db. We must NOT silently bootstrap one — that
  // would mask a wrong --grove path or a lost database, then stamp identity
  // onto an empty store. Legitimate fresh installs go through `grove init`.
  if (!existsSync(dbPath)) {
    throw new Error(
      `grove migrate: ${dbPath} not found. Run \`grove init\` for a new grove, ` +
        `or pass --grove pointing at an existing legacy install.`,
    );
  }

  // Filesystem preconditions BEFORE opening the DB. initSqliteDb runs
  // schema migrations, so if we open it and then refuse on a clobber, we'd
  // leave behind a schema upgrade despite migration not proceeding.
  const apiKeyExists = existsSync(join(groveDir, CLIENT_KEY_FILE));
  const namespaceFileExists = existsSync(join(groveDir, NAMESPACE_FILE));

  // Read orphan flag via a read-only DB handle; readStoreNamespace tolerates
  // a missing project_settings table on truly legacy DBs.
  const orphanProbe = new Database(dbPath, { readonly: true });
  let orphan: string;
  try {
    orphan = readStoreNamespace(orphanProbe);
  } finally {
    orphanProbe.close();
  }

  if (orphan !== "default" && (apiKeyExists || namespaceFileExists)) {
    throw new Error(
      "grove migrate: detected incomplete prior migration (orphaned SQLite namespace " +
        `'${orphan}' plus leftover credential files). Inspect .grove/api-key, ` +
        ".grove/namespace, and the project_settings row, remove them manually, " +
        "then re-run.",
    );
  }
  if (apiKeyExists) {
    throw new Error(
      "grove migrate: refusing to overwrite existing .grove/api-key. " +
        "Investigate and remove it manually if this grove is truly a legacy install.",
    );
  }
  if (namespaceFileExists) {
    throw new Error(
      "grove migrate: refusing to overwrite existing .grove/namespace. " +
        "Investigate and remove it manually if this grove is truly a legacy install.",
    );
  }

  // Dry-run uses a read-only handle so planning never mutates the DB
  // (including running schema migrations).
  if (opts.dryRun) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const plan = buildPlan(db);
      printPlan(plan);
      console.log("\nDry run — no changes written.");
    } finally {
      db.close();
    }
    return;
  }

  const db = initSqliteDb(dbPath);
  try {
    // Pure orphan with no leftover files: a previous run died between
    // writeStoreNamespace and writeClientKey. Safe to clear because no
    // migration-owned artifacts on disk reference this namespace.
    if (orphan !== "default") {
      console.warn(
        `grove migrate: detected orphaned namespace '${orphan}' from a previous incomplete run; resetting before re-planning.`,
      );
      db.run("DELETE FROM project_settings WHERE key = 'namespace'");
    }

    const plan = buildPlan(db);
    printPlan(plan);
    applyMigration(plan, groveDir, db);
    console.log(`\nMigration complete. Namespace: ${plan.namespace}`);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function buildPlan(db: Database): MigrationPlan {
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

function applyMigration(plan: MigrationPlan, groveDir: string, db: Database): void {
  // Preconditions (clobber checks, orphan recovery) are enforced in
  // handleMigrate before this function runs. By this point we own writes
  // to api-key, namespace, project-id, and the project_settings row.

  // Order matters: project-id is written LAST as the "commit marker" — its
  // absence is the fresh-install guard's signal that migration may safely
  // retry. If anything before fails, we roll back partial state and the
  // next `grove migrate` run can re-apply cleanly.
  const filesCreated: string[] = [];
  const migrationsDir = join(groveDir, MIGRATIONS_DIR);
  const inversePlanPath = join(migrationsDir, INVERSE_PLAN_FILE);
  let dbNamespaceWritten = false;
  let serverKeyAppended = false;

  try {
    // 1. SQLite store namespace (idempotent via INSERT OR REPLACE).
    writeStoreNamespace(db, plan.namespace);
    dbNamespaceWritten = true;

    // 2. Credential files. server-keys.yaml may already exist with unrelated
    //    keys (e.g. another worktree's registration); appendServerKey
    //    preserves them. Rollback removes only OUR key, never the file.
    writeClientKey(groveDir, plan.apiKey);
    filesCreated.push("api-key");
    appendServerKey(groveDir, plan.apiKey, plan.namespace);
    serverKeyAppended = true;
    writeNamespace(groveDir, plan.namespace);
    filesCreated.push("namespace");

    // 3. Inverse plan (must include project-id even though we write it last,
    //    so rollback after a successful migration removes it). server-keys.yaml
    //    is intentionally NOT in filesCreated — rollback removes our key
    //    surgically via apiKey.
    mkdirSync(migrationsDir, { recursive: true });
    const inversePlan: InversePlan = {
      type: "namespace-migration",
      version: 1,
      appliedAt: new Date().toISOString(),
      namespace: plan.namespace,
      filesCreated: [...filesCreated, "project-id"],
      previousNamespace: plan.previousNamespace,
      contributionCount: plan.contributionCount,
      claimCount: plan.claimCount,
      apiKey: plan.apiKey,
    };
    writeFileSync(inversePlanPath, `${JSON.stringify(inversePlan, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    // 4. Commit marker: project-id. Once this exists, subsequent migrate
    //    runs hit the fresh-install guard and skip.
    writeProjectId(groveDir, plan.projectId);
  } catch (err) {
    cleanupPartial(
      groveDir,
      db,
      filesCreated,
      dbNamespaceWritten,
      plan.previousNamespace,
      serverKeyAppended ? plan.apiKey : undefined,
    );
    rmSync(inversePlanPath, { force: true });
    throw err;
  }
}

/**
 * Best-effort cleanup of partial migration state. Called only when a step
 * AFTER the SQLite write fails — never after `writeProjectId` succeeds, since
 * that marks the migration as durable.
 */
function cleanupPartial(
  groveDir: string,
  db: Database,
  filesCreated: readonly string[],
  dbNamespaceWritten: boolean,
  previousNamespace: string,
  serverKey: string | undefined,
): void {
  for (const name of filesCreated) {
    if (!ALLOWED_FILES.has(name)) continue;
    try {
      rmSync(join(groveDir, name), { force: true });
    } catch {
      /* best-effort */
    }
  }
  if (serverKey !== undefined) {
    try {
      const result = removeServerKey(groveDir, serverKey);
      if (result.registryFound && result.removed && result.remaining === 0) {
        rmSync(join(groveDir, SERVER_KEYS_FILE), { force: true });
      }
    } catch {
      /* best-effort */
    }
  }
  if (dbNamespaceWritten) {
    try {
      if (previousNamespace === "default") {
        db.run("DELETE FROM project_settings WHERE key = 'namespace'");
      } else {
        writeStoreNamespace(db, previousNamespace);
      }
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Strict-validate the parsed JSON against the InversePlan shape. Rejects
 * unknown types, wrong versions, missing or non-string fields, and any
 * filesCreated entry that escapes the allowlist or contains a path
 * separator. A corrupt plan would otherwise let rollback delete arbitrary
 * files inside .grove/ (or — via traversal — outside it).
 */
function parseInversePlan(raw: string): InversePlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`grove migrate --rollback: inverse-plan.json is not valid JSON: ${err}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("grove migrate --rollback: inverse-plan.json is not an object");
  }
  const p = parsed as Record<string, unknown>;
  if (p.type !== "namespace-migration") {
    throw new Error(
      `grove migrate --rollback: unrecognized inverse-plan type (type=${String(p.type)})`,
    );
  }
  if (p.version !== 1) {
    throw new Error(
      `grove migrate --rollback: unsupported inverse-plan version (version=${String(p.version)})`,
    );
  }
  if (typeof p.appliedAt !== "string" || typeof p.namespace !== "string") {
    throw new Error("grove migrate --rollback: inverse-plan.json missing required string fields");
  }
  if (typeof p.previousNamespace !== "string") {
    throw new Error("grove migrate --rollback: inverse-plan.json missing previousNamespace");
  }
  if (!Array.isArray(p.filesCreated)) {
    throw new Error("grove migrate --rollback: inverse-plan.json filesCreated must be an array");
  }
  for (const f of p.filesCreated) {
    if (typeof f !== "string" || !ALLOWED_FILES.has(f)) {
      throw new Error(
        `grove migrate --rollback: inverse-plan.json contains disallowed file '${String(f)}'`,
      );
    }
  }
  if (typeof p.apiKey !== "string" || p.apiKey.length === 0) {
    throw new Error("grove migrate --rollback: inverse-plan.json missing apiKey");
  }
  return {
    type: "namespace-migration",
    version: 1,
    appliedAt: p.appliedAt,
    namespace: p.namespace,
    filesCreated: p.filesCreated as readonly string[],
    previousNamespace: p.previousNamespace,
    contributionCount: typeof p.contributionCount === "number" ? p.contributionCount : 0,
    claimCount: typeof p.claimCount === "number" ? p.claimCount : 0,
    apiKey: p.apiKey,
  };
}

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

  const plan = parseInversePlan(raw);

  console.log(`grove migrate --rollback: reversing migration applied at ${plan.appliedAt}`);
  console.log(`  namespace was:  ${plan.namespace}`);
  console.log(`  reverting to:   ${plan.previousNamespace}`);

  // Preflight: validate the server-keys.yaml registry parses before
  // deleting anything. If parsing fails (unsupported version, malformed
  // YAML), we abort rollback while local credential files are still
  // intact — leaving the workspace authorized rather than half-revoked.
  try {
    parseServerKeys(groveDir);
  } catch (err) {
    throw new Error(
      `grove migrate --rollback: cannot proceed; .grove/${SERVER_KEYS_FILE} ` +
        `is in an unsupported state (${(err as Error).message}). ` +
        `Local credentials and inverse-plan retained — fix the registry, then retry.`,
    );
  }

  // Collect failures rather than swallowing them. Rollback must fail closed:
  // if any expected mutation does not succeed (or cannot be verified as
  // already done), preserve inverse-plan.json so the operator can retry.
  const failures: string[] = [];

  // Order: registry surgery FIRST, then local file deletes, then DB. This
  // way a failure in registry mutation (the most likely failure path on
  // unusual disk state) leaves the workspace fully authorized rather than
  // partially de-authorized with credentials missing.
  try {
    const result = removeServerKey(groveDir, plan.apiKey);
    if (result.registryFound && result.removed) {
      if (result.remaining === 0) {
        rmSync(join(groveDir, SERVER_KEYS_FILE), { force: true });
        console.log(`  removed: .grove/${SERVER_KEYS_FILE} (empty after key removal)`);
      } else {
        console.log(
          `  removed migrated key from .grove/${SERVER_KEYS_FILE} (${result.remaining} keys left)`,
        );
      }
    } else if (!result.registryFound) {
      console.log(`  .grove/${SERVER_KEYS_FILE} absent (skipping)`);
    } else {
      console.log(`  migrated key already absent from .grove/${SERVER_KEYS_FILE} (skipping)`);
    }
  } catch (err) {
    // We already preflight-validated, so this is a write error (disk full,
    // permissions). Bail before touching local files.
    throw new Error(
      `grove migrate --rollback: server-keys.yaml mutation failed (${(err as Error).message}). ` +
        `Local credentials and inverse-plan retained — fix the registry, then retry.`,
    );
  }

  // Remove migration-owned credential files. Allowlist + basename check
  // prevents a tampered inverse-plan from deleting unrelated entries.
  for (const file of plan.filesCreated) {
    if (!ALLOWED_FILES.has(file)) {
      failures.push(`unrecognized entry '${file}' (not in allowlist)`);
      continue;
    }
    if (file.includes("/") || file.includes("\\") || file === "." || file === "..") {
      failures.push(`suspicious entry '${file}'`);
      continue;
    }
    const filePath = join(groveDir, file);
    try {
      rmSync(filePath, { force: true });
      if (existsSync(filePath)) {
        failures.push(`.grove/${file} still present after removal attempt`);
      } else {
        console.log(`  removed: .grove/${file}`);
      }
    } catch (err) {
      failures.push(`could not remove .grove/${file}: ${(err as Error).message}`);
    }
  }

  // Restore previous namespace in the SQLite store.
  const db = initSqliteDb(dbPath);
  try {
    try {
      if (plan.previousNamespace === "default") {
        db.run("DELETE FROM project_settings WHERE key = 'namespace'");
      } else {
        writeStoreNamespace(db, plan.previousNamespace);
      }
    } catch (err) {
      failures.push(`could not restore SQLite namespace: ${(err as Error).message}`);
    }
  } finally {
    db.close();
  }

  if (failures.length > 0) {
    // Preserve inverse-plan.json so the operator can retry rollback.
    throw new Error(
      `grove migrate --rollback: incomplete (${failures.length} failure${failures.length === 1 ? "" : "s"}). ` +
        `Inverse plan retained at .grove/${MIGRATIONS_DIR}/${INVERSE_PLAN_FILE}. Failures:\n  - ` +
        failures.join("\n  - "),
    );
  }

  // Remove inverse-plan.json only on full success so rollback is idempotent.
  rmSync(inversePlanPath, { force: true });

  console.log("\nRollback complete.");
}

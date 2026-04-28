/**
 * Tests for `grove migrate` command (A4: legacy → namespaced migration).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidProjectId } from "../../core/project-id.js";
import { initSqliteDb, readStoreNamespace } from "../../local/sqlite-store.js";
import { handleMigrate, parseMigrateArgs } from "./migrate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createLegacyGrove(): Promise<string> {
  const dir = join(
    tmpdir(),
    `grove-migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  const groveDir = join(dir, ".grove");
  mkdirSync(groveDir, { recursive: true });

  // Create a minimal grove.db (legacy: no project-id, no credentials).
  initSqliteDb(join(groveDir, "grove.db")).close();

  // Write a minimal grove.json so resolveGroveDir is satisfied.
  writeFileSync(
    join(groveDir, "grove.json"),
    JSON.stringify({ name: "test-grove", mode: "evaluation" }),
    "utf8",
  );

  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// parseMigrateArgs
// ---------------------------------------------------------------------------

describe("parseMigrateArgs", () => {
  it("defaults: dryRun=false, rollback=false", () => {
    const opts = parseMigrateArgs([]);
    expect(opts.dryRun).toBe(false);
    expect(opts.rollback).toBe(false);
  });

  it("parses --dry-run", () => {
    const opts = parseMigrateArgs(["--dry-run"]);
    expect(opts.dryRun).toBe(true);
  });

  it("parses --rollback", () => {
    const opts = parseMigrateArgs(["--rollback"]);
    expect(opts.rollback).toBe(true);
  });

  it("parses --grove override", () => {
    const opts = parseMigrateArgs(["--grove", "/some/path/.grove"]);
    expect(opts.groveOverride).toBe("/some/path/.grove");
  });
});

// ---------------------------------------------------------------------------
// handleMigrate — fresh install guard
// ---------------------------------------------------------------------------

describe("handleMigrate: fresh install guard", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createLegacyGrove();
    // Write project-id to simulate a fresh install.
    writeFileSync(
      join(dir, ".grove", "project-id"),
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n",
      "utf8",
    );
  });

  afterEach(() => cleanup(dir));

  it("skips migration when project-id already exists", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    try {
      await handleMigrate([], join(dir, ".grove"));
    } finally {
      console.log = origLog;
    }
    expect(logs.some((l) => l.includes("no migration needed"))).toBe(true);
    // Namespace should not have been set.
    const db = initSqliteDb(join(dir, ".grove", "grove.db"));
    const ns = readStoreNamespace(db);
    db.close();
    expect(ns).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// handleMigrate — dry run
// ---------------------------------------------------------------------------

describe("handleMigrate: --dry-run", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createLegacyGrove();
  });

  afterEach(() => cleanup(dir));

  it("prints plan but writes nothing", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    try {
      await handleMigrate(["--dry-run"], join(dir, ".grove"));
    } finally {
      console.log = origLog;
    }

    expect(logs.some((l) => l.includes("Dry run"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "project-id"))).toBe(false);
    expect(existsSync(join(dir, ".grove", "api-key"))).toBe(false);
    expect(existsSync(join(dir, ".grove", "namespace"))).toBe(false);
    expect(existsSync(join(dir, ".grove", "migrations", "inverse-plan.json"))).toBe(false);

    const db = initSqliteDb(join(dir, ".grove", "grove.db"));
    const ns = readStoreNamespace(db);
    db.close();
    expect(ns).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// handleMigrate — execute
// ---------------------------------------------------------------------------

describe("handleMigrate: execute", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createLegacyGrove();
  });

  afterEach(() => cleanup(dir));

  it("writes project-id as valid UUID", async () => {
    await handleMigrate([], join(dir, ".grove"));
    const raw = readFileSync(join(dir, ".grove", "project-id"), "utf8").trim();
    expect(isValidProjectId(raw)).toBe(true);
  });

  it("writes api-key with grv_ prefix", async () => {
    await handleMigrate([], join(dir, ".grove"));
    const key = readFileSync(join(dir, ".grove", "api-key"), "utf8").trim();
    expect(key.startsWith("grv_")).toBe(true);
  });

  it("writes namespace as {uuid}/main", async () => {
    await handleMigrate([], join(dir, ".grove"));
    const ns = readFileSync(join(dir, ".grove", "namespace"), "utf8").trim();
    const projectId = readFileSync(join(dir, ".grove", "project-id"), "utf8").trim();
    expect(ns).toBe(`${projectId}/main`);
  });

  it("writes server-keys.yaml", async () => {
    await handleMigrate([], join(dir, ".grove"));
    expect(existsSync(join(dir, ".grove", "server-keys.yaml"))).toBe(true);
  });

  it("sets store namespace in SQLite to {uuid}/main", async () => {
    await handleMigrate([], join(dir, ".grove"));
    const projectId = readFileSync(join(dir, ".grove", "project-id"), "utf8").trim();
    const db = initSqliteDb(join(dir, ".grove", "grove.db"));
    const ns = readStoreNamespace(db);
    db.close();
    expect(ns).toBe(`${projectId}/main`);
  });

  it("writes inverse-plan.json under .grove/migrations/", async () => {
    await handleMigrate([], join(dir, ".grove"));
    const planPath = join(dir, ".grove", "migrations", "inverse-plan.json");
    expect(existsSync(planPath)).toBe(true);

    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    expect(plan.type).toBe("namespace-migration");
    expect(plan.version).toBe(1);
    expect(plan.namespace).toContain("/main");
    expect(plan.previousNamespace).toBe("default");
    expect(Array.isArray(plan.filesCreated)).toBe(true);
    expect(plan.filesCreated).toContain("project-id");
  });

  it("is idempotent: second run skips (project-id exists)", async () => {
    await handleMigrate([], join(dir, ".grove"));
    const firstId = readFileSync(join(dir, ".grove", "project-id"), "utf8").trim();

    // Second call should skip.
    await handleMigrate([], join(dir, ".grove"));
    const secondId = readFileSync(join(dir, ".grove", "project-id"), "utf8").trim();
    expect(secondId).toBe(firstId);
  });
});

// ---------------------------------------------------------------------------
// handleMigrate: --rollback
// ---------------------------------------------------------------------------

describe("handleMigrate: --rollback", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createLegacyGrove();
    await handleMigrate([], join(dir, ".grove"));
  });

  afterEach(() => cleanup(dir));

  it("removes project-id after rollback", async () => {
    await handleMigrate(["--rollback"], join(dir, ".grove"));
    expect(existsSync(join(dir, ".grove", "project-id"))).toBe(false);
  });

  it("removes api-key after rollback", async () => {
    await handleMigrate(["--rollback"], join(dir, ".grove"));
    expect(existsSync(join(dir, ".grove", "api-key"))).toBe(false);
  });

  it("removes namespace file after rollback", async () => {
    await handleMigrate(["--rollback"], join(dir, ".grove"));
    expect(existsSync(join(dir, ".grove", "namespace"))).toBe(false);
  });

  it("removes inverse-plan.json after rollback", async () => {
    await handleMigrate(["--rollback"], join(dir, ".grove"));
    expect(existsSync(join(dir, ".grove", "migrations", "inverse-plan.json"))).toBe(false);
  });

  it("resets store namespace to default after rollback", async () => {
    await handleMigrate(["--rollback"], join(dir, ".grove"));
    const db = initSqliteDb(join(dir, ".grove", "grove.db"));
    const ns = readStoreNamespace(db);
    db.close();
    expect(ns).toBe("default");
  });

  it("throws if no inverse-plan.json exists", async () => {
    // Already rolled back — try again.
    await handleMigrate(["--rollback"], join(dir, ".grove"));
    await expect(handleMigrate(["--rollback"], join(dir, ".grove"))).rejects.toThrow(
      "no inverse-plan.json found",
    );
  });
});

// ---------------------------------------------------------------------------
// Round-2 hardening tests
// ---------------------------------------------------------------------------

describe("handleMigrate: --dry-run --rollback rejected", () => {
  it("rejects both flags at parse time", () => {
    expect(() => parseMigrateArgs(["--dry-run", "--rollback"])).toThrow("mutually exclusive");
  });
});

describe("handleMigrate: refuses to clobber existing credential files", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createLegacyGrove();
  });

  afterEach(() => cleanup(dir));

  it("refuses if api-key already exists", async () => {
    writeFileSync(join(dir, ".grove", "api-key"), "grv_preexisting\n", "utf8");
    await expect(handleMigrate([], join(dir, ".grove"))).rejects.toThrow(
      "refusing to overwrite existing .grove/api-key",
    );
    // No project-id should have been written.
    expect(existsSync(join(dir, ".grove", "project-id"))).toBe(false);
  });

  it("refuses if namespace file already exists", async () => {
    writeFileSync(join(dir, ".grove", "namespace"), "manual/ns\n", "utf8");
    await expect(handleMigrate([], join(dir, ".grove"))).rejects.toThrow(
      "refusing to overwrite existing .grove/namespace",
    );
  });
});

describe("handleMigrate: refuses on missing grove.db", () => {
  it("errors with clear message when DB is missing", async () => {
    const dir = join(
      tmpdir(),
      `grove-migrate-missingdb-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(dir, ".grove"), { recursive: true });
    writeFileSync(join(dir, ".grove", "grove.json"), "{}", "utf8");
    try {
      await expect(handleMigrate([], join(dir, ".grove"))).rejects.toThrow("not found");
      // Migration must not have stamped identity onto a non-existent DB.
      expect(existsSync(join(dir, ".grove", "project-id"))).toBe(false);
      expect(existsSync(join(dir, ".grove", "grove.db"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("handleMigrate: orphaned namespace recovery", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createLegacyGrove();
    // Simulate a crashed previous run: SQLite has a non-default namespace
    // but no project-id was ever written.
    const db = initSqliteDb(join(dir, ".grove", "grove.db"));
    db.run(
      "INSERT OR REPLACE INTO project_settings (key, value) VALUES ('namespace', 'orphan-uuid/main')",
    );
    db.close();
  });

  afterEach(() => cleanup(dir));

  it("clears orphan namespace and the new inverse-plan rolls back to 'default'", async () => {
    await handleMigrate([], join(dir, ".grove"));
    const planPath = join(dir, ".grove", "migrations", "inverse-plan.json");
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    expect(plan.previousNamespace).toBe("default");
    expect(plan.namespace).not.toBe("orphan-uuid/main");

    // Rollback should restore to default, NOT to the orphan value.
    await handleMigrate(["--rollback"], join(dir, ".grove"));
    const db = initSqliteDb(join(dir, ".grove", "grove.db"));
    const ns = readStoreNamespace(db);
    db.close();
    expect(ns).toBe("default");
  });
});

describe("handleMigrate: surgical server-keys.yaml rollback", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createLegacyGrove();
  });

  afterEach(() => cleanup(dir));

  it("rollback removes only the migrated key, preserving other entries", async () => {
    // Pre-seed server-keys.yaml with an unrelated entry from a different worktree.
    const serverKeysPath = join(dir, ".grove", "server-keys.yaml");
    writeFileSync(
      serverKeysPath,
      [
        "version: 1",
        "keys:",
        "  grv_other_worktree_key:",
        "    namespace: other-uuid/branch-a",
        "    createdAt: 2026-01-01T00:00:00Z",
        "",
      ].join("\n"),
      "utf8",
    );

    await handleMigrate([], join(dir, ".grove"));
    // Both keys present after migration.
    const afterMigrate = readFileSync(serverKeysPath, "utf8");
    expect(afterMigrate).toContain("grv_other_worktree_key");

    await handleMigrate(["--rollback"], join(dir, ".grove"));
    // File still exists; only our key was removed.
    expect(existsSync(serverKeysPath)).toBe(true);
    const afterRollback = readFileSync(serverKeysPath, "utf8");
    expect(afterRollback).toContain("grv_other_worktree_key");
    expect(afterRollback).not.toContain("/main");
  });

  it("rollback deletes server-keys.yaml when migrated key was the only entry", async () => {
    await handleMigrate([], join(dir, ".grove"));
    const serverKeysPath = join(dir, ".grove", "server-keys.yaml");
    expect(existsSync(serverKeysPath)).toBe(true);

    await handleMigrate(["--rollback"], join(dir, ".grove"));
    expect(existsSync(serverKeysPath)).toBe(false);
  });
});

describe("handleMigrate: --rollback rejects corrupted inverse-plan", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createLegacyGrove();
    await handleMigrate([], join(dir, ".grove"));
  });

  afterEach(() => cleanup(dir));

  it("rejects path-traversal entries in filesCreated", async () => {
    const planPath = join(dir, ".grove", "migrations", "inverse-plan.json");
    const tampered = JSON.parse(readFileSync(planPath, "utf8"));
    tampered.filesCreated = ["../../etc/passwd", ...tampered.filesCreated];
    writeFileSync(planPath, JSON.stringify(tampered), "utf8");
    await expect(handleMigrate(["--rollback"], join(dir, ".grove"))).rejects.toThrow(
      "disallowed file",
    );
  });

  it("rejects unsupported version", async () => {
    const planPath = join(dir, ".grove", "migrations", "inverse-plan.json");
    const tampered = JSON.parse(readFileSync(planPath, "utf8"));
    tampered.version = 999;
    writeFileSync(planPath, JSON.stringify(tampered), "utf8");
    await expect(handleMigrate(["--rollback"], join(dir, ".grove"))).rejects.toThrow(
      "unsupported inverse-plan version",
    );
  });
});

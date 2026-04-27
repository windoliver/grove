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

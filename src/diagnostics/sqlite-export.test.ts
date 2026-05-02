import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeContribution } from "../core/test-helpers.js";
import { initSqliteDb, SqliteContributionStore } from "../local/sqlite-store.js";
import type { DiagnosticEntry, SqliteExportManifest } from "./sqlite-export.js";
import { exportSqliteSummaries } from "./sqlite-export.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("exportSqliteSummaries", () => {
  test("exports newest contributions first and caps at recentContributionLimit", async () => {
    const ctx = await createExportContext();
    const db = initSqliteDb(ctx.dbPath);
    try {
      const store = new SqliteContributionStore(db);
      await store.putMany([
        makeContribution({ summary: "old", createdAt: "2026-01-01T00:00:00Z" }),
        makeContribution({ summary: "newest", createdAt: "2026-01-03T00:00:00Z" }),
        makeContribution({ summary: "middle", createdAt: "2026-01-02T00:00:00Z" }),
      ]);
    } finally {
      db.close();
    }

    const result = exportSqliteSummaries(ctx.dbPath, {
      recentContributionLimit: 2,
    });

    expect(result.manifest.tables.contributions?.rowCount).toBe(3);
    expect(result.manifest.tables.contributions?.exportedPath).toBe(
      "db/contributions-recent.jsonl",
    );

    const lines = readJsonl(getEntry(result.entries, "db/contributions-recent.jsonl"));
    expect(lines.map((line) => line.summary)).toEqual(["newest", "middle"]);
  });

  test("manifest counts total contributions rows", async () => {
    const ctx = await createExportContext();
    const db = initSqliteDb(ctx.dbPath);
    try {
      const store = new SqliteContributionStore(db);
      await store.putMany([
        makeContribution({ summary: "one", createdAt: "2026-01-01T00:00:00Z" }),
        makeContribution({ summary: "two", createdAt: "2026-01-02T00:00:00Z" }),
      ]);
    } finally {
      db.close();
    }

    const result = exportSqliteSummaries(ctx.dbPath, {
      recentContributionLimit: 1,
    });
    const manifest = readJson<SqliteExportManifest>(
      getEntry(result.entries, "db/table-manifest.json"),
    );

    expect(result.manifest.tables.contributions?.rowCount).toBe(2);
    expect(manifest.tables.contributions?.rowCount).toBe(2);
  });

  test("records missing optional tables without throwing and includes table manifest", async () => {
    const ctx = await createExportContext();
    const db = initSqliteDb(ctx.dbPath);
    try {
      db.run("DROP TABLE IF EXISTS outcomes");
    } finally {
      db.close();
    }

    const result = exportSqliteSummaries(ctx.dbPath, {
      recentContributionLimit: 10,
    });
    const manifest = readJson<SqliteExportManifest>(
      getEntry(result.entries, "db/table-manifest.json"),
    );

    expect(result.manifest.tables.outcomes).toEqual({
      present: false,
      rowCount: 0,
      warning: "Table not present in SQLite database",
    });
    const outcomeManifest = manifest.tables.outcomes;
    if (outcomeManifest === undefined) {
      throw new Error("Expected outcomes table manifest entry");
    }
    expect(outcomeManifest.present).toBe(false);
    expect(result.entries.map((entry) => entry.path)).toContain("db/table-manifest.json");
  });

  test("exports idempotency rows with only table-level safe fields", async () => {
    const ctx = await createExportContext();
    const db = initSqliteDb(ctx.dbPath);
    try {
      db.run(
        `INSERT INTO idempotency_keys (cache_key, fingerprint, result_json, status, stored_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          "agent:target:work",
          "secret-fingerprint",
          JSON.stringify({ token: "secret-payload" }),
          "committed",
          1_767_225_600_000,
        ],
      );
    } finally {
      db.close();
    }

    const result = exportSqliteSummaries(ctx.dbPath, {
      recentContributionLimit: 10,
    });
    const idempotencyEntry = getEntry(result.entries, "db/idempotency.json");
    const idempotencyRows = readJson<readonly Record<string, unknown>[]>(idempotencyEntry);
    expect(idempotencyRows).toEqual([
      {
        cache_key: "agent:target:work",
        status: "committed",
        stored_at: 1_767_225_600_000,
      },
    ]);

    const rawExport = decodeEntry(idempotencyEntry);
    expect(rawExport).not.toContain("fingerprint");
    expect(rawExport).not.toContain("result_json");
    expect(rawExport).not.toContain("secret-fingerprint");
    expect(rawExport).not.toContain("secret-payload");
  });

  test("continues when contributions table is missing", async () => {
    const ctx = await createExportContext();
    new Database(ctx.dbPath).close();

    const result = exportSqliteSummaries(ctx.dbPath, {
      recentContributionLimit: 10,
    });

    expect(decodeEntry(getEntry(result.entries, "db/contributions-recent.jsonl"))).toBe("");
    expect(result.entries.map((entry) => entry.path)).toContain("db/table-manifest.json");
    expect(result.manifest.tables.contributions).toEqual({
      present: false,
      rowCount: 0,
      exportedPath: "db/contributions-recent.jsonl",
      warning: "Table not present in SQLite database",
    });
  });

  test("records warning when present contributions table cannot export recent manifests", async () => {
    const ctx = await createExportContext();
    const db = new Database(ctx.dbPath);
    try {
      db.run("CREATE TABLE contributions (cid TEXT PRIMARY KEY)");
      db.run("INSERT INTO contributions (cid) VALUES (?)", ["legacy-cid"]);
    } finally {
      db.close();
    }

    const result = exportSqliteSummaries(ctx.dbPath, {
      recentContributionLimit: 10,
    });

    expect(decodeEntry(getEntry(result.entries, "db/contributions-recent.jsonl"))).toBe("");
    expect(result.entries.map((entry) => entry.path)).toContain("db/table-manifest.json");
    expect(result.manifest.tables.contributions?.present).toBe(true);
    expect(result.manifest.tables.contributions?.rowCount).toBe(1);
    expect(result.manifest.tables.contributions?.exportedPath).toBe(
      "db/contributions-recent.jsonl",
    );
    expect(result.manifest.tables.contributions?.warning).toContain(
      "Failed to export recent contributions",
    );
  });

  test("records optional table query failures without aborting export", async () => {
    const ctx = await createExportContext();
    const db = initSqliteDb(ctx.dbPath);
    try {
      db.run("DROP TABLE idempotency_keys");
      db.run("CREATE TABLE idempotency_keys (cache_key TEXT PRIMARY KEY)");
      db.run("INSERT INTO idempotency_keys (cache_key) VALUES (?)", ["legacy-key"]);
    } finally {
      db.close();
    }

    const result = exportSqliteSummaries(ctx.dbPath, {
      recentContributionLimit: 10,
    });

    expect(result.entries.map((entry) => entry.path)).toContain("db/table-manifest.json");
    expect(result.entries.map((entry) => entry.path)).not.toContain("db/idempotency.json");
    expect(result.manifest.tables.idempotency_keys?.present).toBe(true);
    expect(result.manifest.tables.idempotency_keys?.rowCount).toBe(1);
    expect(result.manifest.tables.idempotency_keys?.warning).toContain("Failed to export table");
  });
});

async function createExportContext(): Promise<{ dbPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "grove-sqlite-export-"));
  tempDirs.push(dir);
  return {
    dbPath: join(dir, "grove.db"),
  };
}

function getEntry(entries: readonly DiagnosticEntry[], path: string): DiagnosticEntry {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) {
    throw new Error(`Expected diagnostic entry at ${path}`);
  }
  return entry;
}

function decodeEntry(entry: DiagnosticEntry): string {
  return new TextDecoder().decode(entry.bytes);
}

function readJson<T>(entry: DiagnosticEntry): T {
  return JSON.parse(decodeEntry(entry)) as T;
}

function readJsonl(entry: DiagnosticEntry): readonly Record<string, unknown>[] {
  return decodeEntry(entry)
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeContribution } from "../core/test-helpers.js";
import { initSqliteDb, SqliteContributionStore } from "../local/sqlite-store.js";
import type { SqliteExportManifest } from "./sqlite-export.js";
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
      outputDir: ctx.outputDir,
      recentContributionLimit: 2,
    });

    expect(result.manifest.contributions.rowCount).toBe(3);
    expect(result.manifest.contributions.exportedPath).toBe("db/contributions-recent.jsonl");

    const lines = await readJsonl(join(ctx.outputDir, "db", "contributions-recent.jsonl"));
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
      outputDir: ctx.outputDir,
      recentContributionLimit: 1,
    });
    const manifest = await readJson<SqliteExportManifest>(
      join(ctx.outputDir, "db", "table-manifest.json"),
    );

    expect(result.manifest.contributions.rowCount).toBe(2);
    expect(manifest.contributions.rowCount).toBe(2);
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
      outputDir: ctx.outputDir,
      recentContributionLimit: 10,
    });
    const manifest = await readJson<SqliteExportManifest>(
      join(ctx.outputDir, "db", "table-manifest.json"),
    );

    expect(result.manifest.tables.outcomes).toEqual({
      present: false,
      rowCount: 0,
      warnings: ["Table not present in SQLite database"],
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

    exportSqliteSummaries(ctx.dbPath, {
      outputDir: ctx.outputDir,
      recentContributionLimit: 10,
    });

    const idempotencyRows = await readJson<readonly Record<string, unknown>[]>(
      join(ctx.outputDir, "db", "idempotency.json"),
    );
    expect(idempotencyRows).toEqual([
      {
        cache_key: "agent:target:work",
        status: "committed",
        stored_at: 1_767_225_600_000,
      },
    ]);

    const rawExport = await readFile(join(ctx.outputDir, "db", "idempotency.json"), "utf8");
    expect(rawExport).not.toContain("fingerprint");
    expect(rawExport).not.toContain("result_json");
    expect(rawExport).not.toContain("secret-fingerprint");
    expect(rawExport).not.toContain("secret-payload");
  });
});

async function createExportContext(): Promise<{ dbPath: string; outputDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "grove-sqlite-export-"));
  tempDirs.push(dir);
  return {
    dbPath: join(dir, "grove.db"),
    outputDir: join(dir, "export"),
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readJsonl(path: string): Promise<readonly Record<string, unknown>[]> {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

import { Database } from "bun:sqlite";

export interface DiagnosticEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface TableManifestEntry {
  readonly present: boolean;
  readonly rowCount: number;
  readonly exportedPath?: string | undefined;
  readonly warning?: string | undefined;
}

export interface SqliteExportManifest {
  readonly tables: Readonly<Record<string, TableManifestEntry>>;
}

export interface SqliteExportOptions {
  readonly recentContributionLimit: number;
}

export interface SqliteExportResult {
  readonly manifest: SqliteExportManifest;
  readonly entries: readonly DiagnosticEntry[];
}

const CONTRIBUTIONS_TABLE = "contributions";
const CONTRIBUTIONS_RECENT_PATH = "db/contributions-recent.jsonl";
const TABLE_MANIFEST_PATH = "db/table-manifest.json";

const TABLE_EXPORTS: Readonly<Record<string, readonly string[] | "*">> = {
  sessions: "*",
  claims: "*",
  handoffs: "*",
  outcomes: "*",
  bounties: "*",
  rewards: "*",
  work_blocks: "*",
  timeline_events: "*",
  timeline_cursors: "*",
  workspaces: "*",
  idempotency_keys: ["cache_key", "status", "stored_at"],
  project_settings: "*",
};

const TABLE_PATHS: Readonly<Record<string, string>> = {
  sessions: "db/sessions.json",
  claims: "db/claims.json",
  handoffs: "db/handoffs.json",
  outcomes: "db/outcomes.json",
  bounties: "db/bounties.json",
  rewards: "db/rewards.json",
  work_blocks: "db/work-blocks.json",
  timeline_events: "db/timeline-events.json",
  timeline_cursors: "db/timeline-cursors.json",
  workspaces: "db/workspaces.json",
  idempotency_keys: "db/idempotency.json",
  project_settings: "config/grove-settings.json",
};

interface CountRow {
  readonly count: number;
}

interface ContributionManifestRow {
  readonly manifest_json: string;
}

interface ContributionExport {
  readonly entry: DiagnosticEntry;
  readonly manifest: TableManifestEntry;
}

export function exportSqliteSummaries(
  dbPath: string,
  options: SqliteExportOptions,
): SqliteExportResult {
  const db = new Database(dbPath, { readonly: true });
  const entries: DiagnosticEntry[] = [];

  try {
    const contributions = exportRecentContributions(db, options.recentContributionLimit);
    entries.push(contributions.entry);

    const tableManifest: Record<string, TableManifestEntry> = {
      contributions: contributions.manifest,
    };

    for (const [tableName, columns] of Object.entries(TABLE_EXPORTS)) {
      const present = tableExists(db, tableName);
      if (!present) {
        tableManifest[tableName] = {
          present: false,
          rowCount: 0,
          warning: "Table not present in SQLite database",
        };
        continue;
      }

      const exportedPath = TABLE_PATHS[tableName];
      const rowCountResult = safeCountRows(db, tableName);
      if (!rowCountResult.ok) {
        tableManifest[tableName] = {
          present: true,
          rowCount: 0,
          warning: rowCountResult.warning,
        };
        continue;
      }

      const rowsResult = safeExportTableRows(db, tableName, columns);
      if (!rowsResult.ok) {
        tableManifest[tableName] = {
          present: true,
          rowCount: rowCountResult.rowCount,
          warning: rowsResult.warning,
        };
        continue;
      }

      tableManifest[tableName] = {
        present: true,
        rowCount: rowCountResult.rowCount,
        ...(exportedPath !== undefined ? { exportedPath } : {}),
      };

      if (exportedPath !== undefined) {
        entries.push(makeEntry(exportedPath, `${JSON.stringify(rowsResult.rows, null, 2)}\n`));
      }
    }

    const manifest: SqliteExportManifest = {
      tables: tableManifest,
    };

    entries.push(makeEntry(TABLE_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`));

    return { manifest, entries };
  } finally {
    db.close();
  }
}

function exportRecentContributions(
  db: Database,
  recentContributionLimit: number,
): ContributionExport {
  const missingManifest: TableManifestEntry = {
    present: false,
    rowCount: 0,
    exportedPath: CONTRIBUTIONS_RECENT_PATH,
    warning: "Table not present in SQLite database",
  };

  if (!tableExists(db, CONTRIBUTIONS_TABLE)) {
    return {
      entry: makeEntry(CONTRIBUTIONS_RECENT_PATH, ""),
      manifest: missingManifest,
    };
  }

  const rowCountResult = safeCountRows(db, CONTRIBUTIONS_TABLE);
  if (!rowCountResult.ok) {
    return {
      entry: makeEntry(CONTRIBUTIONS_RECENT_PATH, ""),
      manifest: {
        present: true,
        rowCount: 0,
        exportedPath: CONTRIBUTIONS_RECENT_PATH,
        warning: rowCountResult.warning,
      },
    };
  }

  try {
    const contributionRows = db
      .prepare(`SELECT manifest_json FROM ${CONTRIBUTIONS_TABLE} ORDER BY created_at DESC LIMIT ?`)
      .all(recentContributionLimit) as readonly ContributionManifestRow[];

    return {
      entry: makeEntry(
        CONTRIBUTIONS_RECENT_PATH,
        contributionRows.map((row) => row.manifest_json).join("\n") +
          (contributionRows.length > 0 ? "\n" : ""),
      ),
      manifest: {
        present: true,
        rowCount: rowCountResult.rowCount,
        exportedPath: CONTRIBUTIONS_RECENT_PATH,
      },
    };
  } catch (error) {
    return {
      entry: makeEntry(CONTRIBUTIONS_RECENT_PATH, ""),
      manifest: {
        present: true,
        rowCount: rowCountResult.rowCount,
        exportedPath: CONTRIBUTIONS_RECENT_PATH,
        warning: `Failed to export recent contributions: ${errorMessage(error)}`,
      },
    };
  }
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return row !== null;
}

function countRows(db: Database, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as CountRow | null;
  return row?.count ?? 0;
}

function safeCountRows(
  db: Database,
  tableName: string,
):
  | { readonly ok: true; readonly rowCount: number }
  | { readonly ok: false; readonly warning: string } {
  try {
    return {
      ok: true,
      rowCount: countRows(db, tableName),
    };
  } catch (error) {
    return {
      ok: false,
      warning: `Failed to count table '${tableName}': ${errorMessage(error)}`,
    };
  }
}

function exportTableRows(
  db: Database,
  tableName: string,
  columns: readonly string[] | "*",
): readonly Record<string, unknown>[] {
  const selectedColumns = columns === "*" ? "*" : columns.join(", ");
  return db.prepare(`SELECT ${selectedColumns} FROM ${tableName}`).all() as readonly Record<
    string,
    unknown
  >[];
}

function safeExportTableRows(
  db: Database,
  tableName: string,
  columns: readonly string[] | "*",
):
  | { readonly ok: true; readonly rows: readonly Record<string, unknown>[] }
  | { readonly ok: false; readonly warning: string } {
  try {
    return {
      ok: true,
      rows: exportTableRows(db, tableName, columns),
    };
  } catch (error) {
    return {
      ok: false,
      warning: `Failed to export table '${tableName}': ${errorMessage(error)}`,
    };
  }
}

function makeEntry(relativePath: string, content: string): DiagnosticEntry {
  return {
    path: relativePath,
    bytes: new TextEncoder().encode(content),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

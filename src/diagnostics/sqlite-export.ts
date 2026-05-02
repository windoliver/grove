import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DiagnosticEntry {
  readonly path: string;
  readonly bytes: number;
}

export interface TableManifestEntry {
  readonly present: boolean;
  readonly rowCount: number;
  readonly exportedPath?: string;
  readonly warnings?: readonly string[];
}

export interface SqliteExportManifest {
  readonly contributions: TableManifestEntry;
  readonly tables: Readonly<Record<string, TableManifestEntry>>;
}

export interface SqliteExportOptions {
  readonly outputDir: string;
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

export function exportSqliteSummaries(
  dbPath: string,
  options: SqliteExportOptions,
): SqliteExportResult {
  const db = new Database(dbPath, { readonly: true });
  const entries: DiagnosticEntry[] = [];

  try {
    const contributionCount = countRows(db, CONTRIBUTIONS_TABLE);
    const contributionRows = db
      .prepare(`SELECT manifest_json FROM ${CONTRIBUTIONS_TABLE} ORDER BY created_at DESC LIMIT ?`)
      .all(options.recentContributionLimit) as readonly ContributionManifestRow[];

    entries.push(
      writeEntry(
        options.outputDir,
        CONTRIBUTIONS_RECENT_PATH,
        contributionRows.map((row) => row.manifest_json).join("\n") +
          (contributionRows.length > 0 ? "\n" : ""),
      ),
    );

    const tableManifest: Record<string, TableManifestEntry> = {};
    for (const [tableName, columns] of Object.entries(TABLE_EXPORTS)) {
      const present = tableExists(db, tableName);
      if (!present) {
        tableManifest[tableName] = {
          present: false,
          rowCount: 0,
          warnings: ["Table not present in SQLite database"],
        };
        continue;
      }

      const exportedPath = TABLE_PATHS[tableName];
      const rows = exportTableRows(db, tableName, columns);
      tableManifest[tableName] = {
        present: true,
        rowCount: countRows(db, tableName),
        ...(exportedPath !== undefined ? { exportedPath } : {}),
      };

      if (exportedPath !== undefined) {
        entries.push(
          writeEntry(options.outputDir, exportedPath, `${JSON.stringify(rows, null, 2)}\n`),
        );
      }
    }

    const manifest: SqliteExportManifest = {
      contributions: {
        present: true,
        rowCount: contributionCount,
        exportedPath: CONTRIBUTIONS_RECENT_PATH,
      },
      tables: tableManifest,
    };

    entries.push(
      writeEntry(options.outputDir, TABLE_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`),
    );

    return { manifest, entries };
  } finally {
    db.close();
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

function writeEntry(outputDir: string, relativePath: string, content: string): DiagnosticEntry {
  const outputPath = join(outputDir, relativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, "utf8");
  return {
    path: relativePath,
    bytes: new TextEncoder().encode(content).byteLength,
  };
}

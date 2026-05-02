import { type Dirent, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { arch, cpus, freemem, homedir, platform, release, totalmem } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { isTextEntryPath, redactText, type ScrubMode } from "./redaction.js";
import {
  type DiagnosticEntry,
  exportSqliteSummaries,
  type SqliteExportManifest,
} from "./sqlite-export.js";
import { collectSystemSnapshots, type ProbeRunner } from "./system.js";

export interface BuildDiagnosticsEntriesOptions {
  readonly projectRoot: string;
  readonly groveDir: string;
  readonly packageVersion: string;
  readonly generatedAt: string;
  readonly scrubMode: ScrubMode;
  readonly excludeDb: boolean;
  readonly slot?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string | undefined;
  readonly systemRunner?: ProbeRunner | undefined;
}

export interface DiagnosticsEntriesResult {
  readonly entries: readonly DiagnosticEntry[];
  readonly warnings: readonly string[];
  readonly sqliteManifest: SqliteExportManifest;
}

interface LogManifest {
  readonly included: readonly string[];
  readonly skipped: readonly string[];
  readonly missing: readonly string[];
  readonly warnings: readonly string[];
}

const SECRET_ENV_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)/i;
const ALLOWED_ENV_KEYS = new Set([
  "PATH",
  "SHELL",
  "TERM",
  "HOME",
  "USER",
  "TMPDIR",
  "CI",
  "GITHUB_ACTIONS",
]);

export async function buildDiagnosticsEntries(
  options: BuildDiagnosticsEntriesOptions,
): Promise<DiagnosticsEntriesResult> {
  const warnings: string[] = [];
  const entries: DiagnosticEntry[] = [];
  const projectRoot = resolve(options.projectRoot);
  const groveDir = resolve(options.groveDir);
  const effectiveHomeDir = options.homeDir ?? homedir();
  const dbPath = join(groveDir, "grove.db");

  if (existsSync(join(projectRoot, "GROVE.md"))) {
    entries.push(
      textEntry("config/GROVE.md", await readFile(join(projectRoot, "GROVE.md"), "utf8")),
    );
  } else {
    warnings.push("GROVE.md not found; config/GROVE.md omitted");
  }

  entries.push(jsonEntry("config/env.redacted.json", allowedEnv(options.env)));

  const logResult = await collectLogEntries(groveDir, options.slot);
  entries.push(...logResult.entries);
  entries.push(jsonEntry("logs/manifest.json", logResult.manifest));

  let sqliteManifest: SqliteExportManifest;
  if (existsSync(dbPath)) {
    const sqliteResult = exportSqliteSummaries(dbPath, { recentContributionLimit: 500 });
    sqliteManifest = sqliteResult.manifest;
    entries.push(...sqliteResult.entries);
    if (!options.excludeDb) {
      entries.push({
        path: "db/grove.db",
        bytes: await readFile(dbPath),
      });
    }
  } else {
    warnings.push("SQLite database not found; database entries omitted");
    sqliteManifest = emptySqliteManifest();
  }

  entries.push(jsonEntry("operator-primitives/availability.json", operatorAvailability()));
  entries.push(
    ...(await collectSystemSnapshots({
      projectRoot,
      groveDir,
      runner: options.systemRunner,
    })),
  );
  entries.push(
    jsonEntry("meta.json", {
      packageVersion: options.packageVersion,
      generatedAt: options.generatedAt,
      project: {
        root: projectRoot,
        name: basename(projectRoot),
        groveDir,
        groveDirRelative: relative(projectRoot, groveDir),
      },
      scrubMode: options.scrubMode,
      excludeDb: options.excludeDb,
      slot: options.slot ?? null,
      os: {
        platform: platform(),
        release: release(),
        arch: arch(),
        cpus: cpus().map((cpu) => ({
          model: cpu.model,
          speed: cpu.speed,
        })),
        memory: {
          freeBytes: freemem(),
          totalBytes: totalmem(),
        },
      },
      warnings,
    }),
  );
  entries.push(textEntry("README.md", buildReadme(options.scrubMode, options.excludeDb)));

  const secretEnvKeys = Object.keys(options.env).filter((key) => SECRET_ENV_KEY_PATTERN.test(key));
  const redactedEntries = entries.map((entry) =>
    redactEntry(entry, options.scrubMode, effectiveHomeDir, secretEnvKeys),
  );

  return {
    entries: [...redactedEntries].sort(compareEntryPaths),
    warnings,
    sqliteManifest,
  };
}

function jsonEntry(path: string, value: unknown): DiagnosticEntry {
  return textEntry(path, `${JSON.stringify(value, null, 2)}\n`);
}

function textEntry(path: string, value: string): DiagnosticEntry {
  return {
    path,
    bytes: new TextEncoder().encode(value),
  };
}

async function collectLogEntries(
  groveDir: string,
  slot: string | undefined,
): Promise<{ readonly entries: readonly DiagnosticEntry[]; readonly manifest: unknown }> {
  const entries: DiagnosticEntry[] = [];
  const included: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];
  const agentLogsDir = join(groveDir, "agent-logs");

  if (!existsSync(agentLogsDir)) {
    missing.push("logs/agent-logs");
    return {
      entries,
      manifest: { included, skipped, missing, warnings } satisfies LogManifest,
    };
  }

  if (slot !== undefined) {
    await recordSkippedSlots(agentLogsDir, slot, skipped, warnings);
    const slotDir = join(agentLogsDir, slot);
    if (!existsSync(slotDir)) {
      missing.push(`logs/agent-logs/${slot}`);
      return {
        entries,
        manifest: { included, skipped, missing, warnings } satisfies LogManifest,
      };
    }
    await collectFiles(slotDir, agentLogsDir, entries, included, warnings);
  } else {
    await collectFiles(agentLogsDir, agentLogsDir, entries, included, warnings);
  }

  return {
    entries,
    manifest: { included, skipped, missing, warnings } satisfies LogManifest,
  };
}

function operatorAvailability(): readonly Record<string, unknown>[] {
  return [
    availability(
      "ask-user",
      "not-exported",
      "Prompt state is not persisted in diagnostics bundles.",
    ),
    availability("agents", "not-exported", "Agent registry snapshots are not yet persisted."),
    availability("task-inbox", "not-exported", "Task inbox data is not yet persisted."),
    availability("sessions", "conditional", "Exported when the SQLite sessions table is present."),
    availability(
      "snapshots-checkpoints",
      "not-exported",
      "Checkpoint artifacts are not yet persisted.",
    ),
    availability(
      "worktree-mappings",
      "conditional",
      "Exported when the SQLite workspaces table is present.",
    ),
    availability(
      "transcript-pointers",
      "not-exported",
      "Transcript pointers are not yet persisted.",
    ),
    availability(
      "stdout-stderr-captures",
      "not-exported",
      "Process output capture is not yet persisted.",
    ),
    availability(
      "approvals-human-decisions",
      "not-exported",
      "Approval and human decision records are not yet persisted.",
    ),
  ];
}

function buildReadme(scrubMode: ScrubMode, excludeDb: boolean): string {
  const dbLine = excludeDb
    ? "The raw SQLite database is excluded; JSON/JSONL summaries are included when available."
    : "The raw SQLite database is included as db/grove.db, alongside JSON/JSONL summaries.";
  return `# Grove Diagnostics Bundle

This bundle contains Grove configuration, selected environment metadata, agent logs, SQLite summaries, operator primitive availability, and system snapshots.

Scrub mode: ${scrubMode}

${dbLine}

Text entries are redacted according to the selected scrub mode. Binary database bytes are never rewritten.
`;
}

function allowedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (value === undefined || !isAllowedEnvKey(key)) {
      continue;
    }
    allowed[key] = SECRET_ENV_KEY_PATTERN.test(key) ? "<redacted>" : value;
  }
  return allowed;
}

function isAllowedEnvKey(key: string): boolean {
  return key.startsWith("GROVE_") || key.startsWith("BUN_") || ALLOWED_ENV_KEYS.has(key);
}

function emptySqliteManifest(): SqliteExportManifest {
  return {
    tables: {
      contributions: {
        present: false,
        rowCount: 0,
        exportedPath: "db/contributions-recent.jsonl",
        warning: "SQLite database not found",
      },
    },
  };
}

async function recordSkippedSlots(
  agentLogsDir: string,
  slot: string,
  skipped: string[],
  warnings: string[],
): Promise<void> {
  try {
    const children = await readdir(agentLogsDir, { withFileTypes: true });
    for (const child of children) {
      if (child.name !== slot) {
        skipped.push(`logs/agent-logs/${child.name}`);
      }
    }
  } catch (error) {
    warnings.push(`Failed to list log slots: ${errorMessage(error)}`);
  }
}

async function collectFiles(
  currentDir: string,
  rootDir: string,
  entries: DiagnosticEntry[],
  included: string[],
  warnings: string[],
): Promise<void> {
  let children: Dirent[];
  try {
    children = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    warnings.push(
      `Failed to list logs under ${relative(rootDir, currentDir)}: ${errorMessage(error)}`,
    );
    return;
  }

  for (const child of children) {
    const childPath = join(currentDir, child.name);
    if (child.isDirectory()) {
      await collectFiles(childPath, rootDir, entries, included, warnings);
      continue;
    }
    if (!child.isFile()) {
      continue;
    }

    try {
      const childStat = await stat(childPath);
      if (!childStat.isFile()) {
        continue;
      }
      const entryPath = `logs/agent-logs/${relative(rootDir, childPath).replaceAll("\\", "/")}`;
      entries.push({
        path: entryPath,
        bytes: await readFile(childPath),
      });
      included.push(entryPath);
    } catch (error) {
      warnings.push(`Failed to read log ${relative(rootDir, childPath)}: ${errorMessage(error)}`);
    }
  }
}

function availability(name: string, status: string, note: string): Record<string, unknown> {
  return {
    primitive: name,
    status,
    note,
  };
}

function redactEntry(
  entry: DiagnosticEntry,
  scrubMode: ScrubMode,
  homeDir: string,
  secretEnvKeys: readonly string[],
): DiagnosticEntry {
  if (entry.path === "db/grove.db" || !isTextEntryPath(entry.path)) {
    return entry;
  }
  return textEntry(
    entry.path,
    redactText(new TextDecoder().decode(entry.bytes), {
      mode: scrubMode,
      homeDir,
      secretEnvKeys,
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareEntryPaths(left: DiagnosticEntry, right: DiagnosticEntry): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

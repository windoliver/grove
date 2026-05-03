import { type Dirent, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { arch, cpus, freemem, homedir, platform, release, totalmem } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
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

interface OperatorAvailability {
  readonly [key: string]: unknown;
  readonly name: string;
  readonly status: "partial" | "unavailable";
  readonly sources: readonly string[];
  readonly notes: string;
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

  const groveConfigPath = join(projectRoot, "GROVE.md");
  if (existsSync(groveConfigPath)) {
    try {
      entries.push(textEntry("config/GROVE.md", await readFile(groveConfigPath, "utf8")));
    } catch (error) {
      warnings.push(`Failed to read GROVE.md: ${errorMessage(error)}`);
    }
  } else {
    warnings.push("GROVE.md not found; config/GROVE.md omitted");
  }

  entries.push(jsonEntry("config/env.redacted.json", allowedEnv(options.env)));

  const logResult = await collectLogEntries(groveDir, options.slot);
  entries.push(...logResult.entries);
  entries.push(jsonEntry("logs/manifest.json", logResult.manifest));

  let sqliteManifest: SqliteExportManifest;
  if (existsSync(dbPath)) {
    try {
      const sqliteResult = exportSqliteSummaries(dbPath, { recentContributionLimit: 500 });
      sqliteManifest = sqliteResult.manifest;
      entries.push(...sqliteResult.entries);
    } catch (error) {
      const warning = `Failed to export SQLite summaries: ${errorMessage(error)}`;
      warnings.push(warning);
      sqliteManifest = failedSqliteManifest(warning);
    }
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
  const agentLogsDir = resolve(groveDir, "agent-logs");

  if (!existsSync(agentLogsDir)) {
    missing.push("logs/agent-logs");
    return {
      entries,
      manifest: logManifest(included, skipped, missing, warnings),
    };
  }

  if (slot !== undefined) {
    await recordSkippedSlots(agentLogsDir, slot, skipped, warnings);
    const slotValidation = validateLogSlot(slot);
    if (!slotValidation.valid) {
      missing.push(`logs/agent-logs/${slot}`);
      warnings.push(`Invalid log slot '${slot}': ${slotValidation.reason}`);
      return {
        entries,
        manifest: logManifest(included, skipped, missing, warnings),
      };
    }
    const slotDir = resolve(agentLogsDir, slot);
    if (!isWithinDirectory(agentLogsDir, slotDir)) {
      missing.push(`logs/agent-logs/${slot}`);
      warnings.push(`Invalid log slot '${slot}': path traversal is not allowed`);
      return {
        entries,
        manifest: logManifest(included, skipped, missing, warnings),
      };
    }
    if (!existsSync(slotDir)) {
      missing.push(`logs/agent-logs/${slot}`);
      return {
        entries,
        manifest: logManifest(included, skipped, missing, warnings),
      };
    }
    await collectFiles(slotDir, agentLogsDir, entries, included, warnings);
  } else {
    await collectFiles(agentLogsDir, agentLogsDir, entries, included, warnings);
  }

  return {
    entries,
    manifest: logManifest(included, skipped, missing, warnings),
  };
}

function operatorAvailability(): readonly Record<string, unknown>[] {
  return [
    availability(
      "session_timeline",
      "partial",
      ["sessions", "session_contributions", "agent-logs", "contribution timestamps"],
      "Session timeline can be assembled from persisted session and contribution records plus agent logs when present.",
    ),
    availability("work_blocks", "unavailable", [], "Pending #375."),
    availability(
      "run_health",
      "partial",
      [
        "session status",
        "stop reasons",
        "claims",
        "handoffs",
        "watch/backpressure metadata when available",
      ],
      "Run health can be inferred from persisted coordination records; richer watch and backpressure metadata is included only if future code writes it.",
    ),
    availability("autonomy_profile", "unavailable", [], "Pending #378."),
    availability(
      "permission_decisions",
      "partial",
      ["ACP trace lines", "typed permission request log messages when present"],
      "Permission decisions are represented only when trace or typed request log lines exist in included logs.",
    ),
    availability("agent_tasks", "unavailable", [], "Pending #297 and #379."),
    availability(
      "watch_compaction",
      "partial",
      ["persisted config", "local watch metrics snapshots if future code writes them"],
      "Watch compaction diagnostics are limited to persisted configuration and optional future metrics snapshots.",
    ),
    availability(
      "degraded_stop_conditions",
      "partial",
      ["session stop_reason", "contract stop conditions", "contribution warnings"],
      "Degraded stop condition signals can be inferred from persisted session, contract, and contribution warning data.",
    ),
    availability(
      "bounded_queue_backpressure",
      "partial",
      ["log lines", "persisted channel stats if future code writes them"],
      "Backpressure data is limited to included log lines and optional future persisted channel statistics.",
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

function failedSqliteManifest(warning: string): SqliteExportManifest {
  return {
    tables: {
      contributions: {
        present: false,
        rowCount: 0,
        exportedPath: "db/contributions-recent.jsonl",
        warning,
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
    const children = sortDirents(await readdir(agentLogsDir, { withFileTypes: true }));
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
  let children: readonly Dirent[];
  try {
    children = sortDirents(await readdir(currentDir, { withFileTypes: true }));
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

function availability(
  name: string,
  status: "partial" | "unavailable",
  sources: readonly string[],
  notes: string,
): OperatorAvailability {
  return {
    name,
    status,
    sources,
    notes,
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

function logManifest(
  included: readonly string[],
  skipped: readonly string[],
  missing: readonly string[],
  warnings: readonly string[],
): LogManifest {
  return {
    included: sortStrings(included),
    skipped: sortStrings(skipped),
    missing: sortStrings(missing),
    warnings: sortStrings(warnings),
  };
}

function sortDirents(dirents: readonly Dirent[]): readonly Dirent[] {
  return [...dirents].sort((left, right) => left.name.localeCompare(right.name));
}

function sortStrings(values: readonly string[]): readonly string[] {
  return [...values].sort();
}

function validateLogSlot(
  slot: string,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
  if (slot.trim().length === 0) {
    return {
      valid: false,
      reason: "slot must not be empty",
    };
  }
  if (slot === ".." || slot.includes("../") || slot.includes("..\\") || slot.endsWith("/..")) {
    return {
      valid: false,
      reason: "path traversal is not allowed",
    };
  }
  if (slot === "." || slot.includes("/") || slot.includes("\\")) {
    return {
      valid: false,
      reason: "slot must be a single path segment",
    };
  }
  return { valid: true };
}

function isWithinDirectory(parentDir: string, candidatePath: string): boolean {
  const relativePath = relative(parentDir, candidatePath);
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

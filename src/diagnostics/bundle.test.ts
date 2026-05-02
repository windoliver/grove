import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeContribution } from "../core/test-helpers.js";
import { initSqliteDb, SqliteContributionStore } from "../local/sqlite-store.js";
import { buildDiagnosticsEntries } from "./bundle.js";
import type { DiagnosticEntry } from "./sqlite-export.js";
import type { ProbeRunner } from "./system.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("buildDiagnosticsEntries", () => {
  test("assembles redacted diagnostics entries without raw database when excluded", async () => {
    const ctx = await createBundleContext();

    const result = await buildDiagnosticsEntries({
      projectRoot: ctx.projectRoot,
      groveDir: ctx.groveDir,
      packageVersion: "1.2.3-test",
      generatedAt: "2026-05-02T12:34:56.000Z",
      scrubMode: "standard",
      excludeDb: true,
      env: {
        GROVE_AGENT_ID: "agent-1",
        HOME: "/Users/tafeng",
      },
      homeDir: "/Users/tafeng",
      systemRunner: fakeSystemRunner,
    });

    const paths = result.entries.map((entry) => entry.path);
    expect(paths).toContain("meta.json");
    expect(paths).toContain("README.md");
    expect(paths).toContain("config/GROVE.md");
    expect(paths).toContain("config/env.redacted.json");
    expect(paths).toContain("logs/manifest.json");
    expect(paths).toContain("logs/agent-logs/sess-1/coder.jsonl");
    expect(paths).toContain("db/contributions-recent.jsonl");
    expect(paths).toContain("operator-primitives/availability.json");
    expect(paths).toContain("system/process-tree.txt");
    expect(paths).not.toContain("db/grove.db");
    expect(paths).toEqual([...paths].sort());

    const logText = decodeEntry(getEntry(result.entries, "logs/agent-logs/sess-1/coder.jsonl"));
    expect(logText).toContain("<redacted>");
    expect(logText).not.toContain("user@example.com");

    const env = readJson<Record<string, string>>(
      getEntry(result.entries, "config/env.redacted.json"),
    );
    expect(env).toEqual({
      GROVE_AGENT_ID: "agent-1",
      HOME: "~",
    });

    const contributionText = decodeEntry(getEntry(result.entries, "db/contributions-recent.jsonl"));
    expect(contributionText).toContain("diagnostic contribution");

    const availability = readJson<readonly OperatorAvailabilityEntry[]>(
      getEntry(result.entries, "operator-primitives/availability.json"),
    );
    expect(availability).toHaveLength(9);
    expect(availability.map((entry) => entry.name)).toEqual([
      "session_timeline",
      "work_blocks",
      "run_health",
      "autonomy_profile",
      "permission_decisions",
      "agent_tasks",
      "watch_compaction",
      "degraded_stop_conditions",
      "bounded_queue_backpressure",
    ]);
    expect(getAvailability(availability, "session_timeline")).toMatchObject({
      status: "partial",
      sources: ["sessions", "session_contributions", "agent-logs", "contribution timestamps"],
    });
    expect(getAvailability(availability, "work_blocks")).toMatchObject({
      status: "unavailable",
      sources: [],
      notes: "Pending #375.",
    });
    expect(getAvailability(availability, "run_health")).toMatchObject({
      status: "partial",
      sources: [
        "session status",
        "stop reasons",
        "claims",
        "handoffs",
        "watch/backpressure metadata when available",
      ],
    });
    expect(getAvailability(availability, "autonomy_profile")).toMatchObject({
      status: "unavailable",
      sources: [],
      notes: "Pending #378.",
    });
    expect(getAvailability(availability, "permission_decisions")).toMatchObject({
      status: "partial",
      sources: ["ACP trace lines", "typed permission request log messages when present"],
    });
    expect(getAvailability(availability, "agent_tasks")).toMatchObject({
      status: "unavailable",
      sources: [],
      notes: "Pending #297 and #379.",
    });
    expect(getAvailability(availability, "watch_compaction")).toMatchObject({
      status: "partial",
      sources: ["persisted config", "local watch metrics snapshots if future code writes them"],
    });
    expect(getAvailability(availability, "degraded_stop_conditions")).toMatchObject({
      status: "partial",
      sources: ["session stop_reason", "contract stop conditions", "contribution warnings"],
    });
    expect(getAvailability(availability, "bounded_queue_backpressure")).toMatchObject({
      status: "partial",
      sources: ["log lines", "persisted channel stats if future code writes them"],
    });
    for (const entry of availability) {
      expect(Array.isArray(entry.sources)).toBe(true);
      expect(typeof entry.notes).toBe("string");
    }
  });

  test("includes raw database bytes when database export is allowed", async () => {
    const ctx = await createBundleContext();

    const result = await buildDiagnosticsEntries({
      projectRoot: ctx.projectRoot,
      groveDir: ctx.groveDir,
      packageVersion: "1.2.3-test",
      generatedAt: "2026-05-02T12:34:56.000Z",
      scrubMode: "standard",
      excludeDb: false,
      env: {
        GROVE_AGENT_ID: "agent-1",
        HOME: "/Users/tafeng",
      },
      homeDir: "/Users/tafeng",
      systemRunner: fakeSystemRunner,
    });

    expect(result.entries.map((entry) => entry.path)).toContain("db/grove.db");
    expect(getEntry(result.entries, "db/grove.db").bytes.length).toBeGreaterThan(0);
  });

  test("rejects traversal slots without reading outside agent logs", async () => {
    const ctx = await createBundleContext();
    await writeFile(join(ctx.projectRoot, "project-secret.log"), "outside agent logs\n", "utf8");

    const result = await buildDiagnosticsEntries({
      projectRoot: ctx.projectRoot,
      groveDir: ctx.groveDir,
      packageVersion: "1.2.3-test",
      generatedAt: "2026-05-02T12:34:56.000Z",
      scrubMode: "standard",
      excludeDb: true,
      slot: "../..",
      env: {},
      homeDir: "/Users/tafeng",
      systemRunner: fakeSystemRunner,
    });

    const paths = result.entries.map((entry) => entry.path);
    expect(paths).not.toContain("logs/agent-logs/../../project-secret.log");
    expect(paths.every((path) => !path.includes(".."))).toBe(true);
    expect(paths).not.toContain("logs/agent-logs/sess-1/coder.jsonl");

    const manifest = readJson<LogManifest>(getEntry(result.entries, "logs/manifest.json"));
    expect(manifest.included).toEqual([]);
    expect(manifest.skipped).toEqual(["logs/agent-logs/sess-1"]);
    expect(manifest.missing).toEqual(["logs/agent-logs/../.."]);
    expect(manifest.warnings).toEqual(["Invalid log slot '../..': path traversal is not allowed"]);
  });

  test("rejects normalized root slots without including all slot logs", async () => {
    const ctx = await createBundleContext({ initializeDb: false, includeDefaultLog: false });
    await mkdir(join(ctx.groveDir, "agent-logs", "slot-a"), { recursive: true });
    await mkdir(join(ctx.groveDir, "agent-logs", "slot-b"), { recursive: true });
    await writeFile(join(ctx.groveDir, "agent-logs", "slot-a", "a.log"), "a\n", "utf8");
    await writeFile(join(ctx.groveDir, "agent-logs", "slot-b", "b.log"), "b\n", "utf8");

    const result = await buildDiagnosticsEntries({
      projectRoot: ctx.projectRoot,
      groveDir: ctx.groveDir,
      packageVersion: "1.2.3-test",
      generatedAt: "2026-05-02T12:34:56.000Z",
      scrubMode: "standard",
      excludeDb: true,
      slot: ".",
      env: {},
      homeDir: "/Users/tafeng",
      systemRunner: fakeSystemRunner,
    });

    const paths = result.entries.map((entry) => entry.path);
    expect(paths).not.toContain("logs/agent-logs/slot-a/a.log");
    expect(paths).not.toContain("logs/agent-logs/slot-b/b.log");

    const manifest = readJson<LogManifest>(getEntry(result.entries, "logs/manifest.json"));
    expect(manifest.included).toEqual([]);
    expect(manifest.skipped).toEqual(["logs/agent-logs/slot-a", "logs/agent-logs/slot-b"]);
    expect(manifest.missing).toEqual(["logs/agent-logs/."]);
    expect(manifest.warnings).toEqual(["Invalid log slot '.': slot must be a single path segment"]);
  });

  test("continues with warning when sqlite database is corrupt and raw db is excluded", async () => {
    const ctx = await createBundleContext({ initializeDb: false });
    await writeFile(join(ctx.groveDir, "grove.db"), "not sqlite", "utf8");

    const result = await buildDiagnosticsEntries({
      projectRoot: ctx.projectRoot,
      groveDir: ctx.groveDir,
      packageVersion: "1.2.3-test",
      generatedAt: "2026-05-02T12:34:56.000Z",
      scrubMode: "standard",
      excludeDb: true,
      env: {},
      homeDir: "/Users/tafeng",
      systemRunner: fakeSystemRunner,
    });

    expect(result.entries.map((entry) => entry.path)).not.toContain("db/grove.db");
    expect(result.warnings.some((warning) => warning.includes("Failed to export SQLite"))).toBe(
      true,
    );
    expect(result.sqliteManifest.tables.contributions).toMatchObject({
      present: false,
      rowCount: 0,
      exportedPath: "db/contributions-recent.jsonl",
    });
    expect(result.sqliteManifest.tables.contributions?.warning).toContain(
      "Failed to export SQLite",
    );
  });

  test("sorts log traversal and manifest arrays deterministically", async () => {
    const ctx = await createBundleContext({ initializeDb: false, includeDefaultLog: false });
    await mkdir(join(ctx.groveDir, "agent-logs", "z-slot"), { recursive: true });
    await mkdir(join(ctx.groveDir, "agent-logs", "a-slot"), { recursive: true });
    await writeFile(join(ctx.groveDir, "agent-logs", "z-slot", "z.log"), "z\n", "utf8");
    await writeFile(join(ctx.groveDir, "agent-logs", "z-slot", "a.log"), "a\n", "utf8");
    await writeFile(join(ctx.groveDir, "agent-logs", "a-slot", "b.log"), "b\n", "utf8");

    const result = await buildDiagnosticsEntries({
      projectRoot: ctx.projectRoot,
      groveDir: ctx.groveDir,
      packageVersion: "1.2.3-test",
      generatedAt: "2026-05-02T12:34:56.000Z",
      scrubMode: "standard",
      excludeDb: true,
      slot: "z-slot",
      env: {},
      homeDir: "/Users/tafeng",
      systemRunner: fakeSystemRunner,
    });

    const manifest = readJson<LogManifest>(getEntry(result.entries, "logs/manifest.json"));
    expect(manifest.included).toEqual([
      "logs/agent-logs/z-slot/a.log",
      "logs/agent-logs/z-slot/z.log",
    ]);
    expect(manifest.skipped).toEqual(["logs/agent-logs/a-slot"]);
    expect(manifest.missing).toEqual([]);
    expect(manifest.warnings).toEqual([]);
  });
});

interface BundleContext {
  readonly projectRoot: string;
  readonly groveDir: string;
}

interface OperatorAvailabilityEntry {
  readonly name: string;
  readonly status: string;
  readonly sources: readonly string[];
  readonly notes: string;
}

interface LogManifest {
  readonly included: readonly string[];
  readonly skipped: readonly string[];
  readonly missing: readonly string[];
  readonly warnings: readonly string[];
}

interface BundleContextOptions {
  readonly initializeDb?: boolean | undefined;
  readonly includeDefaultLog?: boolean | undefined;
}

async function createBundleContext(options: BundleContextOptions = {}): Promise<BundleContext> {
  const projectRoot = await mkdtemp(join(tmpdir(), "grove-bundle-"));
  tempDirs.push(projectRoot);
  const groveDir = join(projectRoot, ".grove");
  await mkdir(join(groveDir, "agent-logs"), { recursive: true });
  if (options.includeDefaultLog !== false) {
    await mkdir(join(groveDir, "agent-logs", "sess-1"), { recursive: true });
    await writeFile(
      join(groveDir, "agent-logs", "sess-1", "coder.jsonl"),
      `${JSON.stringify({ level: "info", msg: "contact user@example.com" })}\n`,
      "utf8",
    );
  }
  await writeFile(join(projectRoot, "GROVE.md"), "# Project Grove\n", "utf8");

  if (options.initializeDb !== false) {
    const db = initSqliteDb(join(groveDir, "grove.db"));
    try {
      const store = new SqliteContributionStore(db);
      await store.put(
        makeContribution({
          summary: "diagnostic contribution",
          createdAt: "2026-05-02T00:00:00Z",
        }),
      );
    } finally {
      db.close();
    }
  }

  return {
    projectRoot,
    groveDir,
  };
}

const fakeSystemRunner: ProbeRunner = async (command) => ({
  ok: true,
  stdout: `snapshot for ${command}\n`,
  stderr: "",
});

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

function getAvailability(
  entries: readonly OperatorAvailabilityEntry[],
  name: string,
): OperatorAvailabilityEntry {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`Expected operator availability entry for ${name}`);
  }
  return entry;
}

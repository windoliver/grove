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

async function createBundleContext(): Promise<BundleContext> {
  const projectRoot = await mkdtemp(join(tmpdir(), "grove-bundle-"));
  tempDirs.push(projectRoot);
  const groveDir = join(projectRoot, ".grove");
  await mkdir(join(groveDir, "agent-logs", "sess-1"), { recursive: true });
  await writeFile(
    join(groveDir, "agent-logs", "sess-1", "coder.jsonl"),
    `${JSON.stringify({ level: "info", msg: "contact user@example.com" })}\n`,
    "utf8",
  );
  await writeFile(join(projectRoot, "GROVE.md"), "# Project Grove\n", "utf8");

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

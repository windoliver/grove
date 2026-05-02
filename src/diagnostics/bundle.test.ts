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

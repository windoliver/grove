/**
 * Tests for grove log command.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultFrontierCalculator } from "../../core/frontier.js";
import type { OutcomeStore } from "../../core/outcome.js";
import { makeContribution } from "../../core/test-helpers.js";
import { FsCas } from "../../local/fs-cas.js";
import { SqliteOutcomeStore } from "../../local/sqlite-outcome-store.js";
import { initSqliteDb, SqliteContributionStore } from "../../local/sqlite-store.js";
import type { CliDeps } from "../context.js";
import { parseLogArgs, runLog } from "./log.js";

let tmpDir: string;
let deps: CliDeps;
let outcomeStore: OutcomeStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grove-log-test-"));
  const db = initSqliteDb(join(tmpDir, "grove.db"));
  const store = new SqliteContributionStore(db);
  const cas = new FsCas(join(tmpDir, "cas"));
  const frontier = new DefaultFrontierCalculator(store);
  outcomeStore = new SqliteOutcomeStore(db);
  deps = {
    store,
    frontier,
    workspace: undefined as never, // not used by log
    cas,
    groveRoot: tmpDir,
    outcomeStore,
    close: () => {
      store.close();
    },
  };
});

afterEach(async () => {
  deps.close();
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseLogArgs
// ---------------------------------------------------------------------------

describe("parseLogArgs", () => {
  test("parses empty args with defaults", () => {
    const opts = parseLogArgs([]);
    expect(opts.limit).toBe(20);
    expect(opts.kind).toBeUndefined();
    expect(opts.mode).toBeUndefined();
    expect(opts.outcome).toBeUndefined();
    expect(opts.json).toBe(false);
  });

  test("parses -n flag", () => {
    const opts = parseLogArgs(["-n", "5"]);
    expect(opts.limit).toBe(5);
  });

  test("parses --kind and --mode", () => {
    const opts = parseLogArgs(["--kind", "review", "--mode", "exploration"]);
    expect(opts.kind).toBe("review");
    expect(opts.mode).toBe("exploration");
  });

  test("parses --json", () => {
    const opts = parseLogArgs(["--json"]);
    expect(opts.json).toBe(true);
  });

  test("parses --outcome flag", () => {
    const opts = parseLogArgs(["--outcome", "accepted"]);
    expect(opts.outcome).toBe("accepted");
  });

  test("rejects invalid outcome value", () => {
    expect(() => parseLogArgs(["--outcome", "unknown"])).toThrow("Invalid outcome");
  });

  test("rejects invalid limit", () => {
    expect(() => parseLogArgs(["-n", "abc"])).toThrow("Invalid limit");
    expect(() => parseLogArgs(["-n", "0"])).toThrow("Invalid limit");
    // Note: "-1" is treated by parseArgs as a separate option, not a value for -n.
    // That's a parseArgs behavior, not our validation.
    expect(() => parseLogArgs(["--n=-1"])).toThrow("Invalid limit");
  });
});

// ---------------------------------------------------------------------------
// runLog
// ---------------------------------------------------------------------------

describe("runLog", () => {
  test("outputs empty table when no contributions", async () => {
    const output: string[] = [];
    await runLog({ limit: 20, json: false }, deps, (s) => output.push(s));
    expect(output.join("\n")).toContain("(no results)");
  });

  test("lists contributions in reverse chronological order", async () => {
    const c1 = makeContribution({ summary: "First", createdAt: "2026-01-01T00:00:00Z" });
    const c2 = makeContribution({ summary: "Second", createdAt: "2026-01-02T00:00:00Z" });
    const c3 = makeContribution({ summary: "Third", createdAt: "2026-01-03T00:00:00Z" });

    await deps.store.put(c1);
    await deps.store.put(c2);
    await deps.store.put(c3);

    const output: string[] = [];
    await runLog({ limit: 20, json: false }, deps, (s) => output.push(s));

    const text = output.join("\n");
    const thirdIdx = text.indexOf("Third");
    const secondIdx = text.indexOf("Second");
    const firstIdx = text.indexOf("First");

    // Third should appear before Second, Second before First
    expect(thirdIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(firstIdx);
  });

  test("limit returns newest, not oldest (sort-before-slice)", async () => {
    const oldest = makeContribution({ summary: "oldest-item", createdAt: "2026-01-01T00:00:00Z" });
    const newest = makeContribution({ summary: "newest-item", createdAt: "2026-01-02T00:00:00Z" });

    await deps.store.put(oldest);
    await deps.store.put(newest);

    const output: string[] = [];
    await runLog({ limit: 1, json: false }, deps, (s) => output.push(s));

    const text = output.join("\n");
    // -n 1 must return the newest contribution, not the oldest
    expect(text).toContain("newest-item");
    expect(text).not.toContain("oldest-item");
  });

  test("outputs JSON when requested", async () => {
    const c1 = makeContribution({ summary: "JSON test" });
    await deps.store.put(c1);

    const output: string[] = [];
    await runLog({ limit: 20, json: true }, deps, (s) => output.push(s));

    const parsed = JSON.parse(output.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].summary).toBe("JSON test");
  });

  test("filters by kind", async () => {
    const work = makeContribution({ summary: "work item", kind: "work" as const });
    const review = makeContribution({
      summary: "review item",
      kind: "review" as const,
      createdAt: "2026-01-02T00:00:00Z",
    });

    await deps.store.put(work);
    await deps.store.put(review);

    const output: string[] = [];
    await runLog({ limit: 20, kind: "review", json: false }, deps, (s) => output.push(s));

    const text = output.join("\n");
    expect(text).toContain("review item");
    expect(text).not.toContain("work item");
  });

  test("filters by outcome status", async () => {
    const c1 = makeContribution({ summary: "accepted-item", createdAt: "2026-01-01T00:00:00Z" });
    const c2 = makeContribution({ summary: "rejected-item", createdAt: "2026-01-02T00:00:00Z" });
    const c3 = makeContribution({ summary: "no-outcome-item", createdAt: "2026-01-03T00:00:00Z" });

    await deps.store.put(c1);
    await deps.store.put(c2);
    await deps.store.put(c3);

    await outcomeStore.set(c1.cid, { status: "accepted", evaluatedBy: "test-agent" });
    await outcomeStore.set(c2.cid, { status: "rejected", evaluatedBy: "test-agent" });

    const output: string[] = [];
    await runLog({ limit: 20, outcome: "accepted", json: false }, deps, (s) => output.push(s));

    const text = output.join("\n");
    expect(text).toContain("accepted-item");
    expect(text).not.toContain("rejected-item");
    expect(text).not.toContain("no-outcome-item");
  });

  test("outcome filter returns empty when no matches", async () => {
    const c1 = makeContribution({ summary: "some-item" });
    await deps.store.put(c1);

    const output: string[] = [];
    await runLog({ limit: 20, outcome: "crashed", json: false }, deps, (s) => output.push(s));

    const text = output.join("\n");
    expect(text).toContain("(no results)");
  });

  test("outcome filter throws when outcomeStore is unavailable", async () => {
    const depsWithoutOutcome: CliDeps = { ...deps, outcomeStore: undefined };
    const c1 = makeContribution({ summary: "test-item" });
    await depsWithoutOutcome.store.put(c1);

    await expect(
      runLog({ limit: 20, outcome: "accepted", json: false }, depsWithoutOutcome),
    ).rejects.toThrow("Outcome store is not available");
  });
});

/**
 * Tests for grove frontier command.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultFrontierCalculator } from "../../core/frontier.js";
import { ContributionKind, RelationType, ScoreDirection } from "../../core/models.js";
import { makeContribution, makeRelation } from "../../core/test-helpers.js";
import { FsCas } from "../../local/fs-cas.js";
import { initSqliteDb, SqliteContributionStore } from "../../local/sqlite-store.js";
import type { CliDeps } from "../context.js";
import { parseFrontierArgs, runFrontier } from "./frontier.js";

let tmpDir: string;
let deps: CliDeps;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grove-frontier-test-"));
  const db = initSqliteDb(join(tmpDir, "grove.db"));
  const store = new SqliteContributionStore(db);
  const cas = new FsCas(join(tmpDir, "cas"));
  const frontier = new DefaultFrontierCalculator(store);
  deps = {
    store,
    frontier,
    workspace: undefined as never,
    cas,
    groveRoot: tmpDir,
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
// parseFrontierArgs
// ---------------------------------------------------------------------------

describe("parseFrontierArgs", () => {
  test("parses empty args with defaults", () => {
    const opts = parseFrontierArgs([]);
    expect(opts.limit).toBe(10);
    expect(opts.metric).toBeUndefined();
    expect(opts.tag).toBeUndefined();
    expect(opts.json).toBe(false);
  });

  test("parses all flags", () => {
    const opts = parseFrontierArgs([
      "--metric",
      "throughput",
      "--tag",
      "H100",
      "--mode",
      "evaluation",
      "-n",
      "5",
      "--json",
    ]);
    expect(opts.metric).toBe("throughput");
    expect(opts.tag).toBe("H100");
    expect(opts.mode).toBe("evaluation");
    expect(opts.limit).toBe(5);
    expect(opts.json).toBe(true);
  });

  test("rejects invalid limit", () => {
    expect(() => parseFrontierArgs(["-n", "abc"])).toThrow("Invalid limit");
  });
});

// ---------------------------------------------------------------------------
// runFrontier
// ---------------------------------------------------------------------------

describe("runFrontier", () => {
  test("outputs no data message for empty store", async () => {
    const output: string[] = [];
    await runFrontier({ limit: 10, json: false }, deps, (s) => output.push(s));
    expect(output.join("\n")).toContain("(no frontier data)");
  });

  test("shows metric frontier", async () => {
    const c = makeContribution({
      summary: "fast model",
      scores: { throughput: { value: 100, direction: ScoreDirection.Maximize } },
    });
    await deps.store.put(c);

    const output: string[] = [];
    await runFrontier({ metric: "throughput", limit: 10, json: false }, deps, (s) =>
      output.push(s),
    );

    const text = output.join("\n");
    expect(text).toContain("By metric: throughput");
    expect(text).toContain("fast model");
  });

  test("shows multiple dimensions", async () => {
    const c1 = makeContribution({ summary: "contrib 1" });
    const c2 = makeContribution({
      summary: "contrib 2",
      kind: ContributionKind.Adoption,
      relations: [makeRelation({ targetCid: c1.cid, relationType: RelationType.Adopts })],
      createdAt: "2026-01-02T00:00:00Z",
    });

    await deps.store.put(c1);
    await deps.store.put(c2);

    const output: string[] = [];
    await runFrontier({ limit: 10, json: false }, deps, (s) => output.push(s));

    const text = output.join("\n");
    // Should have recency and adoption sections
    expect(text).toContain("By recency");
    expect(text).toContain("By adoption count");
  });

  test("outputs JSON when requested", async () => {
    const c = makeContribution({
      summary: "json test",
      scores: { acc: { value: 0.95, direction: ScoreDirection.Maximize } },
    });
    await deps.store.put(c);

    const output: string[] = [];
    await runFrontier({ limit: 10, json: true }, deps, (s) => output.push(s));

    const parsed = JSON.parse(output.join(""));
    expect(parsed.byMetric).toBeDefined();
    expect(parsed.byRecency).toBeDefined();
  });
});

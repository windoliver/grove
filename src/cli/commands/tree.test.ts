/**
 * Tests for grove tree command.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultFrontierCalculator } from "../../core/frontier.js";
import { RelationType } from "../../core/models.js";
import { makeContribution, makeRelation } from "../../core/test-helpers.js";
import { FsCas } from "../../local/fs-cas.js";
import { initSqliteDb, SqliteContributionStore } from "../../local/sqlite-store.js";
import type { CliDeps } from "../context.js";
import { parseTreeArgs, runTree } from "./tree.js";

let tmpDir: string;
let deps: CliDeps;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grove-tree-test-"));
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
// parseTreeArgs
// ---------------------------------------------------------------------------

describe("parseTreeArgs", () => {
  test("parses empty args with defaults", () => {
    const opts = parseTreeArgs([]);
    expect(opts.depth).toBe(10);
    expect(opts.from).toBeUndefined();
    expect(opts.json).toBe(false);
  });

  test("parses --from and --depth", () => {
    const opts = parseTreeArgs(["--from", "blake3:abc", "--depth", "3"]);
    expect(opts.from).toBe("blake3:abc");
    expect(opts.depth).toBe(3);
  });

  test("parses --json", () => {
    const opts = parseTreeArgs(["--json"]);
    expect(opts.json).toBe(true);
  });

  test("rejects invalid depth", () => {
    expect(() => parseTreeArgs(["--depth", "abc"])).toThrow("Invalid depth");
  });
});

// ---------------------------------------------------------------------------
// runTree
// ---------------------------------------------------------------------------

describe("runTree", () => {
  test("outputs empty graph for empty store", async () => {
    const output: string[] = [];
    await runTree({ depth: 10, json: false }, deps, (s) => output.push(s));
    expect(output.join("\n")).toContain("(empty graph)");
  });

  test("renders a linear chain", async () => {
    const root = makeContribution({ summary: "root" });
    const child = makeContribution({
      summary: "child",
      relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.DerivesFrom })],
      createdAt: "2026-01-02T00:00:00Z",
    });

    await deps.store.put(root);
    await deps.store.put(child);

    const output: string[] = [];
    await runTree({ depth: 10, json: false }, deps, (s) => output.push(s));

    const text = output.join("\n");
    expect(text).toContain("*"); // DAG node marker
    expect(text).toContain("root");
    expect(text).toContain("child");
  });

  test("renders a branching DAG", async () => {
    const root = makeContribution({ summary: "root" });
    const branch1 = makeContribution({
      summary: "branch 1",
      relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.DerivesFrom })],
      createdAt: "2026-01-02T00:00:00Z",
    });
    const branch2 = makeContribution({
      summary: "branch 2",
      relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.DerivesFrom })],
      createdAt: "2026-01-03T00:00:00Z",
    });

    await deps.store.put(root);
    await deps.store.put(branch1);
    await deps.store.put(branch2);

    const output: string[] = [];
    await runTree({ depth: 10, json: false }, deps, (s) => output.push(s));

    const text = output.join("\n");
    expect(text).toContain("root");
    expect(text).toContain("branch 1");
    expect(text).toContain("branch 2");
  });

  test("filters subtree from specific CID", async () => {
    const root = makeContribution({ summary: "root" });
    const child = makeContribution({
      summary: "child",
      relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.DerivesFrom })],
      createdAt: "2026-01-02T00:00:00Z",
    });
    const unrelated = makeContribution({
      summary: "unrelated",
      createdAt: "2026-01-03T00:00:00Z",
    });

    await deps.store.put(root);
    await deps.store.put(child);
    await deps.store.put(unrelated);

    const output: string[] = [];
    await runTree({ from: child.cid, depth: 10, json: false }, deps, (s) => output.push(s));

    const text = output.join("\n");
    expect(text).toContain("child");
    expect(text).toContain("root"); // ancestor of child
    expect(text).not.toContain("unrelated");
  });

  test("subtree traversal excludes review/reproduction relations", async () => {
    const root = makeContribution({ summary: "root-node" });
    const child = makeContribution({
      summary: "child-node",
      relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.DerivesFrom })],
      createdAt: "2026-01-02T00:00:00Z",
    });
    // A review that reviews the child — should NOT be traversed
    const review = makeContribution({
      summary: "review-node",
      kind: "review" as const,
      relations: [makeRelation({ targetCid: child.cid, relationType: RelationType.Reviews })],
      createdAt: "2026-01-03T00:00:00Z",
    });
    // A reproduction that reproduces the child — should NOT be traversed
    const repro = makeContribution({
      summary: "repro-node",
      kind: "reproduction" as const,
      relations: [makeRelation({ targetCid: child.cid, relationType: RelationType.Reproduces })],
      createdAt: "2026-01-04T00:00:00Z",
    });

    await deps.store.put(root);
    await deps.store.put(child);
    await deps.store.put(review);
    await deps.store.put(repro);

    const output: string[] = [];
    await runTree({ from: child.cid, depth: 10, json: false }, deps, (s) => output.push(s));

    const text = output.join("\n");
    expect(text).toContain("child-node");
    expect(text).toContain("root-node"); // ancestor via derives_from
    expect(text).not.toContain("review-node"); // reviews relation excluded
    expect(text).not.toContain("repro-node"); // reproduces relation excluded
  });

  test("throws for missing --from CID", async () => {
    const badCid = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
    await expect(runTree({ from: badCid, depth: 10, json: false }, deps)).rejects.toThrow(
      "not found",
    );
  });

  test("outputs JSON when requested", async () => {
    const c = makeContribution({ summary: "json tree" });
    await deps.store.put(c);

    const output: string[] = [];
    await runTree({ depth: 10, json: true }, deps, (s) => output.push(s));

    const parsed = JSON.parse(output.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].summary).toBe("json tree");
  });
});

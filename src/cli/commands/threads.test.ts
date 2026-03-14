/**
 * Tests for `grove threads` command.
 *
 * Covers argument parsing, execution, and hot threads ranking.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultFrontierCalculator } from "../../core/frontier.js";
import { ContributionKind, RelationType } from "../../core/models.js";
import { makeContribution, makeRelation } from "../../core/test-helpers.js";
import { FsCas } from "../../local/fs-cas.js";
import {
  initSqliteDb,
  SqliteClaimStore,
  SqliteContributionStore,
} from "../../local/sqlite-store.js";
import type { CliDeps } from "../context.js";
import { parseThreadsArgs, runThreads } from "./threads.js";

let tmpDir: string;
let deps: CliDeps;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grove-threads-test-"));
  const db = initSqliteDb(join(tmpDir, "grove.db"));
  const store = new SqliteContributionStore(db);
  const claimStore = new SqliteClaimStore(db);
  const cas = new FsCas(join(tmpDir, "cas"));
  const frontier = new DefaultFrontierCalculator(store);
  deps = {
    store,
    claimStore,
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
// parseThreadsArgs
// ---------------------------------------------------------------------------

describe("parseThreadsArgs", () => {
  test("defaults", () => {
    const opts = parseThreadsArgs([]);
    expect(opts.tags).toEqual([]);
    expect(opts.limit).toBe(10);
    expect(opts.json).toBe(false);
  });

  test("parses --tag flag", () => {
    const opts = parseThreadsArgs(["--tag", "architecture"]);
    expect(opts.tags).toEqual(["architecture"]);
  });

  test("parses --limit flag", () => {
    const opts = parseThreadsArgs(["--limit", "20"]);
    expect(opts.limit).toBe(20);
  });

  test("parses --json flag", () => {
    const opts = parseThreadsArgs(["--json"]);
    expect(opts.json).toBe(true);
  });

  test("throws on invalid limit", () => {
    expect(() => parseThreadsArgs(["--limit", "abc"])).toThrow("Invalid limit");
  });
});

// ---------------------------------------------------------------------------
// runThreads
// ---------------------------------------------------------------------------

describe("runThreads", () => {
  test("displays no active threads message when empty", async () => {
    const lines: string[] = [];
    await runThreads({ tags: [], limit: 10, json: false, wide: false }, deps, (msg) =>
      lines.push(msg),
    );
    expect(lines.join("")).toContain("no active threads");
  });

  test("outputs valid JSON object when empty and --json is set", async () => {
    // outputJson writes to console.log, not the writer
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logged.push(msg);
    try {
      await runThreads({ tags: [], limit: 10, json: true, wide: false }, deps);
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(logged.join(""));
    expect(parsed.threads).toBeDefined();
    expect(Array.isArray(parsed.threads)).toBe(true);
    expect(parsed.threads).toHaveLength(0);
    expect(parsed.count).toBe(0);
  });

  test("lists hot threads sorted by reply count", async () => {
    // Thread A: 2 replies
    const rootA = makeContribution({
      kind: ContributionKind.Discussion,
      summary: "Thread A",
    });
    await deps.store.put(rootA);

    for (let i = 0; i < 2; i++) {
      await deps.store.put(
        makeContribution({
          kind: ContributionKind.Discussion,
          summary: `Reply to A ${i}`,
          relations: [
            makeRelation({ targetCid: rootA.cid, relationType: RelationType.RespondsTo }),
          ],
          createdAt: `2026-01-0${2 + i}T00:00:00Z`,
        }),
      );
    }

    // Thread B: 1 reply
    const rootB = makeContribution({
      kind: ContributionKind.Discussion,
      summary: "Thread B",
      createdAt: "2026-01-05T00:00:00Z",
    });
    await deps.store.put(rootB);

    await deps.store.put(
      makeContribution({
        kind: ContributionKind.Discussion,
        summary: "Reply to B",
        relations: [makeRelation({ targetCid: rootB.cid, relationType: RelationType.RespondsTo })],
        createdAt: "2026-01-06T00:00:00Z",
      }),
    );

    const lines: string[] = [];
    await runThreads({ tags: [], limit: 10, json: false, wide: false }, deps, (msg) =>
      lines.push(msg),
    );
    const output = lines.join("\n");
    // Thread A should appear first (more replies)
    const indexA = output.indexOf("Thread A");
    const indexB = output.indexOf("Thread B");
    expect(indexA).toBeGreaterThan(-1);
    expect(indexB).toBeGreaterThan(-1);
    expect(indexA).toBeLessThan(indexB);
  });

  test("outputs JSON when --json is set", async () => {
    const root = makeContribution({
      kind: ContributionKind.Discussion,
      summary: "Topic",
    });
    await deps.store.put(root);

    await deps.store.put(
      makeContribution({
        kind: ContributionKind.Discussion,
        summary: "Reply",
        relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.RespondsTo })],
        createdAt: "2026-01-02T00:00:00Z",
      }),
    );

    // outputJson writes to console.log, not the writer
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logged.push(msg);
    try {
      await runThreads({ tags: [], limit: 10, json: true, wide: false }, deps);
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(logged.join(""));
    expect(parsed.threads).toBeDefined();
    expect(Array.isArray(parsed.threads)).toBe(true);
    expect(parsed.threads[0].replyCount).toBe(1);
    expect(parsed.count).toBe(1);
  });
});

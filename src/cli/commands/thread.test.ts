/**
 * Tests for `grove thread` command.
 *
 * Covers argument parsing, execution, and output formatting.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultFrontierCalculator } from "../../core/frontier.js";
import { ContributionKind, RelationType } from "../../core/models.js";
import { makeContribution, makeRelation } from "../../core/test-helpers.js";
import { FsCas } from "../../local/fs-cas.js";
import { initSqliteDb, SqliteContributionStore } from "../../local/sqlite-store.js";
import type { CliDeps } from "../context.js";
import { parseThreadArgs, runThread } from "./thread.js";

let tmpDir: string;
let deps: CliDeps;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grove-thread-test-"));
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
// parseThreadArgs
// ---------------------------------------------------------------------------

describe("parseThreadArgs", () => {
  test("parses positional CID", () => {
    const opts = parseThreadArgs(["blake3:abc123"]);
    expect(opts.cid).toBe("blake3:abc123");
    expect(opts.depth).toBe(50);
    expect(opts.limit).toBe(100);
    expect(opts.json).toBe(false);
  });

  test("parses --depth flag", () => {
    const opts = parseThreadArgs(["blake3:abc123", "--depth", "5"]);
    expect(opts.depth).toBe(5);
  });

  test("parses -n flag", () => {
    const opts = parseThreadArgs(["blake3:abc123", "-n", "20"]);
    expect(opts.limit).toBe(20);
  });

  test("parses --json flag", () => {
    const opts = parseThreadArgs(["blake3:abc123", "--json"]);
    expect(opts.json).toBe(true);
  });

  test("throws on missing CID", () => {
    expect(() => parseThreadArgs([])).toThrow("Usage:");
  });

  test("throws on invalid depth", () => {
    expect(() => parseThreadArgs(["blake3:abc123", "--depth", "abc"])).toThrow("Invalid depth");
  });

  test("throws on invalid limit", () => {
    expect(() => parseThreadArgs(["blake3:abc123", "-n", "abc"])).toThrow("Invalid limit");
  });
});

// ---------------------------------------------------------------------------
// runThread
// ---------------------------------------------------------------------------

describe("runThread", () => {
  test("displays a thread", async () => {
    const root = makeContribution({
      kind: ContributionKind.Discussion,
      summary: "Should we refactor?",
    });
    const reply = makeContribution({
      kind: ContributionKind.Discussion,
      summary: "Yes, the parser is too complex",
      relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.RespondsTo })],
      agent: { agentId: "test-agent-2" },
      createdAt: "2026-01-02T00:00:00Z",
    });

    await deps.store.put(root);
    await deps.store.put(reply);

    const lines: string[] = [];
    await runThread({ cid: root.cid, depth: 50, limit: 100, json: false }, deps, (msg) =>
      lines.push(msg),
    );
    const output = lines.join("\n");
    expect(output).toContain("Should we refactor?");
    expect(output).toContain("Yes, the parser is too complex");
  });

  test("outputs JSON when --json is set", async () => {
    const root = makeContribution({
      kind: ContributionKind.Discussion,
      summary: "Topic",
    });

    await deps.store.put(root);

    const lines: string[] = [];
    await runThread({ cid: root.cid, depth: 50, limit: 100, json: true }, deps, (msg) =>
      lines.push(msg),
    );
    const parsed = JSON.parse(lines.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].depth).toBe(0);
  });

  test("throws on non-existent CID", async () => {
    const badCid = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
    await expect(
      runThread({ cid: badCid, depth: 50, limit: 100, json: false }, deps),
    ).rejects.toThrow("not found");
  });
});

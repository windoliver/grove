/**
 * Tests for grove search command.
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
import { parseSearchArgs, runSearch } from "./search.js";

let tmpDir: string;
let deps: CliDeps;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grove-search-test-"));
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
// parseSearchArgs
// ---------------------------------------------------------------------------

describe("parseSearchArgs", () => {
  test("parses empty args with defaults", () => {
    const opts = parseSearchArgs([]);
    expect(opts.sort).toBe("recency");
    expect(opts.limit).toBe(20);
    expect(opts.json).toBe(false);
  });

  test("parses all flags", () => {
    const opts = parseSearchArgs([
      "--query",
      "pool",
      "--kind",
      "work",
      "--mode",
      "exploration",
      "--tag",
      "gpu",
      "--agent",
      "alice",
      "--sort",
      "adoption",
      "-n",
      "5",
      "--json",
    ]);
    expect(opts.query).toBe("pool");
    expect(opts.kind).toBe("work");
    expect(opts.mode).toBe("exploration");
    expect(opts.tag).toBe("gpu");
    expect(opts.agent).toBe("alice");
    expect(opts.sort).toBe("adoption");
    expect(opts.limit).toBe(5);
    expect(opts.json).toBe(true);
  });

  test("rejects invalid sort", () => {
    expect(() => parseSearchArgs(["--sort", "invalid"])).toThrow("Invalid sort");
  });
});

// ---------------------------------------------------------------------------
// runSearch
// ---------------------------------------------------------------------------

describe("runSearch", () => {
  test("returns no results for empty store", async () => {
    const output: string[] = [];
    await runSearch({ sort: "recency", limit: 20, json: false, wide: false }, deps, (s) =>
      output.push(s),
    );
    expect(output.join("\n")).toContain("(no results)");
  });

  test("searches by full-text query", async () => {
    const c1 = makeContribution({ summary: "connection pool optimization" });
    const c2 = makeContribution({
      summary: "unrelated work",
      createdAt: "2026-01-02T00:00:00Z",
    });

    await deps.store.put(c1);
    await deps.store.put(c2);

    const output: string[] = [];
    await runSearch(
      { query: "connection pool", sort: "recency", limit: 20, json: false, wide: false },
      deps,
      (s) => output.push(s),
    );

    const text = output.join("\n");
    expect(text).toContain("connection pool");
    expect(text).not.toContain("unrelated work");
  });

  test("filters by tag", async () => {
    const tagged = makeContribution({ summary: "gpu work", tags: ["gpu"] });
    const untagged = makeContribution({
      summary: "cpu work",
      tags: ["cpu"],
      createdAt: "2026-01-02T00:00:00Z",
    });

    await deps.store.put(tagged);
    await deps.store.put(untagged);

    const output: string[] = [];
    await runSearch(
      { tag: "gpu", sort: "recency", limit: 20, json: false, wide: false },
      deps,
      (s) => output.push(s),
    );

    const text = output.join("\n");
    expect(text).toContain("gpu work");
    expect(text).not.toContain("cpu work");
  });

  test("sorts by adoption count", async () => {
    const popular = makeContribution({ summary: "popular" });
    const unpopular = makeContribution({
      summary: "unpopular",
      createdAt: "2026-01-02T00:00:00Z",
    });

    await deps.store.put(popular);
    await deps.store.put(unpopular);

    // Create an adoption for the popular contribution
    const adopter = makeContribution({
      summary: "I adopt popular",
      kind: ContributionKind.Adoption,
      relations: [makeRelation({ targetCid: popular.cid, relationType: RelationType.Adopts })],
      createdAt: "2026-01-03T00:00:00Z",
    });
    await deps.store.put(adopter);

    const output: string[] = [];
    await runSearch(
      { kind: "work", sort: "adoption", limit: 20, json: false, wide: false },
      deps,
      (s) => output.push(s),
    );

    const text = output.join("\n");
    const popularIdx = text.indexOf("popular");
    const unpopularIdx = text.indexOf("unpopular");
    // "popular" (1 adoption) should appear before "unpopular" (0 adoptions)
    expect(popularIdx).toBeLessThan(unpopularIdx);
  });

  test("limit returns most-adopted, not dropped (sort-before-slice)", async () => {
    const popular = makeContribution({ summary: "popular-item" });
    const unpopular = makeContribution({
      summary: "unpopular-item",
      createdAt: "2026-01-02T00:00:00Z",
    });

    await deps.store.put(popular);
    await deps.store.put(unpopular);

    // Create two adoptions for the popular contribution
    const adopter1 = makeContribution({
      summary: "adopter 1",
      kind: ContributionKind.Adoption,
      relations: [makeRelation({ targetCid: popular.cid, relationType: RelationType.Adopts })],
      createdAt: "2026-01-03T00:00:00Z",
    });
    const adopter2 = makeContribution({
      summary: "adopter 2",
      kind: ContributionKind.Adoption,
      relations: [makeRelation({ targetCid: popular.cid, relationType: RelationType.Adopts })],
      createdAt: "2026-01-04T00:00:00Z",
    });
    await deps.store.put(adopter1);
    await deps.store.put(adopter2);

    const output: string[] = [];
    // -n 1 with adoption sort must return the most-adopted item, not an arbitrary one
    await runSearch(
      { kind: "work", sort: "adoption", limit: 1, json: false, wide: false },
      deps,
      (s) => output.push(s),
    );

    const text = output.join("\n");
    expect(text).toContain("popular-item");
    expect(text).not.toContain("unpopular-item");
  });

  test("outputs JSON when requested", async () => {
    const c = makeContribution({ summary: "json search" });
    await deps.store.put(c);

    // outputJson writes to console.log, not the writer
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logged.push(msg);
    try {
      await runSearch({ sort: "recency", limit: 20, json: true, wide: false }, deps);
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(logged.join(""));
    expect(parsed.results).toBeDefined();
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.count).toBeGreaterThan(0);
  });
});

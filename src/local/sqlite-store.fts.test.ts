/**
 * FTS5 edge case tests for SQLite store search functionality.
 *
 * Validates that full-text search handles special characters,
 * empty queries, and edge cases without crashing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContributionStore } from "../core/store.js";
import { makeContribution } from "../core/test-helpers.js";
import { createSqliteStores } from "./sqlite-store.js";

describe("FTS5 edge cases", () => {
  let store: ContributionStore;
  let closeDb: () => void;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sqlite-fts-"));
    const dbPath = join(dir, "test.db");
    const stores = createSqliteStores(dbPath);
    store = stores.contributionStore;
    closeDb = stores.close;
  });

  afterEach(async () => {
    store.close();
    closeDb();
    await rm(dir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  // Special FTS5 characters
  // ------------------------------------------------------------------

  test("search with double quotes does not crash", async () => {
    const c = makeContribution({ summary: 'contains "quoted" text' });
    await store.put(c);
    const results = await store.search('"quoted"');
    // Should not throw — may or may not match depending on FTS5 escaping
    expect(Array.isArray(results)).toBe(true);
  });

  test("search with asterisk wildcard does not crash", async () => {
    const c = makeContribution({ summary: "testing wildcard patterns" });
    await store.put(c);
    const results = await store.search("test*");
    expect(Array.isArray(results)).toBe(true);
  });

  test("search with parentheses does not crash", async () => {
    const c = makeContribution({ summary: "function call (args)" });
    await store.put(c);
    const results = await store.search("(args)");
    expect(Array.isArray(results)).toBe(true);
  });

  test("search with FTS5 operators does not crash", async () => {
    const c = makeContribution({ summary: "AND OR NOT NEAR query" });
    await store.put(c);
    // These are FTS5 operators — quoting should escape them
    const results = await store.search("AND OR NOT");
    expect(Array.isArray(results)).toBe(true);
  });

  test("search with dashes does not crash", async () => {
    const c = makeContribution({ summary: "high-performance system" });
    await store.put(c);
    const results = await store.search("high-performance");
    expect(Array.isArray(results)).toBe(true);
  });

  test("search with colons does not crash", async () => {
    const c = makeContribution({ summary: "key: value pair" });
    await store.put(c);
    const results = await store.search("key:");
    expect(Array.isArray(results)).toBe(true);
  });

  // ------------------------------------------------------------------
  // Empty and whitespace
  // ------------------------------------------------------------------

  test("search with only whitespace returns empty", async () => {
    const c = makeContribution({ summary: "some content" });
    await store.put(c);
    // FTS5 with only whitespace in quotes should match nothing
    const results = await store.search("   ");
    expect(results.length).toBe(0);
  });

  // ------------------------------------------------------------------
  // Contributions with empty descriptions
  // ------------------------------------------------------------------

  test("search matches contributions with no description", async () => {
    const c = makeContribution({ summary: "searchable summary here" });
    await store.put(c);
    const results = await store.search("searchable");
    expect(results.length).toBe(1);
    expect(results[0]?.cid).toBe(c.cid);
  });

  test("search matches description when summary does not match", async () => {
    const c = makeContribution({
      summary: "generic title",
      description: "unique keyword xylophone",
    });
    await store.put(c);
    const results = await store.search("xylophone");
    expect(results.length).toBe(1);
    expect(results[0]?.cid).toBe(c.cid);
  });

  // ------------------------------------------------------------------
  // Unicode
  // ------------------------------------------------------------------

  test("search with Unicode characters does not crash", async () => {
    const c = makeContribution({ summary: "日本語のテスト contribution" });
    await store.put(c);
    // FTS5 default tokenizer may not handle CJK; just verify no crash
    const results = await store.search("テスト");
    expect(Array.isArray(results)).toBe(true);
  });

  test("search finds Latin Unicode content", async () => {
    const c = makeContribution({ summary: "résumé with accented characters" });
    await store.put(c);
    const results = await store.search("résumé");
    expect(results.length).toBe(1);
    expect(results[0]?.cid).toBe(c.cid);
  });

  test("search with emoji", async () => {
    const c = makeContribution({ summary: "rocket launch 🚀 experiment" });
    await store.put(c);
    const results = await store.search("rocket");
    expect(results.length).toBe(1);
  });

  // ------------------------------------------------------------------
  // Long queries
  // ------------------------------------------------------------------

  test("search with very long query does not crash", async () => {
    const c = makeContribution({ summary: "short" });
    await store.put(c);
    const longQuery = "a".repeat(1000);
    const results = await store.search(longQuery);
    expect(results.length).toBe(0);
  });
});

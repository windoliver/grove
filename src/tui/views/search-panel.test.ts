/**
 * Tests for search-panel pure functions.
 *
 * Tests searchTranscripts and selectFetcher — the exact functions
 * involved in issue #3 (silent search fallback) and the search
 * capability detection fix (issue #6A).
 */

import { describe, expect, mock, test } from "bun:test";
import type { Contribution } from "../../core/models.js";
import { searchTranscripts, selectFetcher } from "./search-panel.js";

// ---------------------------------------------------------------------------
// searchTranscripts
// ---------------------------------------------------------------------------

describe("searchTranscripts", () => {
  test("returns empty array when no buffers", () => {
    const results = searchTranscripts(new Map(), "hello");
    expect(results).toEqual([]);
  });

  test("finds matching lines and includes session + line number", () => {
    const buffers = new Map([["session-1", "line one\nhello world\nline three"]]);
    const results = searchTranscripts(buffers, "hello");
    expect(results.length).toBe(1);
    const hit = results[0];
    expect(hit?.session).toBe("session-1");
    expect(hit?.lineNo).toBe("2");
    expect(hit?.content).toBe("hello world");
  });

  test("search is case-insensitive", () => {
    const buffers = new Map([["sess", "HELLO WORLD\nhello lowercase"]]);
    const results = searchTranscripts(buffers, "hello");
    expect(results.length).toBe(2);
  });

  test("searches across multiple sessions", () => {
    const buffers = new Map([
      ["sess-a", "match in a"],
      ["sess-b", "no hit here"],
      ["sess-c", "match in c"],
    ]);
    const results = searchTranscripts(buffers, "match");
    expect(results.length).toBe(2);
    const sessions = results.map((r) => r.session);
    expect(sessions).toContain("sess-a");
    expect(sessions).toContain("sess-c");
  });

  test("truncates content longer than 50 chars", () => {
    const longLine = "a".repeat(60);
    const buffers = new Map([["sess", `prefix ${longLine}`]]);
    const results = searchTranscripts(buffers, "prefix");
    const content = results[0]?.content ?? "";
    expect(content.endsWith("..")).toBe(true);
    expect(content.length).toBeLessThanOrEqual(50);
  });

  test("caps results at 100", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `match line ${i}`).join("\n");
    const buffers = new Map([["sess", lines]]);
    const results = searchTranscripts(buffers, "match");
    expect(results.length).toBe(100);
  });

  test("returns empty when query has no matches", () => {
    const buffers = new Map([["sess", "no hit in here at all"]]);
    const results = searchTranscripts(buffers, "xyz123notpresent");
    expect(results).toEqual([]);
  });

  test("line numbers are 1-based", () => {
    const buffers = new Map([["sess", "first\nsecond\nthird"]]);
    const results = searchTranscripts(buffers, "first");
    expect(results[0]?.lineNo).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// selectFetcher — capability-based search routing
// This is the critical bug from issue #3: users believed they were searching
// but were silently seeing recent contributions.
// ---------------------------------------------------------------------------

describe("selectFetcher", () => {
  const makeContributions = (): readonly Contribution[] => [];

  test("no query: always returns getContributions regardless of hasSearch", () => {
    const getContributions = mock(async () => makeContributions());
    const search = mock(async (_q: string) => makeContributions());

    const fetcher = selectFetcher(true, "", getContributions, search);
    expect(fetcher).toBe(getContributions);

    const fetcherNoSearch = selectFetcher(false, "", getContributions, search);
    expect(fetcherNoSearch).toBe(getContributions);
  });

  test("has query + hasSearch=true: returns search fetcher", () => {
    const getContributions = mock(async () => makeContributions());
    const search = mock(async (_q: string) => makeContributions());

    const fetcher = selectFetcher(true, "my query", getContributions, search);
    // Should NOT be getContributions
    expect(fetcher).not.toBe(getContributions);
    // Calling the returned fetcher should invoke search with the query
    void fetcher();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("my query");
  });

  test("has query + hasSearch=false: falls back to getContributions (the reported bug case)", () => {
    const getContributions = mock(async () => makeContributions());
    const search = mock(async (_q: string) => makeContributions());

    const fetcher = selectFetcher(false, "my query", getContributions, search);
    // Should fall back to getContributions, NOT search
    expect(fetcher).toBe(getContributions);
    expect(search).not.toHaveBeenCalled();
  });

  test("search fetcher calls search with the exact query string", async () => {
    const getContributions = mock(async () => makeContributions());
    const results: Contribution[] = [];
    const search = mock(async (_q: string) => results);

    const fetcher = selectFetcher(true, "exact query 123", getContributions, search);
    await fetcher();
    expect(search).toHaveBeenCalledWith("exact query 123");
  });
});

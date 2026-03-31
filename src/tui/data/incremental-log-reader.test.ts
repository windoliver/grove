/**
 * Tests for IncrementalLogReader — uses real temp files, not mocks.
 *
 * Covers: initial read, subsequent reads (only new bytes), file truncation,
 * partial line boundary, file deletion, multiple files per role sorted by mtime.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncrementalLogReader } from "./incremental-log-reader.js";

let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `grove-log-reader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

function writeTempFile(name: string, content: string): string {
  const path = join(testDir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

function appendToFile(name: string, content: string): void {
  appendFileSync(join(testDir, name), content, "utf-8");
}

// ===========================================================================
// Initial read
// ===========================================================================

describe("initial read", () => {
  test("reads all lines from a new file", async () => {
    const path = writeTempFile("coder.log", "line1\nline2\nline3\n");
    const reader = new IncrementalLogReader(path);
    const lines = await reader.readNew();
    expect(lines).toEqual(["line1", "line2", "line3"]);
  });

  test("returns empty for empty file", async () => {
    const path = writeTempFile("coder.log", "");
    const reader = new IncrementalLogReader(path);
    const lines = await reader.readNew();
    expect(lines).toEqual([]);
  });

  test("handles file with no trailing newline", async () => {
    const path = writeTempFile("coder.log", "line1\nline2");
    const reader = new IncrementalLogReader(path);
    const lines = await reader.readNew();
    // Partial last line is buffered until next newline
    expect(lines).toEqual(["line1"]);
  });
});

// ===========================================================================
// Subsequent reads (incremental)
// ===========================================================================

describe("incremental reads", () => {
  test("second read returns only new lines", async () => {
    const path = writeTempFile("coder.log", "line1\nline2\n");
    const reader = new IncrementalLogReader(path);

    await reader.readNew(); // consume initial
    appendToFile("coder.log", "line3\nline4\n");
    const lines = await reader.readNew();
    expect(lines).toEqual(["line3", "line4"]);
  });

  test("returns empty when no new data", async () => {
    const path = writeTempFile("coder.log", "line1\n");
    const reader = new IncrementalLogReader(path);

    await reader.readNew();
    const lines = await reader.readNew();
    expect(lines).toEqual([]);
  });

  test("handles multiple incremental reads", async () => {
    const path = writeTempFile("coder.log", "a\n");
    const reader = new IncrementalLogReader(path);

    expect(await reader.readNew()).toEqual(["a"]);

    appendToFile("coder.log", "b\n");
    expect(await reader.readNew()).toEqual(["b"]);

    appendToFile("coder.log", "c\nd\n");
    expect(await reader.readNew()).toEqual(["c", "d"]);
  });
});

// ===========================================================================
// Partial line boundary
// ===========================================================================

describe("partial line handling", () => {
  test("buffers partial line until next newline", async () => {
    const path = writeTempFile("coder.log", "complete\npart");
    const reader = new IncrementalLogReader(path);

    const first = await reader.readNew();
    expect(first).toEqual(["complete"]);

    appendToFile("coder.log", "ial-line-done\n");
    const second = await reader.readNew();
    expect(second).toEqual(["partial-line-done"]);
  });

  test("handles line split across three reads", async () => {
    const path = writeTempFile("coder.log", "first-");
    const reader = new IncrementalLogReader(path);

    expect(await reader.readNew()).toEqual([]);

    appendToFile("coder.log", "second-");
    expect(await reader.readNew()).toEqual([]);

    appendToFile("coder.log", "third\n");
    expect(await reader.readNew()).toEqual(["first-second-third"]);
  });
});

// ===========================================================================
// File truncation / rotation
// ===========================================================================

describe("file truncation", () => {
  test("detects truncated file and resets", async () => {
    const path = writeTempFile("coder.log", "line1\nline2\nline3\nline4\nline5\n");
    const reader = new IncrementalLogReader(path);

    await reader.readNew(); // read all 5 lines, offset is now 30

    // Truncate and write shorter content (simulates copytruncate rotation)
    writeFileSync(path, "new\n", "utf-8");
    const lines = await reader.readNew();
    expect(lines).toEqual(["new"]);
  });
});

// ===========================================================================
// File deletion
// ===========================================================================

describe("file deletion", () => {
  test("returns empty when file is deleted", async () => {
    const path = writeTempFile("coder.log", "line1\n");
    const reader = new IncrementalLogReader(path);

    await reader.readNew();
    rmSync(path);
    const lines = await reader.readNew();
    expect(lines).toEqual([]);
  });

  test("recovers when file is recreated", async () => {
    const path = writeTempFile("coder.log", "old\n");
    const reader = new IncrementalLogReader(path);

    await reader.readNew();
    rmSync(path);
    await reader.readNew(); // file gone

    writeFileSync(path, "new\n", "utf-8");
    const lines = await reader.readNew();
    expect(lines).toEqual(["new"]);
  });
});

// ===========================================================================
// readMultiRole — multiple files per role, sorted by mtime
// ===========================================================================

describe("readMultiRole (static)", () => {
  test("reads files sorted by mtime (oldest first)", async () => {
    const older = writeTempFile("coder-0.log", "old-line\n");
    // Ensure different mtime
    const olderTime = new Date(Date.now() - 2000);
    utimesSync(older, olderTime, olderTime);

    writeTempFile("coder-1.log", "new-line\n");

    const lines = await IncrementalLogReader.readAllSorted(testDir, "coder");
    expect(lines).toEqual(["old-line", "new-line"]);
  });

  test("returns empty for nonexistent directory", async () => {
    const lines = await IncrementalLogReader.readAllSorted("/nonexistent/dir", "coder");
    expect(lines).toEqual([]);
  });

  test("filters to matching role files only", async () => {
    writeTempFile("coder-0.log", "coder-line\n");
    writeTempFile("reviewer-0.log", "reviewer-line\n");

    const lines = await IncrementalLogReader.readAllSorted(testDir, "coder");
    expect(lines).toEqual(["coder-line"]);
  });
});

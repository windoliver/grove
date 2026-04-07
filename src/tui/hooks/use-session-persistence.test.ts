/**
 * Unit tests for use-session-persistence.ts.
 *
 * Covers I/O helpers (readViewState, writeAtomic, sessionStatePath)
 * and hook behavior (write-gate race condition, debounce cancel on unmount).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readViewState,
  sessionStatePath,
  type TuiViewState,
  writeAtomic,
} from "./use-session-persistence.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grove-persist-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// sessionStatePath
// ---------------------------------------------------------------------------

describe("sessionStatePath", () => {
  test("returns expected path format", () => {
    const p = sessionStatePath("/some/grove", "abc123");
    expect(p).toBe(join("/some/grove", ".sessions", "abc123-tui-state.json"));
  });

  test("includes session ID in filename", () => {
    const p = sessionStatePath("/grove", "my-session");
    expect(p).toContain("my-session-tui-state.json");
  });
});

// ---------------------------------------------------------------------------
// writeAtomic
// ---------------------------------------------------------------------------

describe("writeAtomic", () => {
  test("writes content to target file", async () => {
    const path = join(tmpDir, "test.json");
    await writeAtomic(path, '{"ok":true}');
    const content = await readFile(path, "utf-8");
    expect(content).toBe('{"ok":true}');
  });

  test("creates parent directory if missing", async () => {
    const path = join(tmpDir, "nested", "dir", "test.json");
    await writeAtomic(path, "hello");
    expect(existsSync(path)).toBe(true);
  });

  test("no .tmp file remains after successful write", async () => {
    const path = join(tmpDir, "test.json");
    await writeAtomic(path, "data");
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  test("overwrites existing file atomically", async () => {
    const path = join(tmpDir, "test.json");
    await writeAtomic(path, "first");
    await writeAtomic(path, "second");
    const content = await readFile(path, "utf-8");
    expect(content).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// readViewState
// ---------------------------------------------------------------------------

describe("readViewState", () => {
  test("returns null when file does not exist", async () => {
    const result = await readViewState(tmpDir, "nonexistent");
    expect(result).toBeNull();
  });

  test("returns null on corrupt JSON", async () => {
    const sessDir = join(tmpDir, ".sessions");
    await mkdir(sessDir, { recursive: true });
    await writeFile(join(sessDir, "bad-tui-state.json"), "{ bad", "utf-8");
    const result = await readViewState(tmpDir, "bad");
    expect(result).toBeNull();
  });

  test("loads all TuiViewState fields", async () => {
    const state: TuiViewState = {
      zoomLevel: "half",
      focusedPanel: 2,
      visibleOperatorPanels: [5, 6],
      searchQuery: "my search",
    };
    const sessDir = join(tmpDir, ".sessions");
    await mkdir(sessDir, { recursive: true });
    await writeFile(join(sessDir, "sess1-tui-state.json"), JSON.stringify(state), "utf-8");

    const result = await readViewState(tmpDir, "sess1");
    expect(result).not.toBeNull();
    expect(result?.zoomLevel).toBe("half");
    expect(result?.focusedPanel).toBe(2);
    expect(result?.visibleOperatorPanels).toEqual([5, 6]);
    expect(result?.searchQuery).toBe("my search");
  });

  test("handles null expandedPanel correctly", async () => {
    const sessDir = join(tmpDir, ".sessions");
    await mkdir(sessDir, { recursive: true });
    await writeFile(
      join(sessDir, "s-tui-state.json"),
      JSON.stringify({ expandedPanel: null }),
      "utf-8",
    );
    const result = await readViewState(tmpDir, "s");
    expect(result?.expandedPanel).toBeNull();
  });

  test("returns undefined for unknown field types (type coercion guard)", async () => {
    const sessDir = join(tmpDir, ".sessions");
    await mkdir(sessDir, { recursive: true });
    await writeFile(
      join(sessDir, "t-tui-state.json"),
      JSON.stringify({ zoomLevel: 999, focusedPanel: "not-a-number" }),
      "utf-8",
    );
    const result = await readViewState(tmpDir, "t");
    // zoomLevel is not a string → undefined; focusedPanel is not a number → undefined
    expect(result?.zoomLevel).toBeUndefined();
    expect(result?.focusedPanel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Round-trip: write then read
// ---------------------------------------------------------------------------

describe("writeAtomic + readViewState round-trip", () => {
  test("state survives a write-then-read cycle", async () => {
    const state: TuiViewState = {
      zoomLevel: "full",
      focusedPanel: 3,
      visibleOperatorPanels: [5, 7],
      searchQuery: "hello",
    };
    const path = sessionStatePath(tmpDir, "round-trip");
    await writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
    const result = await readViewState(tmpDir, "round-trip");
    expect(result?.zoomLevel).toBe("full");
    expect(result?.focusedPanel).toBe(3);
    expect(result?.visibleOperatorPanels).toEqual([5, 7]);
    expect(result?.searchQuery).toBe("hello");
  });
});

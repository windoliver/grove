/**
 * Tests for FileSessionStore — validates save/load/remove roundtrip,
 * corrupted file handling, and missing file handling.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedSpawnRecord } from "./session-store.js";
import { FileSessionStore } from "./session-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `grove-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeRecord(spawnId: string): PersistedSpawnRecord {
  return {
    spawnId,
    claimId: `claim-${spawnId}`,
    targetRef: spawnId,
    agentId: spawnId,
    workspacePath: `/tmp/ws/${spawnId}`,
    spawnedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors in tests
    }
  }
  tmpDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FileSessionStore", () => {
  test("save and loadAll roundtrip", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const store = new FileSessionStore(dir);

    const record = makeRecord("agent-1");
    store.save(record);

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.spawnId).toBe("agent-1");
    expect(loaded[0]?.claimId).toBe("claim-agent-1");
    expect(loaded[0]?.workspacePath).toBe("/tmp/ws/agent-1");
  });

  test("save multiple records", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const store = new FileSessionStore(dir);

    store.save(makeRecord("agent-1"));
    store.save(makeRecord("agent-2"));
    store.save(makeRecord("agent-3"));

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(3);
    expect(loaded.map((r) => r.spawnId)).toEqual(["agent-1", "agent-2", "agent-3"]);
  });

  test("save updates existing record with same spawnId", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const store = new FileSessionStore(dir);

    store.save(makeRecord("agent-1"));
    store.save({
      ...makeRecord("agent-1"),
      claimId: "updated-claim",
    });

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.claimId).toBe("updated-claim");
  });

  test("remove deletes a specific record", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const store = new FileSessionStore(dir);

    store.save(makeRecord("agent-1"));
    store.save(makeRecord("agent-2"));
    store.remove("agent-1");

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.spawnId).toBe("agent-2");
  });

  test("remove non-existent record is a no-op", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const store = new FileSessionStore(dir);

    store.save(makeRecord("agent-1"));
    store.remove("non-existent");

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
  });

  test("loadAll returns empty array for missing file", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const store = new FileSessionStore(dir);

    const loaded = store.loadAll();
    expect(loaded).toEqual([]);
  });

  test("loadAll returns empty array for corrupted file (invalid JSON)", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const filePath = join(dir, "tui-sessions.json");
    writeFileSync(filePath, "this is not JSON!!!", "utf-8");

    const store = new FileSessionStore(dir);
    const loaded = store.loadAll();
    expect(loaded).toEqual([]);
  });

  test("loadAll returns empty array for file containing non-array JSON", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const filePath = join(dir, "tui-sessions.json");
    writeFileSync(filePath, '{"not": "an array"}', "utf-8");

    const store = new FileSessionStore(dir);
    const loaded = store.loadAll();
    expect(loaded).toEqual([]);
  });

  test("loadAll filters out records with missing required fields", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const filePath = join(dir, "tui-sessions.json");
    const records = [
      makeRecord("valid-agent"),
      { spawnId: "bad-record" }, // Missing required fields
      { spawnId: "also-bad", claimId: 123 }, // Wrong type for claimId
    ];
    writeFileSync(filePath, JSON.stringify(records), "utf-8");

    const store = new FileSessionStore(dir);
    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.spawnId).toBe("valid-agent");
  });

  test("save creates parent directory if missing", () => {
    const dir = join(makeTmpDir(), "nested", "grove");
    tmpDirs.push(dir);
    const store = new FileSessionStore(dir);

    store.save(makeRecord("agent-1"));

    expect(existsSync(join(dir, "tui-sessions.json"))).toBe(true);
    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
  });

  test("full lifecycle: save, load, remove, load", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const store = new FileSessionStore(dir);

    // Save two records
    store.save(makeRecord("agent-a"));
    store.save(makeRecord("agent-b"));
    expect(store.loadAll()).toHaveLength(2);

    // Remove one
    store.remove("agent-a");
    const remaining = store.loadAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.spawnId).toBe("agent-b");

    // Remove last
    store.remove("agent-b");
    expect(store.loadAll()).toHaveLength(0);
  });
});

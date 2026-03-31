/**
 * Tests for trace persistence — save/load JSONL with real temp files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLogBuffer } from "./agent-log-buffer.js";
import { loadTraceHistory, saveTraceHistory } from "./trace-persistence.js";

let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `grove-persist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe("saveTraceHistory", () => {
  test("saves JSONL files per role", async () => {
    const buffers = new Map<string, AgentLogBuffer>();
    const buf = new AgentLogBuffer("coder", "sess-1");
    buf.push({ ts: 1000, line: "hello", type: "output" });
    buf.push({ ts: 2000, line: "[tool] Read x.ts", type: "tool" });
    buffers.set("coder", buf);

    await saveTraceHistory(testDir, "sess-1", buffers);

    const filePath = join(testDir, "agent-logs", "sess-1", "coder.jsonl");
    expect(existsSync(filePath)).toBe(true);

    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).line).toBe("hello");
    expect(JSON.parse(lines[1]!).line).toBe("[tool] Read x.ts");
  });

  test("saves multiple roles", async () => {
    const buffers = new Map<string, AgentLogBuffer>();

    const coder = new AgentLogBuffer("coder", "sess-1");
    coder.push({ ts: 1000, line: "coder line", type: "output" });
    buffers.set("coder", coder);

    const reviewer = new AgentLogBuffer("reviewer", "sess-1");
    reviewer.push({ ts: 2000, line: "reviewer line", type: "output" });
    buffers.set("reviewer", reviewer);

    await saveTraceHistory(testDir, "sess-1", buffers);

    const dir = join(testDir, "agent-logs", "sess-1");
    expect(existsSync(join(dir, "coder.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "reviewer.jsonl"))).toBe(true);
  });

  test("skips empty buffers", async () => {
    const buffers = new Map<string, AgentLogBuffer>();
    buffers.set("empty", new AgentLogBuffer("empty", "sess-1"));

    await saveTraceHistory(testDir, "sess-1", buffers);

    const dir = join(testDir, "agent-logs", "sess-1");
    expect(existsSync(join(dir, "empty.jsonl"))).toBe(false);
  });

  test("no-op for empty map", async () => {
    await saveTraceHistory(testDir, "sess-1", new Map());
    const dir = join(testDir, "agent-logs", "sess-1");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("loadTraceHistory", () => {
  test("loads JSONL files into buffers with historical flag", async () => {
    // First save, then load
    const buffers = new Map<string, AgentLogBuffer>();
    const buf = new AgentLogBuffer("coder", "sess-1");
    buf.push({ ts: 1000, line: "saved line", type: "tool" });
    buffers.set("coder", buf);
    await saveTraceHistory(testDir, "sess-1", buffers);

    const loaded = await loadTraceHistory(testDir, "sess-1");
    expect(loaded.size).toBe(1);
    const loadedBuf = loaded.get("coder")!;
    expect(loadedBuf.size).toBe(1);
    expect(loadedBuf.get(0)?.line).toBe("saved line");
    expect(loadedBuf.get(0)?.type).toBe("tool");
    expect(loadedBuf.get(0)?.historical).toBe(true);
  });

  test("returns empty map for nonexistent session", async () => {
    const loaded = await loadTraceHistory(testDir, "nonexistent");
    expect(loaded.size).toBe(0);
  });

  test("roundtrip preserves content", async () => {
    const buffers = new Map<string, AgentLogBuffer>();
    const buf = new AgentLogBuffer("coder", "sess-1");
    for (let i = 0; i < 10; i++) {
      buf.push({ ts: i * 1000, line: `line-${i}`, type: i % 2 === 0 ? "output" : "tool" });
    }
    buffers.set("coder", buf);
    await saveTraceHistory(testDir, "sess-1", buffers);

    const loaded = await loadTraceHistory(testDir, "sess-1");
    const loadedBuf = loaded.get("coder")!;
    expect(loadedBuf.size).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(loadedBuf.get(i)?.line).toBe(`line-${i}`);
    }
  });
});

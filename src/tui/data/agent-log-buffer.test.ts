/**
 * Tests for AgentLogBuffer — composition of RingBuffer + IncrementalLogReader.
 *
 * Covers: push, pushRawLines (filtering + classification), subscription batching,
 * serialization (toJsonl / loadFromJsonl), and pollLogFile integration.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLogBuffer, classifyLine, type LogLine } from "./agent-log-buffer.js";

// ===========================================================================
// classifyLine
// ===========================================================================

describe("classifyLine", () => {
  test("classifies tool calls", () => {
    expect(classifyLine("[tool] Read src/auth.ts (completed)")).toBe("tool");
    expect(classifyLine("[Tool] Edit file.ts")).toBe("tool");
  });

  test("classifies IPC messages", () => {
    expect(classifyLine("[IPC from reviewer] LGTM")).toBe("ipc");
    expect(classifyLine("[ipc] message received")).toBe("ipc");
  });

  test("classifies turn boundaries", () => {
    expect(classifyLine("[done] end_turn")).toBe("turn");
    expect(classifyLine("[end_turn]")).toBe("turn");
  });

  test("classifies regular output", () => {
    expect(classifyLine("Found 3 issues")).toBe("output");
    expect(classifyLine("Working on auth module")).toBe("output");
    expect(classifyLine("")).toBe("output");
  });
});

// ===========================================================================
// Push + basic API
// ===========================================================================

describe("AgentLogBuffer basics", () => {
  test("stores role and sessionId on instance", () => {
    const buf = new AgentLogBuffer("coder", "sess-123");
    expect(buf.role).toBe("coder");
    expect(buf.sessionId).toBe("sess-123");
  });

  test("push and get", () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    const line: LogLine = { ts: 1000, line: "hello", type: "output" };
    buf.push(line);
    expect(buf.size).toBe(1);
    expect(buf.get(0)).toEqual(line);
  });

  test("slice returns viewport", () => {
    const buf = new AgentLogBuffer("coder", "sess-1", 100);
    for (let i = 0; i < 50; i++) {
      buf.push({ ts: i, line: `line-${i}`, type: "output" });
    }
    const viewport = buf.slice(45, 50);
    expect(viewport.length).toBe(5);
    expect(viewport[0]?.line).toBe("line-45");
    expect(viewport[4]?.line).toBe("line-49");
  });

  test("toArray returns all lines", () => {
    const buf = new AgentLogBuffer("coder", "sess-1", 5);
    for (let i = 0; i < 3; i++) {
      buf.push({ ts: i, line: `line-${i}`, type: "output" });
    }
    expect(buf.toArray().length).toBe(3);
  });

  test("isEmpty is true when empty, false after push", () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    expect(buf.isEmpty).toBe(true);
    buf.push({ ts: 0, line: "x", type: "output" });
    expect(buf.isEmpty).toBe(false);
  });
});

// ===========================================================================
// pushRawLines — filtering + classification
// ===========================================================================

describe("pushRawLines", () => {
  test("filters noise lines and strips ANSI", () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    buf.pushRawLines([
      "[stderr] warning",
      "\x1b[32mGood output\x1b[0m",
      ">>> PROMPT",
      "Normal line",
      "",
    ]);
    const lines = buf.toArray();
    expect(lines.length).toBe(2);
    expect(lines[0]?.line).toBe("Good output");
    expect(lines[1]?.line).toBe("Normal line");
  });

  test("classifies lines automatically", () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    buf.pushRawLines([
      "[tool] Read file.ts",
      "Normal output",
      "[IPC from reviewer] LGTM",
      "[done] end_turn",
    ]);
    const lines = buf.toArray();
    expect(lines[0]?.type).toBe("tool");
    expect(lines[1]?.type).toBe("output");
    expect(lines[2]?.type).toBe("ipc");
    expect(lines[3]?.type).toBe("turn");
  });

  test("marks historical lines", () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    buf.pushRawLines(["old line"], true);
    const line = buf.get(0);
    expect(line?.historical).toBe(true);
  });

  test("non-historical lines have no historical flag", () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    buf.pushRawLines(["new line"]);
    const line = buf.get(0);
    expect(line?.historical).toBeUndefined();
  });
});

// ===========================================================================
// Subscription + batched flush (16ms debounce)
// ===========================================================================

describe("subscription batching", () => {
  test("listener is called after flush interval", async () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    let notifyCount = 0;
    buf.subscribe(() => {
      notifyCount++;
    });

    buf.push({ ts: 0, line: "a", type: "output" });
    buf.push({ ts: 1, line: "b", type: "output" });
    buf.push({ ts: 2, line: "c", type: "output" });

    // Not yet notified (batched)
    expect(notifyCount).toBe(0);

    // Wait for flush
    await new Promise((r) => setTimeout(r, 30));
    expect(notifyCount).toBe(1); // All 3 pushes batched into 1 notification
  });

  test("unsubscribe stops notifications", async () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    let notifyCount = 0;
    const listener = () => {
      notifyCount++;
    };
    buf.subscribe(listener);
    buf.unsubscribe(listener);

    buf.push({ ts: 0, line: "a", type: "output" });
    await new Promise((r) => setTimeout(r, 30));
    expect(notifyCount).toBe(0);
  });

  test("dispose stops all notifications and clears listeners", async () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    let notifyCount = 0;
    buf.subscribe(() => {
      notifyCount++;
    });

    buf.push({ ts: 0, line: "a", type: "output" });
    buf.dispose();

    await new Promise((r) => setTimeout(r, 30));
    expect(notifyCount).toBe(0);
  });
});

// ===========================================================================
// JSONL serialization
// ===========================================================================

describe("JSONL serialization", () => {
  test("toJsonl includes role and sessionId", () => {
    const buf = new AgentLogBuffer("coder", "sess-123");
    buf.push({ ts: 1711800000000, line: "hello", type: "output" });
    const jsonl = buf.toJsonl();
    const parsed = JSON.parse(jsonl);
    expect(parsed.role).toBe("coder");
    expect(parsed.sessionId).toBe("sess-123");
    expect(parsed.line).toBe("hello");
    expect(parsed.type).toBe("output");
    expect(typeof parsed.timestamp).toBe("string");
  });

  test("toJsonl produces one JSON object per line", () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    buf.push({ ts: 1000, line: "line1", type: "output" });
    buf.push({ ts: 2000, line: "line2", type: "tool" });
    const jsonl = buf.toJsonl();
    const lines = jsonl.split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).line).toBe("line1");
    expect(JSON.parse(lines[1]!).line).toBe("line2");
  });

  test("loadFromJsonl restores lines as historical", () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    const jsonl = [
      '{"timestamp":"2026-03-30T10:00:00.000Z","line":"restored line","type":"tool"}',
      '{"timestamp":"2026-03-30T10:00:01.000Z","line":"another line","type":"output"}',
    ].join("\n");
    buf.loadFromJsonl(jsonl);
    expect(buf.size).toBe(2);
    expect(buf.get(0)?.line).toBe("restored line");
    expect(buf.get(0)?.type).toBe("tool");
    expect(buf.get(0)?.historical).toBe(true);
    expect(buf.get(1)?.line).toBe("another line");
  });

  test("loadFromJsonl skips malformed lines", () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    const jsonl = [
      '{"line":"good","type":"output"}',
      "not json at all",
      '{"line":"also good","type":"tool"}',
    ].join("\n");
    buf.loadFromJsonl(jsonl);
    expect(buf.size).toBe(2);
  });

  test("roundtrip: toJsonl → loadFromJsonl preserves content", () => {
    const buf1 = new AgentLogBuffer("coder", "sess-1");
    buf1.push({ ts: 1000, line: "hello", type: "output" });
    buf1.push({ ts: 2000, line: "[tool] Read x.ts", type: "tool" });
    const jsonl = buf1.toJsonl();

    const buf2 = new AgentLogBuffer("coder", "sess-1");
    buf2.loadFromJsonl(jsonl);
    expect(buf2.size).toBe(2);
    expect(buf2.get(0)?.line).toBe("hello");
    expect(buf2.get(1)?.line).toBe("[tool] Read x.ts");
    expect(buf2.get(0)?.historical).toBe(true);
  });
});

// ===========================================================================
// pollLogFile integration
// ===========================================================================

describe("pollLogFile", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `grove-buf-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("reads new lines from log file incrementally", async () => {
    const logPath = join(testDir, "coder.log");
    writeFileSync(logPath, "line1\nline2\n", "utf-8");

    const buf = new AgentLogBuffer("coder", "sess-1");
    await buf.pollLogFile(logPath);
    expect(buf.size).toBe(2);

    appendFileSync(logPath, "line3\n");
    await buf.pollLogFile(logPath);
    expect(buf.size).toBe(3);
    expect(buf.get(2)?.line).toBe("line3");
  });

  test("filters noise lines during poll", async () => {
    const logPath = join(testDir, "coder.log");
    writeFileSync(logPath, "[stderr] warning\nGood output\n>>> PROMPT\n", "utf-8");

    const buf = new AgentLogBuffer("coder", "sess-1");
    await buf.pollLogFile(logPath);
    expect(buf.size).toBe(1);
    expect(buf.get(0)?.line).toBe("Good output");
  });
});

// ===========================================================================
// clear
// ===========================================================================

describe("clear", () => {
  test("clears all lines", () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    buf.push({ ts: 0, line: "x", type: "output" });
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.isEmpty).toBe(true);
  });
});

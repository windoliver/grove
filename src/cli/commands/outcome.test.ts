/**
 * Tests for grove outcome command.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { OutcomeStore } from "../../core/outcome.js";
import { SqliteOutcomeStore } from "../../local/sqlite-outcome-store.js";
import type { OutcomeDeps } from "./outcome.js";
import { parseOutcomeArgs, runOutcome } from "./outcome.js";

let db: Database;
let outcomeStore: OutcomeStore;
let deps: OutcomeDeps;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA busy_timeout = 5000");
  outcomeStore = new SqliteOutcomeStore(db);
  stdout = [];
  stderr = [];
  deps = {
    outcomeStore,
    stdout: (msg: string) => stdout.push(msg),
    stderr: (msg: string) => stderr.push(msg),
  };
});

afterEach(() => {
  outcomeStore.close();
  db.close();
});

// ---------------------------------------------------------------------------
// parseOutcomeArgs
// ---------------------------------------------------------------------------

describe("parseOutcomeArgs", () => {
  test("parses set subcommand with required args", () => {
    const args = parseOutcomeArgs(["set", "blake3:abc123", "accepted"]);
    expect(args.subcommand).toBe("set");
    if (args.subcommand === "set") {
      expect(args.cid).toBe("blake3:abc123");
      expect(args.status).toBe("accepted");
      expect(args.reason).toBeUndefined();
      expect(args.baseline).toBeUndefined();
    }
  });

  test("parses set subcommand with options", () => {
    const args = parseOutcomeArgs([
      "set",
      "blake3:abc123",
      "rejected",
      "--reason",
      "fails tests",
      "--baseline",
      "blake3:def456",
      "--evaluator",
      "test-agent",
    ]);
    expect(args.subcommand).toBe("set");
    if (args.subcommand === "set") {
      expect(args.cid).toBe("blake3:abc123");
      expect(args.status).toBe("rejected");
      expect(args.reason).toBe("fails tests");
      expect(args.baseline).toBe("blake3:def456");
      expect(args.evaluator).toBe("test-agent");
    }
  });

  test("parses list subcommand with defaults", () => {
    const args = parseOutcomeArgs(["list"]);
    expect(args.subcommand).toBe("list");
    if (args.subcommand === "list") {
      expect(args.limit).toBe(20);
      expect(args.json).toBe(false);
      expect(args.status).toBeUndefined();
    }
  });

  test("parses list subcommand with filters", () => {
    const args = parseOutcomeArgs(["list", "--status", "accepted", "-n", "5", "--json"]);
    expect(args.subcommand).toBe("list");
    if (args.subcommand === "list") {
      expect(args.status).toBe("accepted");
      expect(args.limit).toBe(5);
      expect(args.json).toBe(true);
    }
  });

  test("parses stats subcommand", () => {
    const args = parseOutcomeArgs(["stats"]);
    expect(args.subcommand).toBe("stats");
  });

  test("throws on unknown subcommand", () => {
    expect(() => parseOutcomeArgs(["unknown"])).toThrow("Unknown subcommand");
  });

  test("throws on missing subcommand", () => {
    expect(() => parseOutcomeArgs([])).toThrow("Unknown subcommand");
  });

  test("throws on missing set positionals", () => {
    expect(() => parseOutcomeArgs(["set"])).toThrow("Usage:");
    expect(() => parseOutcomeArgs(["set", "blake3:abc"])).toThrow("Usage:");
  });

  test("rejects invalid list limit", () => {
    expect(() => parseOutcomeArgs(["list", "-n", "abc"])).toThrow("Invalid limit");
    expect(() => parseOutcomeArgs(["list", "-n", "0"])).toThrow("Invalid limit");
  });
});

// ---------------------------------------------------------------------------
// runOutcome — set subcommand
// ---------------------------------------------------------------------------

describe("runOutcome set", () => {
  test("sets outcome with valid args", async () => {
    const args = parseOutcomeArgs([
      "set",
      "blake3:abc123def456",
      "accepted",
      "--evaluator",
      "operator-1",
    ]);
    await runOutcome(args, deps);

    expect(stdout.length).toBe(1);
    expect(stdout[0]).toContain("Outcome set:");
    expect(stdout[0]).toContain("accepted");
    expect(stdout[0]).toContain("operator-1");

    // Verify it was persisted
    const record = await outcomeStore.get("blake3:abc123def456");
    expect(record).toBeDefined();
    expect(record?.status).toBe("accepted");
    expect(record?.evaluatedBy).toBe("operator-1");
  });

  test("sets outcome with --reason and --baseline", async () => {
    const args = parseOutcomeArgs([
      "set",
      "blake3:abc123def456",
      "rejected",
      "--reason",
      "fails regression tests",
      "--baseline",
      "blake3:baseline789",
      "--evaluator",
      "operator-2",
    ]);
    await runOutcome(args, deps);

    expect(stdout.length).toBe(1);
    expect(stdout[0]).toContain("rejected");

    const record = await outcomeStore.get("blake3:abc123def456");
    expect(record).toBeDefined();
    expect(record?.reason).toBe("fails regression tests");
    expect(record?.baselineCid).toBe("blake3:baseline789");
  });

  test("rejects invalid status", async () => {
    const args = parseOutcomeArgs(["set", "blake3:abc123", "invalid-status", "--evaluator", "op"]);
    await runOutcome(args, deps);

    expect(stderr.length).toBe(1);
    expect(stderr[0]).toContain("invalid status");
    expect(stderr[0]).toContain("invalid-status");
    expect(stdout.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runOutcome — list subcommand
// ---------------------------------------------------------------------------

describe("runOutcome list", () => {
  test("outputs empty table when no outcomes", async () => {
    const args = parseOutcomeArgs(["list"]);
    await runOutcome(args, deps);

    expect(stdout.length).toBe(1);
    expect(stdout[0]).toContain("(no results)");
  });

  test("lists outcomes with --status filter", async () => {
    await outcomeStore.set("blake3:cid1aaaaaa", { status: "accepted", evaluatedBy: "agent-a" });
    await outcomeStore.set("blake3:cid2bbbbbb", { status: "rejected", evaluatedBy: "agent-b" });
    await outcomeStore.set("blake3:cid3cccccc", { status: "accepted", evaluatedBy: "agent-c" });

    const args = parseOutcomeArgs(["list", "--status", "accepted"]);
    await runOutcome(args, deps);

    const output = stdout.join("\n");
    expect(output).toContain("accepted");
    expect(output).not.toContain("rejected");
    // Both accepted CIDs should appear
    expect(output).toContain("cid1aaaaaa");
    expect(output).toContain("cid3cccccc");
  });

  test("outputs JSON when --json flag is set", async () => {
    await outcomeStore.set("blake3:jsontest123", { status: "crashed", evaluatedBy: "agent-x" });

    const args = parseOutcomeArgs(["list", "--json"]);
    await runOutcome(args, deps);

    const parsed = JSON.parse(stdout.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].cid).toBe("blake3:jsontest123");
    expect(parsed[0].status).toBe("crashed");
    expect(parsed[0].evaluatedBy).toBe("agent-x");
  });

  test("respects -n limit", async () => {
    await outcomeStore.set("blake3:lim1aaaaaa", { status: "accepted", evaluatedBy: "agent" });
    await outcomeStore.set("blake3:lim2bbbbbb", { status: "accepted", evaluatedBy: "agent" });
    await outcomeStore.set("blake3:lim3cccccc", { status: "accepted", evaluatedBy: "agent" });

    const args = parseOutcomeArgs(["list", "-n", "2", "--json"]);
    await runOutcome(args, deps);

    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runOutcome — stats subcommand
// ---------------------------------------------------------------------------

describe("runOutcome stats", () => {
  test("shows zero stats for empty store", async () => {
    const args = parseOutcomeArgs(["stats"]);
    await runOutcome(args, deps);

    const output = stdout.join("\n");
    expect(output).toContain("Outcome Statistics:");
    expect(output).toContain("Total:");
    expect(output).toContain("0");
  });

  test("shows aggregated stats with populated store", async () => {
    // 3 accepted, 2 rejected, 1 crashed, 1 invalidated = 7 total
    await outcomeStore.set("blake3:s1", { status: "accepted", evaluatedBy: "a" });
    await outcomeStore.set("blake3:s2", { status: "accepted", evaluatedBy: "a" });
    await outcomeStore.set("blake3:s3", { status: "accepted", evaluatedBy: "a" });
    await outcomeStore.set("blake3:s4", { status: "rejected", evaluatedBy: "a" });
    await outcomeStore.set("blake3:s5", { status: "rejected", evaluatedBy: "a" });
    await outcomeStore.set("blake3:s6", { status: "crashed", evaluatedBy: "a" });
    await outcomeStore.set("blake3:s7", { status: "invalidated", evaluatedBy: "a" });

    const args = parseOutcomeArgs(["stats"]);
    await runOutcome(args, deps);

    const output = stdout.join("\n");
    expect(output).toContain("Outcome Statistics:");
    expect(output).toContain("7");
    expect(output).toContain("Accepted:");
    expect(output).toContain("3");
    expect(output).toContain("42.9%");
    expect(output).toContain("Rejected:");
    expect(output).toContain("Crashed:");
    expect(output).toContain("Invalidated:");
  });
});

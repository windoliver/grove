/**
 * Tests for `grove discuss` command.
 *
 * Covers argument parsing, validation, and execution.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSqliteDb, SqliteContributionStore } from "../../local/sqlite-store.js";
import { executeContribute } from "./contribute.js";
import { executeDiscuss, handleDiscuss, parseDiscussArgs } from "./discuss.js";
import type { InitOptions } from "./init.js";
import { executeInit } from "./init.js";

const VALID_CID = `blake3:${"a".repeat(64)}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `grove-discuss-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeInitOptions(cwd: string): InitOptions {
  return {
    name: "test-grove",
    mode: "evaluation",
    seed: [],
    metric: [],
    force: false,
    agentOverrides: { agentId: "test-agent" },
    cwd,
  };
}

// ---------------------------------------------------------------------------
// parseDiscussArgs
// ---------------------------------------------------------------------------

describe("parseDiscussArgs", () => {
  test("parses root discussion (message only)", () => {
    const opts = parseDiscussArgs(["Should we use polling?"]);
    expect(opts.message).toBe("Should we use polling?");
    expect(opts.respondsTo).toBeUndefined();
  });

  test("parses reply (CID + message)", () => {
    const opts = parseDiscussArgs([VALID_CID, "I think push is better"]);
    expect(opts.respondsTo).toBe(VALID_CID);
    expect(opts.message).toBe("I think push is better");
  });

  test("parses --tag flag", () => {
    const opts = parseDiscussArgs(["--tag", "arch", "Topic question"]);
    expect(opts.tags).toEqual(["arch"]);
    expect(opts.message).toBe("Topic question");
  });

  test("parses multiple --tag flags", () => {
    const opts = parseDiscussArgs(["--tag", "arch", "--tag", "design", "Topic"]);
    expect(opts.tags).toEqual(["arch", "design"]);
  });

  test("parses --mode flag", () => {
    const opts = parseDiscussArgs(["--mode", "evaluation", "Topic"]);
    expect(opts.mode).toBe("evaluation");
  });

  test("parses --description flag", () => {
    const opts = parseDiscussArgs(["--description", "Detailed body", "Topic"]);
    expect(opts.description).toBe("Detailed body");
  });

  test("defaults mode to undefined (resolved to exploration later)", () => {
    const opts = parseDiscussArgs(["Topic"]);
    expect(opts.mode).toBeUndefined();
  });

  test("throws on empty args", () => {
    expect(() => parseDiscussArgs([])).toThrow("Usage:");
  });

  test("throws on empty message", () => {
    expect(() => parseDiscussArgs(["  "])).toThrow("empty");
  });

  test("throws on invalid mode", () => {
    expect(() => parseDiscussArgs(["--mode", "invalid", "Topic"])).toThrow("Invalid mode");
  });

  test("joins multiple positionals into root message", () => {
    const opts = parseDiscussArgs(["hello", "world"]);
    expect(opts.respondsTo).toBeUndefined();
    expect(opts.message).toBe("hello world");
  });

  test("joins extra positionals into reply message", () => {
    const opts = parseDiscussArgs([VALID_CID, "this", "needs", "work"]);
    expect(opts.respondsTo).toBe(VALID_CID);
    expect(opts.message).toBe("this needs work");
  });

  test("throws on CID with no message", () => {
    expect(() => parseDiscussArgs([VALID_CID])).toThrow("empty");
  });

  test("does not misclassify root messages that look like algo:hex", () => {
    const opts = parseDiscussArgs(["fix:deadbeef", "works"]);
    expect(opts.respondsTo).toBeUndefined();
    expect(opts.message).toBe("fix:deadbeef works");
  });

  test("rejects truncated blake3 CID intent", () => {
    expect(() => parseDiscussArgs(["blake3:abc123", "reply"])).toThrow("Invalid CID");
  });

  test("rejects mixed-hex blake3 CID intent", () => {
    expect(() => parseDiscussArgs(["blake3:abc123g", "reply"])).toThrow("Invalid CID");
  });

  test("rejects bare blake3 prefix intent", () => {
    expect(() => parseDiscussArgs(["blake3:", "reply"])).toThrow("Invalid CID");
  });

  test("rejects uppercase blake3 CID intent", () => {
    const uppercase = `blake3:${"A".repeat(64)}`;
    expect(() => parseDiscussArgs([uppercase, "reply"])).toThrow("Invalid CID");
  });

  test("rejects uppercase BLAKE3 prefix intent", () => {
    const uppercasePrefix = `BLAKE3:${"a".repeat(64)}`;
    expect(() => parseDiscussArgs([uppercasePrefix, "reply"])).toThrow("Invalid CID");
  });

  test("allows non-CID hash-prefixed root messages", () => {
    const opts = parseDiscussArgs(["sha256:collision", "risk"]);
    expect(opts.respondsTo).toBeUndefined();
    expect(opts.message).toBe("sha256:collision risk");
  });

  test("allows non-hex blake3-prefixed root messages with --root", () => {
    const opts = parseDiscussArgs(["--root", "blake3:algorithm", "notes"]);
    expect(opts.respondsTo).toBeUndefined();
    expect(opts.message).toBe("blake3:algorithm notes");
  });

  test("forces root parsing for canonical CID prefix when --root is set", () => {
    const opts = parseDiscussArgs(["--root", VALID_CID, "literal"]);
    expect(opts.respondsTo).toBeUndefined();
    expect(opts.message).toBe(`${VALID_CID} literal`);
  });
});

// ---------------------------------------------------------------------------
// executeDiscuss
// ---------------------------------------------------------------------------

describe("executeDiscuss", () => {
  test("creates a root discussion", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      const { cid } = await executeDiscuss({
        message: "Should we refactor the parser?",
        tags: [],
        groveOverride: join(dir, ".grove"),
      });

      expect(cid).toMatch(/^blake3:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates a reply discussion", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      // Create a root contribution to reply to
      const { cid: rootCid } = await executeContribute({
        kind: "work",
        mode: "evaluation",
        summary: "Root work",
        artifacts: [],
        fromGitTree: false,
        metric: [],
        score: [],
        tags: [],
        agentOverrides: { agentId: "test-agent" },
        cwd: dir,
      });

      const { cid } = await executeDiscuss({
        respondsTo: rootCid,
        message: "Great work, but consider edge cases",
        tags: ["review"],
        groveOverride: join(dir, ".grove"),
      });

      expect(cid).toMatch(/^blake3:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("respects grove default mode when --mode is omitted", async () => {
    const dir = await createTempDir();
    try {
      // Init a grove (default mode is "evaluation")
      await executeInit(makeInitOptions(dir));

      // Discuss without explicit --mode
      const { cid } = await executeDiscuss({
        message: "Topic without mode",
        tags: [],
        groveOverride: join(dir, ".grove"),
      });

      // Read back the stored contribution — should use resolveMode default ("evaluation"),
      // not a hardcoded "exploration"
      const dbPath = join(dir, ".grove", "grove.db");
      const db = initSqliteDb(dbPath);
      const store = new SqliteContributionStore(db);
      try {
        const contribution = await store.get(cid);
        expect(contribution).toBeDefined();
        expect(contribution?.mode).toBe("evaluation");
      } finally {
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates discussion with tags", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      const { cid } = await executeDiscuss({
        message: "Architecture decision needed",
        tags: ["architecture", "urgent"],
        groveOverride: join(dir, ".grove"),
      });

      expect(cid).toMatch(/^blake3:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// handleDiscuss
// ---------------------------------------------------------------------------

describe("handleDiscuss", () => {
  test("creates discussion via handleDiscuss with --grove override", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));
      const groveDir = join(dir, ".grove");

      await handleDiscuss(["A topic via handleDiscuss"], groveDir);

      // Verify it was stored
      const dbPath = join(groveDir, "grove.db");
      const db = initSqliteDb(dbPath);
      const store = new SqliteContributionStore(db);
      try {
        const all = await store.list({ kind: "discussion" });
        expect(all.length).toBeGreaterThanOrEqual(1);
        expect(all.some((c) => c.summary === "A topic via handleDiscuss")).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

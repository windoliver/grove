/**
 * Tests for `grove inbox` command — specifically the send path's
 * contract enforcement (Codex adversarial review finding #3).
 *
 * Before the fix, `grove inbox send` fed sendMessageAsDiscussion a
 * bare OperationDeps with no contract and no handoff store, so
 * GROVE.md role-kind rules did not apply to CLI message sends —
 * agents could bypass allowed_kinds=['work'] via the CLI even when
 * the same operation was blocked via MCP.
 *
 * These tests run the actual handleInbox function (not an internal
 * helper) so they exercise the full command bootstrap path: locate
 * .grove, open SQLite stores, read GROVE.md, wrap with
 * EnforcingContributionStore, build OperationDeps, call
 * sendMessageAsDiscussion.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSqliteDb, SqliteContributionStore } from "../../local/sqlite-store.js";
import { handleInbox } from "./inbox.js";
import type { InitOptions } from "./init.js";
import { executeInit } from "./init.js";

async function createTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `grove-inbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

/**
 * Capture console.error / console.log / process.exitCode for the
 * duration of a handleInbox call so we can observe the command's
 * side effects without mocking.
 */
async function runInbox(
  args: readonly string[],
  groveOverride: string,
): Promise<{ stdout: string[]; stderr: string[]; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...args) => {
    stdout.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = (...args) => {
    stderr.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    await handleInbox(args, groveOverride);
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  const exitCode = process.exitCode;
  process.exitCode = origExitCode;
  return { stdout, stderr, exitCode };
}

describe("grove inbox send — contract enforcement (Codex finding #3)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("succeeds when GROVE.md does not exist (no contract, no enforcement)", async () => {
    await executeInit(makeInitOptions(dir));
    // Overwrite the default GROVE.md with nothing by deleting it.
    await rm(join(dir, "GROVE.md"), { force: true });

    const { exitCode, stdout } = await runInbox(
      ["send", "plain body", "--to", "@reviewer", "--agent-id", "alice", "--json"],
      join(dir, ".grove"),
    );
    expect(exitCode).not.toBe(1);
    expect(stdout.join("\n")).toMatch(/"cid"\s*:/);
  });

  test("succeeds when contract allows discussion kind", async () => {
    await executeInit(makeInitOptions(dir));
    // Contract with no agent_constraints — everything allowed.
    await writeFile(
      join(dir, "GROVE.md"),
      `---
contract_version: 3
name: test-grove
mode: exploration
---
`,
      "utf-8",
    );

    const { exitCode } = await runInbox(
      ["send", "allowed body", "--to", "@reviewer", "--agent-id", "alice", "--json"],
      join(dir, ".grove"),
    );
    expect(exitCode).not.toBe(1);

    // Verify the contribution actually landed.
    const db = initSqliteDb(join(dir, ".grove", "grove.db"));
    const store = new SqliteContributionStore(db);
    try {
      const all = await store.list({ kind: "discussion" });
      expect(all.length).toBeGreaterThanOrEqual(1);
      expect(all.some((c) => c.context?.message_body === "allowed body")).toBe(true);
    } finally {
      store.close();
    }
  });

  // -------------------------------------------------------------------------
  // Codex finding #3 regression test: contract enforcement must apply to
  // the CLI inbox send path, not only the MCP path.
  // -------------------------------------------------------------------------
  test("rejects when contract restricts allowed_kinds to ['work']", async () => {
    await executeInit(makeInitOptions(dir));
    // Contract that blocks discussion contributions.
    await writeFile(
      join(dir, "GROVE.md"),
      `---
contract_version: 3
name: test-grove
mode: evaluation
agent_constraints:
  allowed_kinds: [work]
---
`,
      "utf-8",
    );

    const { exitCode, stderr } = await runInbox(
      [
        "send",
        "should-be-blocked",
        "--to",
        "@reviewer",
        "--agent-id",
        "alice",
        "--agent-name",
        "Alice",
      ],
      join(dir, ".grove"),
    );

    // Must fail with a non-zero exit.
    expect(exitCode).toBe(1);
    // Must surface the role_kind violation to stderr.
    expect(stderr.join("\n")).toMatch(/not allowed to submit kind 'discussion'/);

    // And crucially: NO discussion contribution should land in the DAG.
    const db = initSqliteDb(join(dir, ".grove", "grove.db"));
    const store = new SqliteContributionStore(db);
    try {
      const discussions = await store.list({ kind: "discussion" });
      expect(discussions).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

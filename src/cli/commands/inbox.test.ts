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
import {
  createSqliteStores,
  initSqliteDb,
  SqliteContributionStore,
} from "../../local/sqlite-store.js";
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
  process.exitCode = 0;
  console.log = (...args) => {
    stdout.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = (...args) => {
    stderr.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    await handleInbox(args, groveOverride);
    const exitCode = process.exitCode === 0 ? undefined : process.exitCode;
    return { stdout, stderr, exitCode };
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exitCode = origExitCode ?? 0;
  }
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
  // Codex round 3 finding #1: malformed GROVE.md must fail closed.
  //
  // An earlier version of this patch wrapped readFile + parseGroveContract
  // in one broad try/catch. A YAML syntax error was indistinguishable from
  // "file does not exist", so a broken contract silently fell through to
  // the unenforced path — reopening the exact bypass the enforcement fix
  // was supposed to close.
  //
  // Fix: only swallow ENOENT; let parse errors propagate. This test writes
  // a GROVE.md with invalid YAML and asserts handleInbox rejects the send
  // with an error (not a silent success).
  // -------------------------------------------------------------------------
  test("fails closed when GROVE.md is malformed (YAML parse error)", async () => {
    await executeInit(makeInitOptions(dir));
    // Malformed YAML frontmatter — unclosed bracket, invalid structure.
    await writeFile(
      join(dir, "GROVE.md"),
      `---
contract_version: 3
name: test-grove
mode: evaluation
agent_constraints:
  allowed_kinds: [work
---
`,
      "utf-8",
    );

    // handleInbox re-throws parse errors through to the CLI dispatcher;
    // the test wrapper captures uncaught rejections so we assert on that.
    let caughtError: unknown;
    try {
      await runInbox(
        ["send", "should-fail", "--to", "@reviewer", "--agent-id", "alice"],
        join(dir, ".grove"),
      );
    } catch (err) {
      caughtError = err;
    }

    // Either the command threw synchronously OR exited non-zero with an
    // error visible. In both cases: no discussion contribution landed.
    const db = initSqliteDb(join(dir, ".grove", "grove.db"));
    const store = new SqliteContributionStore(db);
    try {
      const discussions = await store.list({ kind: "discussion" });
      expect(discussions).toHaveLength(0);
    } finally {
      store.close();
    }

    // And we surfaced *some* signal of failure (thrown or exit=1).
    // The important property is: we did NOT silently succeed with no
    // enforcement — which is what the previous code did.
    expect(caughtError).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Codex round 2 finding #3: contract enforcement must apply to
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

describe("grove inbox — Nexus IPC delegation", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalNexusUrl: string | undefined;
  let originalNexusApiKey: string | undefined;
  let originalAgentId: string | undefined;
  let originalSessionId: string | undefined;

  beforeEach(async () => {
    dir = await createTempDir();
    originalFetch = globalThis.fetch;
    originalNexusUrl = process.env.GROVE_NEXUS_URL;
    originalNexusApiKey = process.env.NEXUS_API_KEY;
    originalAgentId = process.env.GROVE_AGENT_ID;
    originalSessionId = process.env.GROVE_SESSION_ID;
    process.env.GROVE_NEXUS_URL = "http://nexus.test";
    process.env.NEXUS_API_KEY = "secret";
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalNexusUrl === undefined) delete process.env.GROVE_NEXUS_URL;
    else process.env.GROVE_NEXUS_URL = originalNexusUrl;
    if (originalNexusApiKey === undefined) delete process.env.NEXUS_API_KEY;
    else process.env.NEXUS_API_KEY = originalNexusApiKey;
    if (originalAgentId === undefined) delete process.env.GROVE_AGENT_ID;
    else process.env.GROVE_AGENT_ID = originalAgentId;
    if (originalSessionId === undefined) delete process.env.GROVE_SESSION_ID;
    else process.env.GROVE_SESSION_ID = originalSessionId;
    await rm(dir, { recursive: true, force: true });
  });

  test("send writes a Grove-marked payload to Nexus IPC after contribution write", async () => {
    await executeInit(makeInitOptions(dir));
    await rm(join(dir, "GROVE.md"), { force: true });
    const fetched: string[] = [];
    const writes: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      fetched.push(url);
      if (url === "http://nexus.test/api/v2/files/write") {
        writes.push(JSON.parse(String(init?.body)));
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const { exitCode } = await runInbox(
      ["send", "nexus hello", "--to", "@reviewer", "--agent-id", "alice", "--json"],
      join(dir, ".grove"),
    );

    expect(exitCode).toBeUndefined();
    expect(fetched).toContain("http://nexus.test/api/v2/files/write");
    expect(writes).toHaveLength(1);
    const write = writes[0] as {
      readonly path: string;
      readonly content: string;
      readonly encoding: string;
    };
    expect(write.path).toMatch(/^\/ipc\/reviewer\/inbox\/.+\.json$/);
    expect(write.encoding).toBe("base64");
    const envelope = JSON.parse(Buffer.from(write.content, "base64").toString("utf8")) as {
      readonly sender: string;
      readonly recipient: string;
      readonly payload: {
        readonly kind: string;
        readonly body: string;
        readonly recipients: readonly string[];
        readonly from: { readonly agentId: string };
      };
    };
    expect(envelope.sender).toBe("alice");
    expect(envelope.recipient).toBe("reviewer");
    expect(envelope.payload).toMatchObject({
      kind: "grove.message",
      body: "nexus hello",
      recipients: ["@reviewer"],
      from: { agentId: "alice" },
    });
  });

  test("send uses session-scoped Nexus IPC path when GROVE_SESSION_ID is configured", async () => {
    await executeInit(makeInitOptions(dir));
    await rm(join(dir, "GROVE.md"), { force: true });
    let sessionId = "";
    const stores = createSqliteStores(join(dir, ".grove", "grove.db"));
    try {
      const session = await stores.goalSessionStore.createSession({ goal: "session cli inbox" });
      sessionId = session.id;
      process.env.GROVE_SESSION_ID = session.id;
    } finally {
      stores.close();
    }
    const writes: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      if (String(input) === "http://nexus.test/api/v2/files/write") {
        writes.push(JSON.parse(String(init?.body)));
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const { exitCode } = await runInbox(
      ["send", "session hello", "--to", "@reviewer", "--agent-id", "alice", "--json"],
      join(dir, ".grove"),
    );

    expect(exitCode).toBeUndefined();
    expect(writes).toHaveLength(1);
    const write = writes[0] as { readonly path: string };
    expect(write.path).toMatch(new RegExp(`^/sessions/${sessionId}/ipc/reviewer/inbox/.+\\.json$`));
  });

  test("read uses Nexus IPC inbox when Nexus env is configured", async () => {
    await executeInit(makeInitOptions(dir));
    process.env.GROVE_AGENT_ID = "bob";
    const fetched: string[] = [];
    globalThis.fetch = async (input) => {
      fetched.push(String(input));
      if (String(input).includes("/api/v2/ipc/inbox/bob")) {
        return new Response(
          JSON.stringify({
            messages: [
              {
                cid: "blake3:9999999999999999999999999999999999999999999999999999999999999999",
                from: { agentId: "alice" },
                body: "from nexus",
                recipients: ["@bob"],
                createdAt: "2026-05-12T12:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const { stdout, exitCode } = await runInbox(
      ["read", "--limit", "5", "--json"],
      join(dir, ".grove"),
    );

    expect(exitCode).toBeUndefined();
    expect(fetched).toContain("http://nexus.test/api/v2/ipc/inbox/bob?limit=5");
    expect(stdout.join("\n")).toContain("from nexus");
  });
});

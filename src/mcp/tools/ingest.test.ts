import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawnOrThrow } from "../../core/subprocess.js";
import type { McpDeps } from "../deps.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerIngestTools } from "./ingest.js";

/** Helper to call a tool handler directly. */
async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean | undefined; text: string }> {
  const registeredTools = (
    server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    }
  )._registeredTools;
  const tool = registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  const result = (await tool.handler(args)) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  return {
    isError: result.isError,
    text: result.content[0]?.text ?? "",
  };
}

/** Initialize a git repo in the given directory with a committed file. */
async function initGitRepo(dir: string): Promise<void> {
  await spawnOrThrow(["git", "init"], { cwd: dir }, "git init");
  await spawnOrThrow(["git", "config", "user.email", "test@test.com"], { cwd: dir });
  await spawnOrThrow(["git", "config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "hello.txt"), "hello world\n");
  await spawnOrThrow(["git", "add", "hello.txt"], { cwd: dir }, "git add");
  await spawnOrThrow(["git", "commit", "-m", "initial"], { cwd: dir }, "git commit");
}

// ---------------------------------------------------------------------------
// grove_cas_put
// ---------------------------------------------------------------------------

describe("grove_cas_put", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerIngestTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("stores inline utf8 content and returns hash", async () => {
    const result = await callTool(server, "grove_cas_put", {
      content: "hello world",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.hash).toMatch(/^blake3:[a-f0-9]{64}$/);

    // Verify content is retrievable
    const stored = await deps.cas.get(data.hash);
    expect(stored).toBeDefined();
    expect(new TextDecoder().decode(stored ?? new Uint8Array())).toBe("hello world");
  });

  test("stores base64-encoded content", async () => {
    const original = "binary content here";
    const b64 = btoa(original);

    const result = await callTool(server, "grove_cas_put", {
      content: b64,
      encoding: "base64",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.hash).toMatch(/^blake3:[a-f0-9]{64}$/);

    const stored = await deps.cas.get(data.hash);
    expect(new TextDecoder().decode(stored ?? new Uint8Array())).toBe(original);
  });

  test("stores content from a file path", async () => {
    const filePath = join(testDeps.tempDir, "test-file.txt");
    await writeFile(filePath, "file content");

    const result = await callTool(server, "grove_cas_put", {
      filePath,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.hash).toMatch(/^blake3:[a-f0-9]{64}$/);

    const stored = await deps.cas.get(data.hash);
    expect(new TextDecoder().decode(stored ?? new Uint8Array())).toBe("file content");
  });

  test("stores content with mediaType", async () => {
    const result = await callTool(server, "grove_cas_put", {
      content: '{"key": "value"}',
      mediaType: "application/json",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.hash).toMatch(/^blake3:[a-f0-9]{64}$/);

    const stat = await deps.cas.stat(data.hash);
    expect(stat).toBeDefined();
    expect(stat?.mediaType).toBe("application/json");
  });

  test("returns error when both content and filePath are provided", async () => {
    const result = await callTool(server, "grove_cas_put", {
      content: "hello",
      filePath: "/some/path",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("VALIDATION_ERROR");
    expect(result.text).toContain("not both");
  });

  test("returns error when neither content nor filePath is provided", async () => {
    const result = await callTool(server, "grove_cas_put", {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain("VALIDATION_ERROR");
  });

  test("returns error for non-existent file path within boundary", async () => {
    const result = await callTool(server, "grove_cas_put", {
      filePath: join(testDeps.tempDir, "nonexistent-file-12345.txt"),
    });

    expect(result.isError).toBe(true);
  });

  test("is idempotent — same content produces same hash", async () => {
    const result1 = await callTool(server, "grove_cas_put", { content: "dedup me" });
    const result2 = await callTool(server, "grove_cas_put", { content: "dedup me" });

    const hash1 = JSON.parse(result1.text).hash;
    const hash2 = JSON.parse(result2.text).hash;
    expect(hash1).toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// grove_ingest_git_diff
// ---------------------------------------------------------------------------

describe("grove_ingest_git_diff", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerIngestTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns empty artifacts for clean working tree", async () => {
    await initGitRepo(testDeps.tempDir);

    const result = await callTool(server, "grove_ingest_git_diff", {
      cwd: testDeps.tempDir,
      ref: "HEAD",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.artifacts).toEqual({});
  });

  test("ingests diff when working tree has changes", async () => {
    await initGitRepo(testDeps.tempDir);
    // Modify the tracked file
    await writeFile(join(testDeps.tempDir, "hello.txt"), "modified content\n");

    const result = await callTool(server, "grove_ingest_git_diff", {
      cwd: testDeps.tempDir,
      ref: "HEAD",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.artifacts.diff).toMatch(/^blake3:[a-f0-9]{64}$/);

    // Verify stored diff contains the modification
    const stored = await deps.cas.get(data.artifacts.diff);
    expect(stored).toBeDefined();
    const diffText = new TextDecoder().decode(stored ?? new Uint8Array());
    expect(diffText).toContain("modified content");
  });

  test("defaults ref to HEAD when not specified", async () => {
    await initGitRepo(testDeps.tempDir);
    // Modify a file so the diff is non-empty
    await writeFile(join(testDeps.tempDir, "hello.txt"), "changed\n");

    const result = await callTool(server, "grove_ingest_git_diff", {
      cwd: testDeps.tempDir,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    // ref defaults to "HEAD", so the diff captures the change
    expect(data.artifacts.diff).toMatch(/^blake3:[a-f0-9]{64}$/);
  });

  test("returns error for non-git directory", async () => {
    // testDeps.tempDir is not a git repo by default
    const result = await callTool(server, "grove_ingest_git_diff", {
      cwd: testDeps.tempDir,
      ref: "HEAD",
    });

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// grove_ingest_git_tree
// ---------------------------------------------------------------------------

describe("grove_ingest_git_tree", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerIngestTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("ingests all tracked files from a git repo", async () => {
    await initGitRepo(testDeps.tempDir);

    const result = await callTool(server, "grove_ingest_git_tree", {
      cwd: testDeps.tempDir,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.artifacts["hello.txt"]).toMatch(/^blake3:[a-f0-9]{64}$/);

    // Verify stored content
    const stored = await deps.cas.get(data.artifacts["hello.txt"]);
    expect(new TextDecoder().decode(stored ?? new Uint8Array())).toBe("hello world\n");
  });

  test("ingests multiple files", async () => {
    await initGitRepo(testDeps.tempDir);
    await writeFile(join(testDeps.tempDir, "second.txt"), "second file\n");
    await spawnOrThrow(["git", "add", "second.txt"], { cwd: testDeps.tempDir });
    await spawnOrThrow(["git", "commit", "-m", "add second"], { cwd: testDeps.tempDir });

    const result = await callTool(server, "grove_ingest_git_tree", {
      cwd: testDeps.tempDir,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(Object.keys(data.artifacts)).toContain("hello.txt");
    expect(Object.keys(data.artifacts)).toContain("second.txt");
  });

  test("returns error for non-git directory", async () => {
    const result = await callTool(server, "grove_ingest_git_tree", {
      cwd: testDeps.tempDir,
    });

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Path boundary validation (CRIT-1)
// ---------------------------------------------------------------------------

describe("grove_cas_put path boundary validation", () => {
  let testDeps: TestMcpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerIngestTools(server, testDeps.deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("rejects filePath outside workspace boundary", async () => {
    const result = await callTool(server, "grove_cas_put", {
      filePath: "/etc/passwd",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Path containment violation");
  });

  test("accepts filePath within workspace boundary", async () => {
    const filePath = join(testDeps.tempDir, "safe-file.txt");
    await writeFile(filePath, "safe content");

    const result = await callTool(server, "grove_cas_put", {
      filePath,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.hash).toMatch(/^blake3:[a-f0-9]{64}$/);
  });

  test("rejects path traversal via ../", async () => {
    const result = await callTool(server, "grove_cas_put", {
      filePath: `${testDeps.tempDir}/../../../etc/passwd`,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Path containment violation");
  });
});

describe("grove_ingest_git_diff cwd boundary validation", () => {
  let testDeps: TestMcpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerIngestTools(server, testDeps.deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("rejects cwd outside workspace boundary", async () => {
    const result = await callTool(server, "grove_ingest_git_diff", {
      cwd: "/tmp/evil",
      ref: "HEAD",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Path containment violation");
  });
});

describe("grove_ingest_git_tree cwd boundary validation", () => {
  let testDeps: TestMcpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerIngestTools(server, testDeps.deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("rejects cwd outside workspace boundary", async () => {
    const result = await callTool(server, "grove_ingest_git_tree", {
      cwd: "/tmp/evil",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Path containment violation");
  });
});

/**
 * Tests for grove_eval MCP tool and evalOperation.
 *
 * Covers:
 * 1. Success path: valid command emitting GROVE_SCORE lines
 * 2. evalCommand override respected
 * 3. Invalid/missing targetCid → VALIDATION_ERROR
 * 4. Missing evalCommand → VALIDATION_ERROR
 * 5. Subprocess timeout → timedOut: true
 * 6. Non-zero exit code preserved in result
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "../deps.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerEvalTools } from "./eval.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("grove_eval", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerEvalTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  // 1. Success path: command emits GROVE_SCORE lines
  test("returns parsed scores for valid GROVE_SCORE output", async () => {
    const result = await callTool(server, "grove_eval", {
      targetCid: "blake3:abc123",
      evalCommand: "echo 'GROVE_SCORE val_bpb=0.92' && echo 'GROVE_SCORE peak_vram_gb=14.3'",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.timedOut).toBe(false);
    expect(data.exitCode).toBe(0);
    expect(data.scores).toHaveLength(2);
    expect(data.scores).toContainEqual({ metric: "val_bpb", value: 0.92 });
    expect(data.scores).toContainEqual({ metric: "peak_vram_gb", value: 14.3 });
  });

  // 2. evalCommand override respected (GROVE_TARGET_CID env var available)
  test("passes GROVE_TARGET_CID as env var to the subprocess", async () => {
    const result = await callTool(server, "grove_eval", {
      targetCid: "blake3:deadbeef",
      // Output a score only if GROVE_TARGET_CID is set and non-empty
      evalCommand: 'test -n "$GROVE_TARGET_CID" && echo "GROVE_SCORE env_set=1"',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.exitCode).toBe(0);
    expect(data.scores).toContainEqual({ metric: "env_set", value: 1 });
  });

  // 3. Missing / empty targetCid → VALIDATION_ERROR
  test("returns VALIDATION_ERROR for empty targetCid", async () => {
    const result = await callTool(server, "grove_eval", {
      targetCid: "   ",
      evalCommand: "echo ok",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("VALIDATION_ERROR");
    expect(result.text).toContain("targetCid");
  });

  // 4. Missing evalCommand → VALIDATION_ERROR
  test("returns VALIDATION_ERROR when evalCommand is absent", async () => {
    const result = await callTool(server, "grove_eval", {
      targetCid: "blake3:abc123",
      // evalCommand intentionally omitted
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("VALIDATION_ERROR");
    expect(result.text).toContain("evalCommand");
  });

  // 5. Subprocess timeout → timedOut: true
  test("returns timedOut=true when subprocess exceeds timeoutMs", async () => {
    const result = await callTool(server, "grove_eval", {
      targetCid: "blake3:abc123",
      evalCommand: "sleep 60",
      timeoutMs: 500, // very short timeout
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.timedOut).toBe(true);
    // exit code 124 is conventional for timeout-killed processes
    expect(data.exitCode).toBe(124);
  }, 10_000); // generous wall-clock timeout for this test

  // 6. Non-zero exit code preserved (scores still returned if any were emitted)
  test("preserves non-zero exit code in result", async () => {
    const result = await callTool(server, "grove_eval", {
      targetCid: "blake3:abc123",
      evalCommand: "echo 'GROVE_SCORE accuracy=0.75' && exit 2",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.exitCode).toBe(2);
    expect(data.timedOut).toBe(false);
    // Score emitted before exit still captured
    expect(data.scores).toContainEqual({ metric: "accuracy", value: 0.75 });
  });
});

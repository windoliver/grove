import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeContribution } from "../../core/test-helpers.js";
import type { McpDeps } from "../deps.js";
import { McpErrorCode } from "../error-handler.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps, storeTestContent } from "../test-helpers.js";
import { registerWorkspaceTools } from "./workspace.js";

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

describe("grove_checkout", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerWorkspaceTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("checks out a contribution with artifacts", async () => {
    const hash = await storeTestContent(deps.cas, "file content");
    const c = makeContribution({
      summary: "Work with artifacts",
      artifacts: { "file.txt": hash },
    });
    await deps.contributionStore.put(c);

    const result = await callTool(server, "grove_checkout", {
      cid: c.cid,
      agent: { agentId: "agent-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.cid).toBe(c.cid);
    expect(data.workspacePath).toBeDefined();
    expect(data.status).toBe("active");
    expect(data.artifactCount).toBe(1);
  });

  test("returns not-found for non-existent CID", async () => {
    const result = await callTool(server, "grove_checkout", {
      cid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      agent: { agentId: "agent-1" },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(McpErrorCode.NotFound);
  });

  test("is idempotent for same agent and CID", async () => {
    const hash = await storeTestContent(deps.cas, "content");
    const c = makeContribution({
      summary: "Idempotent test",
      artifacts: { "data.txt": hash },
    });
    await deps.contributionStore.put(c);

    // First checkout
    const result1 = await callTool(server, "grove_checkout", {
      cid: c.cid,
      agent: { agentId: "agent-1" },
    });
    const data1 = JSON.parse(result1.text);

    // Second checkout — should return same workspace
    const result2 = await callTool(server, "grove_checkout", {
      cid: c.cid,
      agent: { agentId: "agent-1" },
    });
    const data2 = JSON.parse(result2.text);

    expect(data1.workspacePath).toBe(data2.workspacePath);
  });

  test("checks out contribution with no artifacts", async () => {
    const c = makeContribution({
      summary: "No artifacts",
      artifacts: {},
    });
    await deps.contributionStore.put(c);

    const result = await callTool(server, "grove_checkout", {
      cid: c.cid,
      agent: { agentId: "agent-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.artifactCount).toBe(0);
  });
});

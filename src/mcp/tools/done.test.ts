import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "../deps.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerDoneTools } from "./done.js";

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

describe("grove_done", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerDoneTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("binds done identity to the MCP process env", async () => {
    const originalAgentId = process.env.GROVE_AGENT_ID;
    const originalRole = process.env.GROVE_AGENT_ROLE;
    process.env.GROVE_AGENT_ID = "reviewer-runtime";
    process.env.GROVE_AGENT_ROLE = "reviewer";

    try {
      const result = await callTool(server, "grove_done", {
        summary: "Approved",
        agent: { agentId: "coder-spoof", role: "coder" },
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.text) as { cid: string };
      const stored = await deps.contributionStore.get(data.cid);
      expect(stored?.kind).toBe("discussion");
      expect(stored?.context?.done).toBe(true);
      expect(stored?.agent.agentId).toBe("reviewer-runtime");
      expect(stored?.agent.role).toBe("reviewer");
    } finally {
      if (originalAgentId === undefined) delete process.env.GROVE_AGENT_ID;
      else process.env.GROVE_AGENT_ID = originalAgentId;
      if (originalRole === undefined) delete process.env.GROVE_AGENT_ROLE;
      else process.env.GROVE_AGENT_ROLE = originalRole;
    }
  });
});

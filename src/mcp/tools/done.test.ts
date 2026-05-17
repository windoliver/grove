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

const agentArgs = { agentId: "test-agent", role: "reviewer" };

describe("grove_done — AgentTask bridge", () => {
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

  test("when GROVE_AGENT_TASK_ID set, POSTs /done before contributeOperation", async () => {
    const originalEnv = {
      taskId: process.env.GROVE_AGENT_TASK_ID,
      gen: process.env.GROVE_AGENT_TASK_GENERATION,
      url: process.env.GROVE_SERVER_URL,
      token: process.env.GROVE_API_TOKEN,
    };
    process.env.GROVE_AGENT_TASK_ID = "task-1";
    process.env.GROVE_AGENT_TASK_GENERATION = "1";
    process.env.GROVE_SERVER_URL = "http://localhost:4515";
    process.env.GROVE_API_TOKEN = "tok";

    const order: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      order.push(`fetch ${String(input)}`);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const result = await callTool(server, "grove_done", {
        summary: "looks good",
        agent: agentArgs,
      });

      expect(result.isError).toBeUndefined();
      // fetch came first
      expect(order.length).toBe(1);
      expect(order[0]).toContain("http://localhost:4515/api/agent-tasks/task-1/done");
      // contribution was still written
      const data = JSON.parse(result.text) as { cid: string };
      const stored = await deps.contributionStore.get(data.cid);
      expect(stored?.context?.done).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnv.taskId === undefined) delete process.env.GROVE_AGENT_TASK_ID;
      else process.env.GROVE_AGENT_TASK_ID = originalEnv.taskId;
      if (originalEnv.gen === undefined) delete process.env.GROVE_AGENT_TASK_GENERATION;
      else process.env.GROVE_AGENT_TASK_GENERATION = originalEnv.gen;
      if (originalEnv.url === undefined) delete process.env.GROVE_SERVER_URL;
      else process.env.GROVE_SERVER_URL = originalEnv.url;
      if (originalEnv.token === undefined) delete process.env.GROVE_API_TOKEN;
      else process.env.GROVE_API_TOKEN = originalEnv.token;
    }
  });

  test("when env vars absent, no fetch and contribution still writes (back-compat)", async () => {
    const original = process.env.GROVE_AGENT_TASK_ID;
    delete process.env.GROVE_AGENT_TASK_ID;

    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const result = await callTool(server, "grove_done", {
        summary: "no task context",
        agent: agentArgs,
      });

      expect(fetched).toBe(false);
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.text) as { cid: string };
      const stored = await deps.contributionStore.get(data.cid);
      expect(stored?.context?.done).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (original !== undefined) process.env.GROVE_AGENT_TASK_ID = original;
    }
  });

  test("POST failure logs warning but contribution still writes", async () => {
    const originalEnv = {
      taskId: process.env.GROVE_AGENT_TASK_ID,
      gen: process.env.GROVE_AGENT_TASK_GENERATION,
      url: process.env.GROVE_SERVER_URL,
      token: process.env.GROVE_API_TOKEN,
    };
    process.env.GROVE_AGENT_TASK_ID = "task-1";
    process.env.GROVE_AGENT_TASK_GENERATION = "1";
    process.env.GROVE_SERVER_URL = "http://localhost:4515";
    process.env.GROVE_API_TOKEN = "tok";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("server down", { status: 500 })) as typeof fetch;

    try {
      const result = await callTool(server, "grove_done", {
        summary: "done despite server error",
        agent: agentArgs,
      });

      // must not throw — tool should swallow the POST failure
      expect(result.isError).toBeUndefined();
      // contribution was still written
      const data = JSON.parse(result.text) as { cid: string };
      const stored = await deps.contributionStore.get(data.cid);
      expect(stored?.context?.done).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnv.taskId === undefined) delete process.env.GROVE_AGENT_TASK_ID;
      else process.env.GROVE_AGENT_TASK_ID = originalEnv.taskId;
      if (originalEnv.gen === undefined) delete process.env.GROVE_AGENT_TASK_GENERATION;
      else process.env.GROVE_AGENT_TASK_GENERATION = originalEnv.gen;
      if (originalEnv.url === undefined) delete process.env.GROVE_SERVER_URL;
      else process.env.GROVE_SERVER_URL = originalEnv.url;
      if (originalEnv.token === undefined) delete process.env.GROVE_API_TOKEN;
      else process.env.GROVE_API_TOKEN = originalEnv.token;
    }
  });
});

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

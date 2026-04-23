import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "../deps.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerPlanTools } from "./plans.js";

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

describe("grove plan tools", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerPlanTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("grove_update_plan keeps previous tags when tags are omitted", async () => {
    const createResult = await callTool(server, "grove_create_plan", {
      title: "Plan A",
      tasks: [{ id: "t1", title: "Task 1", status: "todo" }],
      tags: ["alpha"],
    });
    expect(createResult.isError).toBeUndefined();
    const createData = JSON.parse(createResult.text) as { cid: string };

    const updateResult = await callTool(server, "grove_update_plan", {
      previous_plan_cid: createData.cid,
      tasks: [{ id: "t1", title: "Task 1", status: "in_progress" }],
    });
    expect(updateResult.isError).toBeUndefined();
    const updateData = JSON.parse(updateResult.text) as { cid: string };

    const updated = await deps.contributionStore.get(updateData.cid);
    expect(updated).toBeDefined();
    expect(updated?.tags).toContain("alpha");
    expect(updated?.tags).toContain("plan");
    expect(updated?.tags.filter((tag) => tag === "plan")).toHaveLength(1);
  });

  test("grove_update_plan replaces tags when explicit tags are provided", async () => {
    const createResult = await callTool(server, "grove_create_plan", {
      title: "Plan B",
      tasks: [{ id: "t1", title: "Task 1", status: "todo" }],
      tags: ["alpha"],
    });
    expect(createResult.isError).toBeUndefined();
    const createData = JSON.parse(createResult.text) as { cid: string };

    const updateResult = await callTool(server, "grove_update_plan", {
      previous_plan_cid: createData.cid,
      tasks: [{ id: "t1", title: "Task 1", status: "done" }],
      tags: ["beta"],
    });
    expect(updateResult.isError).toBeUndefined();
    const updateData = JSON.parse(updateResult.text) as { cid: string };

    const updated = await deps.contributionStore.get(updateData.cid);
    expect(updated).toBeDefined();
    expect(updated?.tags).toContain("beta");
    expect(updated?.tags).toContain("plan");
    expect(updated?.tags).not.toContain("alpha");
  });
});

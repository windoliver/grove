import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SqliteGoalSessionStore } from "../../local/sqlite-goal-session-store.js";
import { initSqliteDb } from "../../local/sqlite-store.js";
import type { McpDeps } from "../deps.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerGoalTools } from "./goal.js";

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

describe("grove_goal", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    // Attach a GoalSessionStore to the deps (not created by default in test helpers)
    const db = initSqliteDb(`${testDeps.tempDir}/goal-session.db`);
    const goalSessionStore = new SqliteGoalSessionStore(db);
    deps = { ...testDeps.deps, goalSessionStore };
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerGoalTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns 'No goal set' when no goal exists", async () => {
    const result = await callTool(server, "grove_goal", {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.message).toBe("No goal set");
  });

  test("returns NOT_CONFIGURED when goalSessionStore is missing", async () => {
    const serverNoStore = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerGoalTools(serverNoStore, testDeps.deps); // deps without goalSessionStore

    const result = await callTool(serverNoStore, "grove_goal", {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain("NOT_CONFIGURED");
  });

  test("returns the current goal after it has been set", async () => {
    // Set a goal first
    await callTool(server, "grove_set_goal", {
      goal: "Ship feature X",
      acceptance: ["Tests pass", "Docs updated"],
    });

    const result = await callTool(server, "grove_goal", {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.goal).toBe("Ship feature X");
    expect(data.acceptance).toEqual(["Tests pass", "Docs updated"]);
    expect(data.status).toBe("active");
  });
});

describe("grove_set_goal", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    const db = initSqliteDb(`${testDeps.tempDir}/goal-session.db`);
    const goalSessionStore = new SqliteGoalSessionStore(db);
    deps = { ...testDeps.deps, goalSessionStore };
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerGoalTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("sets a goal with valid input", async () => {
    const result = await callTool(server, "grove_set_goal", {
      goal: "Implement search feature",
      acceptance: ["Unit tests added", "API docs updated"],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.goal).toBe("Implement search feature");
    expect(data.acceptance).toEqual(["Unit tests added", "API docs updated"]);
    expect(data.status).toBe("active");
    expect(data.setBy).toBe("mcp");
    expect(typeof data.setAt).toBe("string");
  });

  test("sets a goal with empty acceptance array", async () => {
    const result = await callTool(server, "grove_set_goal", {
      goal: "Quick fix",
      acceptance: [],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.goal).toBe("Quick fix");
    expect(data.acceptance).toEqual([]);
  });

  test("replaces an existing goal on second call", async () => {
    await callTool(server, "grove_set_goal", {
      goal: "Goal v1",
      acceptance: ["Criterion A"],
    });

    const result = await callTool(server, "grove_set_goal", {
      goal: "Goal v2",
      acceptance: ["Criterion B", "Criterion C"],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.goal).toBe("Goal v2");
    expect(data.acceptance).toEqual(["Criterion B", "Criterion C"]);

    // Verify via grove_goal read
    const readResult = await callTool(server, "grove_goal", {});
    const readData = JSON.parse(readResult.text);
    expect(readData.goal).toBe("Goal v2");
  });

  test("returns NOT_CONFIGURED when goalSessionStore is missing", async () => {
    const serverNoStore = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerGoalTools(serverNoStore, testDeps.deps);

    const result = await callTool(serverNoStore, "grove_set_goal", {
      goal: "Some goal",
      acceptance: [],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("NOT_CONFIGURED");
  });
});

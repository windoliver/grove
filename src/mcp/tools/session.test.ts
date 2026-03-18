import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SqliteGoalSessionStore } from "../../local/sqlite-goal-session-store.js";
import { initSqliteDb } from "../../local/sqlite-store.js";
import type { McpDeps } from "../deps.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerSessionTools } from "./session.js";

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

describe("grove_list_sessions", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    const db = initSqliteDb(`${testDeps.tempDir}/goal-session.db`);
    const goalSessionStore = new SqliteGoalSessionStore(db);
    deps = { ...testDeps.deps, goalSessionStore };
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerSessionTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns empty list when no sessions exist", async () => {
    const result = await callTool(server, "grove_list_sessions", {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.count).toBe(0);
    expect(data.sessions).toEqual([]);
  });

  test("returns sessions after creating them", async () => {
    await callTool(server, "grove_create_session", { goal: "Session A" });
    await callTool(server, "grove_create_session", { goal: "Session B" });

    const result = await callTool(server, "grove_list_sessions", {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.count).toBe(2);
    expect(data.sessions.length).toBe(2);
  });

  test("returns NOT_CONFIGURED when goalSessionStore is missing", async () => {
    const serverNoStore = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerSessionTools(serverNoStore, testDeps.deps);

    const result = await callTool(serverNoStore, "grove_list_sessions", {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain("NOT_CONFIGURED");
  });
});

describe("grove_create_session", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    const db = initSqliteDb(`${testDeps.tempDir}/goal-session.db`);
    const goalSessionStore = new SqliteGoalSessionStore(db);
    deps = { ...testDeps.deps, goalSessionStore };
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerSessionTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("creates a session without a goal", async () => {
    const result = await callTool(server, "grove_create_session", {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.sessionId).toBeTruthy();
    expect(typeof data.sessionId).toBe("string");
    expect(data.status).toBe("active");
    expect(data.contributionCount).toBe(0);
    expect(typeof data.startedAt).toBe("string");
  });

  test("creates a session with a goal", async () => {
    const result = await callTool(server, "grove_create_session", {
      goal: "Fix all the bugs",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.goal).toBe("Fix all the bugs");
    expect(data.status).toBe("active");
  });

  test("returns NOT_CONFIGURED when goalSessionStore is missing", async () => {
    const serverNoStore = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerSessionTools(serverNoStore, testDeps.deps);

    const result = await callTool(serverNoStore, "grove_create_session", {
      goal: "Some goal",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("NOT_CONFIGURED");
  });
});

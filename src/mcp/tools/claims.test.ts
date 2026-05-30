import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "../deps.js";
import { McpErrorCode } from "../error-handler.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerClaimTools } from "./claims.js";

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

describe("grove_claim", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerClaimTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("creates a new claim", async () => {
    const result = await callTool(server, "grove_claim", {
      targetRef: "task-1",
      agent: { agentId: "agent-1" },
      intentSummary: "Working on task-1",
      leaseDurationMs: 300_000,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.targetRef).toBe("task-1");
    expect(data.status).toBe("active");
    expect(data.agentId).toBe("agent-1");
  });

  test("renews an existing claim by the same agent", async () => {
    // Create initial claim
    await callTool(server, "grove_claim", {
      targetRef: "task-1",
      agent: { agentId: "agent-1" },
      intentSummary: "Working on task-1",
      leaseDurationMs: 300_000,
    });

    // Renew
    const result = await callTool(server, "grove_claim", {
      targetRef: "task-1",
      agent: { agentId: "agent-1" },
      intentSummary: "Still working on task-1",
      leaseDurationMs: 600_000,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.status).toBe("active");
  });

  test("rejects claim by different agent on same target", async () => {
    // Agent 1 claims
    await callTool(server, "grove_claim", {
      targetRef: "task-1",
      agent: { agentId: "agent-1" },
      intentSummary: "Agent 1 is working",
      leaseDurationMs: 300_000,
    });

    // Agent 2 tries to claim same target
    const result = await callTool(server, "grove_claim", {
      targetRef: "task-1",
      agent: { agentId: "agent-2" },
      intentSummary: "Agent 2 wants to work",
      leaseDurationMs: 300_000,
    });

    expect(result.isError).toBe(true);
  });

  test("claim conflict error includes structured details", async () => {
    // Agent 1 claims
    await callTool(server, "grove_claim", {
      targetRef: "task-1",
      agent: { agentId: "agent-1" },
      intentSummary: "Agent 1 is working",
      leaseDurationMs: 300_000,
    });

    // Agent 2 tries same target — check error format
    const result = await callTool(server, "grove_claim", {
      targetRef: "task-1",
      agent: { agentId: "agent-2" },
      intentSummary: "Agent 2 wants to work",
      leaseDurationMs: 300_000,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(McpErrorCode.ClaimConflict);
    expect(result.text).toContain("task-1");
    expect(result.text).toContain("agent-1");
  });

  test("claim conflict error includes holding agent's claim ID", async () => {
    const createResult = await callTool(server, "grove_claim", {
      targetRef: "task-1",
      agent: { agentId: "agent-1" },
      intentSummary: "Agent 1 is working",
      leaseDurationMs: 300_000,
    });
    const holdingClaimId = JSON.parse(createResult.text).claimId;

    const result = await callTool(server, "grove_claim", {
      targetRef: "task-1",
      agent: { agentId: "agent-2" },
      intentSummary: "Agent 2 wants to work",
      leaseDurationMs: 300_000,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(holdingClaimId);
  });

  test("creates claim with context metadata", async () => {
    const result = await callTool(server, "grove_claim", {
      targetRef: "task-2",
      agent: { agentId: "agent-1" },
      intentSummary: "With context",
      leaseDurationMs: 300_000,
      context: { priority: "high", estimated_time: 3600 },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.status).toBe("active");
  });
});

describe("grove_release", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerClaimTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("releases an active claim", async () => {
    // Create claim first
    const createResult = await callTool(server, "grove_claim", {
      targetRef: "task-1",
      agent: { agentId: "agent-1" },
      intentSummary: "Working",
      leaseDurationMs: 300_000,
    });
    const claimId = JSON.parse(createResult.text).claimId;

    const result = await callTool(server, "grove_release", {
      claimId,
      action: "release",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.status).toBe("released");
    expect(data.action).toBe("release");
  });

  test("completes an active claim", async () => {
    const createResult = await callTool(server, "grove_claim", {
      targetRef: "task-1",
      agent: { agentId: "agent-1" },
      intentSummary: "Working",
      leaseDurationMs: 300_000,
    });
    const claimId = JSON.parse(createResult.text).claimId;

    const result = await callTool(server, "grove_release", {
      claimId,
      action: "complete",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.status).toBe("completed");
    expect(data.action).toBe("complete");
  });

  test("returns not-found for non-existent claim", async () => {
    const result = await callTool(server, "grove_release", {
      claimId: "nonexistent-claim-id",
      action: "release",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(McpErrorCode.NotFound);
  });
});

describe("grove_claim agentTaskId stamping", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerClaimTools(server, { ...deps, agentTaskId: "task-abc-123" });
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("stamps agentTaskId into claim context when deps.agentTaskId is set", async () => {
    const result = await callTool(server, "grove_claim", {
      targetRef: "task-xyz",
      agent: { agentId: "agent-1" },
      intentSummary: "Working on task",
      leaseDurationMs: 300_000,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text) as { claimId: string };
    const stored = await testDeps.deps.claimStore.getClaim(data.claimId);
    expect(stored?.context?.agentTaskId).toBe("task-abc-123");
  });

  test("agentTaskId is merged additively — does not clobber caller-supplied context", async () => {
    const result = await callTool(server, "grove_claim", {
      targetRef: "task-xyz",
      agent: { agentId: "agent-1" },
      intentSummary: "Working on task",
      leaseDurationMs: 300_000,
      context: { priority: "high" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text) as { claimId: string };
    const stored = await testDeps.deps.claimStore.getClaim(data.claimId);
    expect(stored?.context?.agentTaskId).toBe("task-abc-123");
    expect(stored?.context?.priority).toBe("high");
  });

  test("omits agentTaskId from context when deps.agentTaskId is undefined", async () => {
    const serverWithoutTaskId = new McpServer(
      { name: "test2", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerClaimTools(serverWithoutTaskId, deps);

    const result = await callTool(serverWithoutTaskId, "grove_claim", {
      targetRef: "task-no-task-id",
      agent: { agentId: "agent-1" },
      intentSummary: "Working on task",
      leaseDurationMs: 300_000,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text) as { claimId: string };
    const stored = await testDeps.deps.claimStore.getClaim(data.claimId);
    expect(stored?.context?.agentTaskId).toBeUndefined();
    expect(stored?.context).toBeUndefined();
  });
});

describe("grove_list_claims pagination", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerClaimTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("supports limit and offset for claim listings", async () => {
    await callTool(server, "grove_claim", {
      targetRef: "task-1",
      agent: { agentId: "agent-1" },
      intentSummary: "First claim",
      leaseDurationMs: 300_000,
    });
    await callTool(server, "grove_claim", {
      targetRef: "task-2",
      agent: { agentId: "agent-1" },
      intentSummary: "Second claim",
      leaseDurationMs: 300_000,
    });

    const result = await callTool(server, "grove_list_claims", { limit: 1, offset: 1 });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.total).toBe(2);
    expect(data.count).toBe(1);
    expect(data.claims.length).toBe(1);
  });
});

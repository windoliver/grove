/**
 * Tests for MCP bounty tools.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InMemoryCreditsService } from "../../core/in-memory-credits.js";
import type { McpDeps } from "../deps.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerBountyTools } from "./bounties.js";

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

describe("grove_bounty_create", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    // Seed credits for the test agent
    (deps.creditsService as InMemoryCreditsService).seed("agent-1", 1000);
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerBountyTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("creates a bounty with credit reservation", async () => {
    const result = await callTool(server, "grove_bounty_create", {
      title: "Optimize parser",
      amount: 100,
      criteria: { description: "Reduce parse time by 50%" },
      agent: { agentId: "agent-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.title).toBe("Optimize parser");
    expect(data.amount).toBe(100);
    expect(data.status).toBe("open");
    expect(data.bountyId).toBeDefined();
    expect(data.reservationId).toBeDefined();
  });

  test("returns error when bountyStore is missing", async () => {
    const noBountyDeps = { ...deps, bountyStore: undefined };
    const s = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerBountyTools(s, noBountyDeps as McpDeps);

    const result = await callTool(s, "grove_bounty_create", {
      title: "Test",
      amount: 50,
      criteria: { description: "test" },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not available");
  });

  test("creates bounty with optional fields", async () => {
    const result = await callTool(server, "grove_bounty_create", {
      title: "With metadata",
      description: "Detailed description",
      amount: 200,
      criteria: {
        description: "Improve metric",
        metricName: "val_bpb",
        metricThreshold: 1.5,
        metricDirection: "minimize",
        requiredTags: ["ml", "optimization"],
      },
      agent: { agentId: "agent-1" },
      zoneId: "zone-alpha",
      context: { priority: "high" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.amount).toBe(200);
    expect(data.status).toBe("open");
  });
});

describe("grove_bounty_list", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    (deps.creditsService as InMemoryCreditsService).seed("agent-1", 5000);
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerBountyTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("lists bounties (empty)", async () => {
    const result = await callTool(server, "grove_bounty_list", {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data).toEqual([]);
  });

  test("lists created bounties", async () => {
    await callTool(server, "grove_bounty_create", {
      title: "Bounty A",
      amount: 100,
      criteria: { description: "Do A" },
      agent: { agentId: "agent-1" },
    });
    await callTool(server, "grove_bounty_create", {
      title: "Bounty B",
      amount: 200,
      criteria: { description: "Do B" },
      agent: { agentId: "agent-1" },
    });

    const result = await callTool(server, "grove_bounty_list", {});
    const data = JSON.parse(result.text);
    expect(data.length).toBe(2);
  });

  test("filters by status", async () => {
    await callTool(server, "grove_bounty_create", {
      title: "Open bounty",
      amount: 100,
      criteria: { description: "open" },
      agent: { agentId: "agent-1" },
    });

    const result = await callTool(server, "grove_bounty_list", { status: "open" });
    const data = JSON.parse(result.text);
    expect(data.length).toBe(1);
    expect(data[0].status).toBe("open");

    const settled = await callTool(server, "grove_bounty_list", { status: "settled" });
    expect(JSON.parse(settled.text).length).toBe(0);
  });

  test("filters by creator", async () => {
    await callTool(server, "grove_bounty_create", {
      title: "Agent 1 bounty",
      amount: 100,
      criteria: { description: "test" },
      agent: { agentId: "agent-1" },
    });

    const result = await callTool(server, "grove_bounty_list", { creatorAgentId: "agent-1" });
    expect(JSON.parse(result.text).length).toBe(1);

    const noMatch = await callTool(server, "grove_bounty_list", { creatorAgentId: "other" });
    expect(JSON.parse(noMatch.text).length).toBe(0);
  });
});

describe("grove_bounty_claim", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerBountyTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("claims an open bounty", async () => {
    const createResult = await callTool(server, "grove_bounty_create", {
      title: "Claimable bounty",
      amount: 100,
      criteria: { description: "Do something" },
      agent: { agentId: "creator" },
    });
    const bountyId = JSON.parse(createResult.text).bountyId;

    const result = await callTool(server, "grove_bounty_claim", {
      bountyId,
      agent: { agentId: "claimer" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.bountyId).toBe(bountyId);
    expect(data.status).toBe("claimed");
    expect(data.claimedBy).toBe("claimer");
    expect(data.claimId).toBeDefined();
  });

  test("returns not-found for non-existent bounty", async () => {
    const result = await callTool(server, "grove_bounty_claim", {
      bountyId: "nonexistent",
      agent: { agentId: "claimer" },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found");
  });
});

describe("grove_bounty_settle", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    (deps.creditsService as InMemoryCreditsService).seed("creator", 5000);
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerBountyTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("settles a claimed bounty end-to-end", async () => {
    // Create
    const createResult = await callTool(server, "grove_bounty_create", {
      title: "Full lifecycle",
      amount: 500,
      criteria: { description: "Complete the task" },
      agent: { agentId: "creator" },
    });
    const bountyId = JSON.parse(createResult.text).bountyId;

    // Claim
    await callTool(server, "grove_bounty_claim", {
      bountyId,
      agent: { agentId: "worker" },
    });

    // Settle
    const result = await callTool(server, "grove_bounty_settle", {
      bountyId,
      contributionCid: "blake3:abc123",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.bountyId).toBe(bountyId);
    expect(data.status).toBe("settled");
    expect(data.fulfilledByCid).toBe("blake3:abc123");
    expect(data.amount).toBe(500);
    expect(data.paidTo).toBe("worker");
  });

  test("returns not-found for non-existent bounty", async () => {
    const result = await callTool(server, "grove_bounty_settle", {
      bountyId: "nonexistent",
      contributionCid: "blake3:abc123",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found");
  });
});

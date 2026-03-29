/**
 * Tests for MCP bounty tools.
 *
 * grove_bounty_claim was merged into grove_claim — bounty claim tests
 * now use grove_claim with targetRef "bounty:<bountyId>".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CreditsService } from "../../core/credits.js";
import type { InMemoryCreditsService } from "../../core/in-memory-credits.js";
import { makeContribution } from "../../core/test-helpers.js";
import type { McpDeps } from "../deps.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerBountyTools } from "./bounties.js";
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

/** Register both bounty and claim tools (needed for bounty claim via grove_claim). */
function registerAllBountyTools(server: McpServer, deps: McpDeps): void {
  registerBountyTools(server, deps);
  registerClaimTools(server, deps);
}

/** Helper: claim a bounty via grove_claim with "bounty:<id>" targetRef. */
async function claimBountyViaClaim(
  server: McpServer,
  bountyId: string,
  agentId: string,
): Promise<{ isError: boolean | undefined; text: string }> {
  return callTool(server, "grove_claim", {
    targetRef: `bounty:${bountyId}`,
    agent: { agentId },
    intentSummary: `Claiming bounty ${bountyId}`,
  });
}

// ---------------------------------------------------------------------------
// grove_bounty_claim is NOT registered (regression)
// ---------------------------------------------------------------------------

describe("regression: grove_bounty_claim removed", () => {
  let testDeps: TestMcpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerBountyTools(server, testDeps.deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("grove_bounty_claim is NOT registered", () => {
    const registeredTools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect("grove_bounty_claim" in registeredTools).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// grove_bounty_create
// ---------------------------------------------------------------------------

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
    const noBountyDeps = { ...deps, bountyStore: undefined } as unknown as McpDeps;
    const s = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerBountyTools(s, noBountyDeps);

    const result = await callTool(s, "grove_bounty_create", {
      title: "Test",
      amount: 50,
      criteria: { description: "test" },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not available");
  });

  test("creates bounty without creditsService (local dev mode)", async () => {
    const noCreditsDeps = { ...deps, creditsService: undefined } as unknown as McpDeps;
    const s = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerBountyTools(s, noCreditsDeps);

    const result = await callTool(s, "grove_bounty_create", {
      title: "No credits",
      amount: 50,
      criteria: { description: "test" },
      agent: { agentId: "agent-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.title).toBe("No credits");
    expect(data.status).toBe("open");
    // No reservation when creditsService is absent
    expect(data.reservationId).toBeUndefined();
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

// ---------------------------------------------------------------------------
// grove_bounty_list
// ---------------------------------------------------------------------------

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
    expect(data.bounties).toEqual([]);
    expect(data.count).toBe(0);
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
    expect(data.bounties.length).toBe(2);
    expect(data.count).toBe(2);
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
    expect(data.bounties.length).toBe(1);
    expect(data.bounties[0].status).toBe("open");

    const settled = await callTool(server, "grove_bounty_list", { status: "settled" });
    expect(JSON.parse(settled.text).bounties.length).toBe(0);
  });

  test("filters by creator", async () => {
    await callTool(server, "grove_bounty_create", {
      title: "Agent 1 bounty",
      amount: 100,
      criteria: { description: "test" },
      agent: { agentId: "agent-1" },
    });

    const result = await callTool(server, "grove_bounty_list", { creatorAgentId: "agent-1" });
    expect(JSON.parse(result.text).bounties.length).toBe(1);

    const noMatch = await callTool(server, "grove_bounty_list", { creatorAgentId: "other" });
    expect(JSON.parse(noMatch.text).bounties.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bounty claim via grove_claim (previously grove_bounty_claim)
// ---------------------------------------------------------------------------

describe("bounty claim via grove_claim", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerAllBountyTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("claims an open bounty via grove_claim", async () => {
    const createResult = await callTool(server, "grove_bounty_create", {
      title: "Claimable bounty",
      amount: 100,
      criteria: { description: "Do something" },
      agent: { agentId: "creator" },
    });
    const bountyId = JSON.parse(createResult.text).bountyId;

    const result = await claimBountyViaClaim(server, bountyId, "claimer");

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.bountyId).toBe(bountyId);
    expect(data.status).toBe("claimed");
    expect(data.claimedBy).toBe("claimer");
    expect(data.claimId).toBeDefined();
  });

  test("returns not-found for non-existent bounty", async () => {
    const result = await claimBountyViaClaim(server, "nonexistent", "claimer");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// grove_bounty_settle
// ---------------------------------------------------------------------------

describe("grove_bounty_settle", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    (deps.creditsService as InMemoryCreditsService).seed("creator", 5000);
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerAllBountyTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("settles a claimed bounty end-to-end", async () => {
    // Create a real contribution in the store
    const contribution = makeContribution({ summary: "Fulfills the bounty" });
    await deps.contributionStore.put(contribution);

    // Create bounty
    const createResult = await callTool(server, "grove_bounty_create", {
      title: "Full lifecycle",
      amount: 500,
      criteria: { description: "Complete the task" },
      agent: { agentId: "creator" },
    });
    const bountyId = JSON.parse(createResult.text).bountyId;

    // Claim via grove_claim
    await claimBountyViaClaim(server, bountyId, "worker");

    // Settle with real contribution CID
    const result = await callTool(server, "grove_bounty_settle", {
      bountyId,
      contributionCid: contribution.cid,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.bountyId).toBe(bountyId);
    expect(data.status).toBe("settled");
    expect(data.fulfilledByCid).toBe(contribution.cid);
    expect(data.amount).toBe(500);
    expect(data.paidTo).toBe("worker");

    // Verify credit balances: creator debited, worker credited
    const credits = deps.creditsService as CreditsService;
    const creatorBal = await credits.balance("creator");
    expect(creatorBal.total).toBe(4500); // 5000 - 500
    const workerBal = await credits.balance("worker");
    expect(workerBal.total).toBe(500);
  });

  test("rejects settlement with non-existent contribution", async () => {
    const createResult = await callTool(server, "grove_bounty_create", {
      title: "Test bounty",
      amount: 100,
      criteria: { description: "test" },
      agent: { agentId: "creator" },
    });
    const bountyId = JSON.parse(createResult.text).bountyId;

    await claimBountyViaClaim(server, bountyId, "worker");

    const result = await callTool(server, "grove_bounty_settle", {
      bountyId,
      contributionCid: "blake3:doesnotexist",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found");
  });

  test("rejects settlement when criteria not met", async () => {
    // Create contribution WITHOUT required tags
    const contribution = makeContribution({ summary: "No tags" });
    await deps.contributionStore.put(contribution);

    // Create bounty requiring specific tags
    const createResult = await callTool(server, "grove_bounty_create", {
      title: "Needs tags",
      amount: 100,
      criteria: { description: "test", requiredTags: ["ml", "optimization"] },
      agent: { agentId: "creator" },
    });
    const bountyId = JSON.parse(createResult.text).bountyId;

    await claimBountyViaClaim(server, bountyId, "worker");

    const result = await callTool(server, "grove_bounty_settle", {
      bountyId,
      contributionCid: contribution.cid,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("does not meet bounty criteria");
  });

  test("returns not-found for non-existent bounty", async () => {
    const result = await callTool(server, "grove_bounty_settle", {
      bountyId: "nonexistent",
      contributionCid: "blake3:abc123",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found");
  });

  test("settles without creditsService when bounty has no escrow (local dev mode)", async () => {
    const noCreditsDeps = { ...deps, creditsService: undefined } as unknown as McpDeps;
    const s = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerAllBountyTools(s, noCreditsDeps);

    const contribution = makeContribution({ summary: "Fulfills bounty" });
    await deps.contributionStore.put(contribution);

    // Create bounty without credits (no reservationId)
    const createResult = await callTool(s, "grove_bounty_create", {
      title: "No credits settle",
      amount: 100,
      criteria: { description: "test" },
      agent: { agentId: "creator" },
    });
    const bountyId = JSON.parse(createResult.text).bountyId;

    // Claim via grove_claim
    await callTool(s, "grove_claim", {
      targetRef: `bounty:${bountyId}`,
      agent: { agentId: "worker" },
      intentSummary: "Claiming bounty",
    });

    // Settle — should succeed without creditsService since no escrow
    const result = await callTool(s, "grove_bounty_settle", {
      bountyId,
      contributionCid: contribution.cid,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.status).toBe("settled");
  });

  test("rejects settlement of escrowed bounty when creditsService is absent", async () => {
    // Create bounty WITH creditsService (escrow established)
    const contribution = makeContribution({ summary: "Fulfills bounty" });
    await deps.contributionStore.put(contribution);

    const createResult = await callTool(server, "grove_bounty_create", {
      title: "Escrowed bounty",
      amount: 200,
      criteria: { description: "test" },
      agent: { agentId: "creator" },
    });
    const created = JSON.parse(createResult.text);
    expect(created.reservationId).toBeDefined();

    await claimBountyViaClaim(server, created.bountyId, "worker");

    // Now try to settle without creditsService — should refuse
    const noCreditsDeps = { ...deps, creditsService: undefined } as unknown as McpDeps;
    const s = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerBountyTools(s, noCreditsDeps);

    const result = await callTool(s, "grove_bounty_settle", {
      bountyId: created.bountyId,
      contributionCid: contribution.cid,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("creditsService is not available");
  });
});

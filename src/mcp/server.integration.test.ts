/**
 * Integration tests for the grove MCP server.
 *
 * Uses InMemoryTransport to test the full round-trip:
 * Client → Transport → McpServer → Tool Handler → Store → Response → Client
 *
 * This catches schema registration bugs, serialization issues, and
 * protocol-level errors that unit tests miss.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeContribution } from "../core/test-helpers.js";
import type { McpDeps } from "./deps.js";
import { createMcpServer } from "./server.js";
import type { TestMcpDeps } from "./test-helpers.js";
import { createTestMcpDeps } from "./test-helpers.js";

/** Extract text from MCP tool result content array. */
function getText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text: string }> };
  return r.content?.[0]?.text ?? "";
}

describe("MCP server integration", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let client: Client;
  let closeTransports: () => Promise<void>;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;

    const server = await createMcpServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "0.0.1" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    closeTransports = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await closeTransports();
    await testDeps.cleanup();
  });

  test("lists all 30 tools", async () => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      "ask_user",
      "grove_bounty_claim",
      "grove_bounty_create",
      "grove_bounty_list",
      "grove_bounty_settle",
      "grove_cas_put",
      "grove_check_stop",
      "grove_checkout",
      "grove_claim",
      "grove_contribute",
      "grove_discuss",
      "grove_frontier",
      "grove_get_outcome",
      "grove_ingest_git_diff",
      "grove_ingest_git_tree",
      "grove_list_claims",
      "grove_list_outcomes",
      "grove_log",
      "grove_outcome_stats",
      "grove_read_inbox",
      "grove_release",
      "grove_report_usage",
      "grove_reproduce",
      "grove_review",
      "grove_search",
      "grove_send_message",
      "grove_set_outcome",
      "grove_thread",
      "grove_threads",
      "grove_tree",
    ]);
  });

  test("grove_contribute round-trip", async () => {
    const result = await client.callTool({
      name: "grove_contribute",
      arguments: {
        kind: "work",
        mode: "evaluation",
        summary: "Integration test contribution",
        tags: ["integration"],
        relations: [],
        artifacts: {},
        agent: { agentId: "integration-agent" },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(getText(result));
    expect(data.cid).toMatch(/^blake3:/);
    expect(data.kind).toBe("work");
  });

  test("grove_search round-trip", async () => {
    // Add a contribution to search for
    const c = makeContribution({ summary: "Searchable via MCP" });
    await deps.contributionStore.put(c);

    const result = await client.callTool({
      name: "grove_search",
      arguments: { query: "searchable" },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(getText(result));
    expect(data.results.length).toBe(1);
    expect(data.results[0].summary).toBe("Searchable via MCP");
  });

  test("grove_claim and grove_release round-trip", async () => {
    // Claim
    const claimResult = await client.callTool({
      name: "grove_claim",
      arguments: {
        targetRef: "integration-target",
        agent: { agentId: "integration-agent" },
        intentSummary: "Integration test claim",
      },
    });

    expect(claimResult.isError).toBeFalsy();
    const claimData = JSON.parse(getText(claimResult));
    expect(claimData.status).toBe("active");

    // Release
    const releaseResult = await client.callTool({
      name: "grove_release",
      arguments: {
        claimId: claimData.claimId,
        action: "complete",
      },
    });

    expect(releaseResult.isError).toBeFalsy();
    const releaseData = JSON.parse(getText(releaseResult));
    expect(releaseData.status).toBe("completed");
  });

  test("grove_review round-trip", async () => {
    // Create target
    const target = makeContribution({ summary: "Reviewable work" });
    await deps.contributionStore.put(target);

    const result = await client.callTool({
      name: "grove_review",
      arguments: {
        targetCid: target.cid,
        summary: "LGTM",
        agent: { agentId: "reviewer" },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(getText(result));
    expect(data.kind).toBe("review");
    expect(data.targetCid).toBe(target.cid);
  });

  test("grove_frontier round-trip on empty grove", async () => {
    const result = await client.callTool({
      name: "grove_frontier",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(getText(result));
    expect(data.byRecency).toEqual([]);
  });

  test("grove_log round-trip", async () => {
    const c = makeContribution({ summary: "Log entry" });
    await deps.contributionStore.put(c);

    const result = await client.callTool({
      name: "grove_log",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(getText(result));
    expect(data.results.length).toBe(1);
  });

  test("grove_tree round-trip", async () => {
    const parent = makeContribution({ summary: "Tree root" });
    await deps.contributionStore.put(parent);

    const result = await client.callTool({
      name: "grove_tree",
      arguments: { cid: parent.cid },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(getText(result));
    expect(data.cid).toBe(parent.cid);
  });

  test("error handling — invalid tool call returns error", async () => {
    const result = await client.callTool({
      name: "grove_tree",
      arguments: {
        cid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      },
    });

    expect(result.isError).toBeTruthy();
    expect(getText(result)).toContain("NOT_FOUND");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeContribution } from "../../core/test-helpers.js";
import type { McpDeps } from "../deps.js";
import { McpErrorCode } from "../error-handler.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerQueryTools } from "./queries.js";

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

describe("grove_frontier", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerQueryTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns empty frontier for empty grove", async () => {
    const result = await callTool(server, "grove_frontier", {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.byRecency).toEqual([]);
    expect(data.byAdoption).toEqual([]);
  });

  test("returns frontier with contributions", async () => {
    const c1 = makeContribution({ summary: "First work", createdAt: "2026-01-01T00:00:00Z" });
    const c2 = makeContribution({ summary: "Second work", createdAt: "2026-01-02T00:00:00Z" });
    await deps.contributionStore.put(c1);
    await deps.contributionStore.put(c2);

    const result = await callTool(server, "grove_frontier", { limit: 5 });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.byRecency.length).toBe(2);
    // Most recent first
    expect(data.byRecency[0].summary).toBe("Second work");
  });

  test("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      const c = makeContribution({
        summary: `Work ${i}`,
        createdAt: new Date(2026, 0, i + 1).toISOString(),
      });
      await deps.contributionStore.put(c);
    }

    const result = await callTool(server, "grove_frontier", { limit: 3 });
    const data = JSON.parse(result.text);
    expect(data.byRecency.length).toBe(3);
  });

  test("filters by context parameter", async () => {
    const h100 = makeContribution({
      summary: "H100 run",
      context: { hardware: "H100" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const a100 = makeContribution({
      summary: "A100 run",
      context: { hardware: "A100" },
      createdAt: "2026-01-02T00:00:00Z",
    });
    await deps.contributionStore.put(h100);
    await deps.contributionStore.put(a100);

    const result = await callTool(server, "grove_frontier", {
      context: { hardware: "H100" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.byRecency).toHaveLength(1);
    expect(data.byRecency[0].summary).toBe("H100 run");
  });

  test("returns trimmed frontier entries", async () => {
    const c = makeContribution({
      summary: "Work",
      description: "Long description that should not appear",
    });
    await deps.contributionStore.put(c);

    const result = await callTool(server, "grove_frontier", {});
    const data = JSON.parse(result.text);
    const entry = data.byRecency[0];
    // Should have trimmed fields
    expect(entry.cid).toBeDefined();
    expect(entry.summary).toBe("Work");
    expect(entry.kind).toBe("work");
    expect(entry.agentId).toBe("test-agent");
    // Should NOT have full contribution fields
    expect(entry.description).toBeUndefined();
    expect(entry.artifacts).toBeUndefined();
    expect(entry.relations).toBeUndefined();
  });
});

describe("grove_search", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerQueryTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("searches contributions by text", async () => {
    const c1 = makeContribution({ summary: "Parser optimization" });
    const c2 = makeContribution({ summary: "Database migration" });
    await deps.contributionStore.put(c1);
    await deps.contributionStore.put(c2);

    const result = await callTool(server, "grove_search", { query: "parser" });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.results.length).toBe(1);
    expect(data.results[0].summary).toBe("Parser optimization");
  });

  test("returns empty results for no matches", async () => {
    const c = makeContribution({ summary: "Something" });
    await deps.contributionStore.put(c);

    const result = await callTool(server, "grove_search", { query: "nonexistent" });

    const data = JSON.parse(result.text);
    expect(data.results.length).toBe(0);
  });

  test("filters by kind", async () => {
    const work = makeContribution({ summary: "Test parser", kind: "work" });
    const review = makeContribution({
      summary: "Test parser review",
      kind: "review",
      relations: [{ targetCid: work.cid, relationType: "reviews" }],
    });
    await deps.contributionStore.put(work);
    await deps.contributionStore.put(review);

    const result = await callTool(server, "grove_search", {
      query: "parser",
      kind: "review",
    });

    const data = JSON.parse(result.text);
    expect(data.results.length).toBe(1);
    expect(data.results[0].kind).toBe("review");
  });

  test("returns trimmed summaries", async () => {
    const c = makeContribution({
      summary: "Searchable work",
      description: "Should not appear in results",
    });
    await deps.contributionStore.put(c);

    const result = await callTool(server, "grove_search", { query: "searchable" });
    const data = JSON.parse(result.text);
    const item = data.results[0];
    expect(item.cid).toBeDefined();
    expect(item.summary).toBe("Searchable work");
    expect(item.description).toBeUndefined();
    expect(item.artifacts).toBeUndefined();
  });
});

describe("grove_log", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerQueryTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns recent contributions in newest-first order", async () => {
    const c1 = makeContribution({ summary: "First", createdAt: "2026-01-01T00:00:00Z" });
    const c2 = makeContribution({ summary: "Second", createdAt: "2026-01-02T00:00:00Z" });
    await deps.contributionStore.put(c1);
    await deps.contributionStore.put(c2);

    const result = await callTool(server, "grove_log", {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.results.length).toBe(2);
    expect(data.count).toBe(2);
    // Newest first
    expect(data.results[0].summary).toBe("Second");
    expect(data.results[1].summary).toBe("First");
  });

  test("returns empty for empty grove", async () => {
    const result = await callTool(server, "grove_log", {});
    const data = JSON.parse(result.text);
    expect(data.results.length).toBe(0);
  });

  test("respects limit and offset", async () => {
    for (let i = 0; i < 5; i++) {
      const c = makeContribution({ summary: `Work ${i}` });
      await deps.contributionStore.put(c);
    }

    const result = await callTool(server, "grove_log", { limit: 2, offset: 1 });
    const data = JSON.parse(result.text);
    expect(data.results.length).toBe(2);
  });

  test("filters by agentId", async () => {
    const c1 = makeContribution({
      summary: "Agent A work",
      agent: { agentId: "agent-a" },
    });
    const c2 = makeContribution({
      summary: "Agent B work",
      agent: { agentId: "agent-b" },
    });
    await deps.contributionStore.put(c1);
    await deps.contributionStore.put(c2);

    const result = await callTool(server, "grove_log", { agentId: "agent-a" });
    const data = JSON.parse(result.text);
    expect(data.results.length).toBe(1);
    expect(data.results[0].agentId).toBe("agent-a");
  });
});

describe("grove_tree", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerQueryTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns children and ancestors", async () => {
    const parent = makeContribution({ summary: "Parent" });
    const child = makeContribution({
      summary: "Child",
      relations: [{ targetCid: parent.cid, relationType: "derives_from" }],
    });
    await deps.contributionStore.put(parent);
    await deps.contributionStore.put(child);

    const result = await callTool(server, "grove_tree", {
      cid: parent.cid,
      direction: "both",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.children.length).toBe(1);
    expect(data.children[0].summary).toBe("Child");
    expect(data.ancestors.length).toBe(0);
  });

  test("returns only children when direction=children", async () => {
    const parent = makeContribution({ summary: "Parent" });
    await deps.contributionStore.put(parent);

    const result = await callTool(server, "grove_tree", {
      cid: parent.cid,
      direction: "children",
    });

    const data = JSON.parse(result.text);
    expect(data.children).toBeDefined();
    expect(data.ancestors).toBeUndefined();
  });

  test("returns not-found for non-existent CID", async () => {
    const result = await callTool(server, "grove_tree", {
      cid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      direction: "both",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(McpErrorCode.NotFound);
  });
});

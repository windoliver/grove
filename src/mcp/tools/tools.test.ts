/**
 * Unified MCP tool tests covering grove_contribute, grove_frontier,
 * grove_claim, grove_search, and grove_checkout.
 *
 * Each tool is tested for valid inputs (success), invalid inputs (error),
 * and missing/edge-case fields. Tests exercise the full MCP tool handler
 * path: Zod schema → operation → toMcpResult.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeContribution } from "../../core/test-helpers.js";
import type { McpDeps } from "../deps.js";
import { McpErrorCode } from "../error-handler.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps, storeTestContent } from "../test-helpers.js";
import { registerClaimTools } from "./claims.js";
import { registerContributionTools } from "./contributions.js";
import { registerQueryTools } from "./queries.js";
import { registerWorkspaceTools } from "./workspace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Call a tool handler directly via the McpServer internal state. */
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

// ---------------------------------------------------------------------------
// grove_contribute
// ---------------------------------------------------------------------------

describe("grove_contribute (tools.test)", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerContributionTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("succeeds with minimal required fields", async () => {
    const result = await callTool(server, "grove_contribute", {
      kind: "work",
      summary: "Minimal contribution",
      relations: [],
      artifacts: {},
      tags: [],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.cid).toMatch(/^blake3:/);
    expect(data.kind).toBe("work");
    expect(data.summary).toBe("Minimal contribution");
  });

  test("succeeds with all optional fields populated", async () => {
    const hash = await storeTestContent(deps.cas, "artifact content");

    const result = await callTool(server, "grove_contribute", {
      kind: "work",
      mode: "evaluation",
      summary: "Full contribution",
      description: "A detailed description",
      artifacts: { "main.py": hash },
      relations: [],
      scores: { accuracy: { value: 0.95, direction: "maximize" } },
      tags: ["ml", "transformer"],
      context: { hardware: "H100", dataset: "wikitext" },
      agent: { agentId: "agent-full", agentName: "Full Agent", provider: "anthropic" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.cid).toMatch(/^blake3:/);
    expect(data.artifactCount).toBe(1);
  });

  test("returns error for non-existent artifact hash", async () => {
    const result = await callTool(server, "grove_contribute", {
      kind: "work",
      summary: "Bad artifact ref",
      relations: [],
      artifacts: {
        "missing.txt": "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      },
      tags: [],
      agent: { agentId: "agent-1" },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(McpErrorCode.ValidationError);
    expect(result.text).toContain("non-existent hash");
  });

  test("returns error when relation targets non-existent contribution", async () => {
    const result = await callTool(server, "grove_contribute", {
      kind: "work",
      summary: "Dangling relation",
      relations: [
        {
          targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
          relationType: "derives_from",
        },
      ],
      artifacts: {},
      tags: [],
      agent: { agentId: "agent-1" },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(McpErrorCode.NotFound);
  });

  test("exploration mode contribution succeeds without scores", async () => {
    const result = await callTool(server, "grove_contribute", {
      kind: "work",
      mode: "exploration",
      summary: "Exploratory work without scores",
      relations: [],
      artifacts: {},
      tags: ["experiment"],
      agent: { agentId: "explorer-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.cid).toMatch(/^blake3:/);
  });
});

// ---------------------------------------------------------------------------
// grove_frontier
// ---------------------------------------------------------------------------

describe("grove_frontier (tools.test)", () => {
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

  test("returns empty frontier when no contributions exist", async () => {
    const result = await callTool(server, "grove_frontier", {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.byRecency).toEqual([]);
    expect(data.byAdoption).toEqual([]);
  });

  test("returns ranked frontier entries for existing contributions", async () => {
    const c1 = makeContribution({ summary: "First", createdAt: "2026-01-01T00:00:00Z" });
    const c2 = makeContribution({ summary: "Second", createdAt: "2026-01-02T00:00:00Z" });
    const c3 = makeContribution({ summary: "Third", createdAt: "2026-01-03T00:00:00Z" });
    await deps.contributionStore.put(c1);
    await deps.contributionStore.put(c2);
    await deps.contributionStore.put(c3);

    const result = await callTool(server, "grove_frontier", { limit: 2 });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.byRecency.length).toBe(2);
    // Most recent first
    expect(data.byRecency[0].summary).toBe("Third");
    expect(data.byRecency[1].summary).toBe("Second");
  });

  test("filters frontier by tags", async () => {
    const ml = makeContribution({
      summary: "ML work",
      tags: ["ml"],
      createdAt: "2026-01-01T00:00:00Z",
    });
    const web = makeContribution({
      summary: "Web work",
      tags: ["web"],
      createdAt: "2026-01-02T00:00:00Z",
    });
    await deps.contributionStore.put(ml);
    await deps.contributionStore.put(web);

    const result = await callTool(server, "grove_frontier", { tags: ["ml"] });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.byRecency).toHaveLength(1);
    expect(data.byRecency[0].summary).toBe("ML work");
  });

  test("filters frontier by kind", async () => {
    const work = makeContribution({
      summary: "A work item",
      kind: "work",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const review = makeContribution({
      summary: "A review",
      kind: "review",
      relations: [{ targetCid: work.cid, relationType: "reviews" }],
      createdAt: "2026-01-02T00:00:00Z",
    });
    await deps.contributionStore.put(work);
    await deps.contributionStore.put(review);

    const result = await callTool(server, "grove_frontier", { kind: "review" });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.byRecency).toHaveLength(1);
    expect(data.byRecency[0].summary).toBe("A review");
  });
});

// ---------------------------------------------------------------------------
// grove_claim
// ---------------------------------------------------------------------------

describe("grove_claim (tools.test)", () => {
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

  test("creates a new claim successfully", async () => {
    const result = await callTool(server, "grove_claim", {
      targetRef: "feature-x",
      agent: { agentId: "agent-A" },
      intentSummary: "Implementing feature X",
      leaseDurationMs: 600_000,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.targetRef).toBe("feature-x");
    expect(data.status).toBe("active");
    expect(data.agentId).toBe("agent-A");
    expect(data.claimId).toBeDefined();
  });

  test("returns conflict error when different agent claims same target", async () => {
    // Agent A claims
    await callTool(server, "grove_claim", {
      targetRef: "feature-x",
      agent: { agentId: "agent-A" },
      intentSummary: "Agent A working",
      leaseDurationMs: 300_000,
    });

    // Agent B tries the same target
    const result = await callTool(server, "grove_claim", {
      targetRef: "feature-x",
      agent: { agentId: "agent-B" },
      intentSummary: "Agent B wants to work",
      leaseDurationMs: 300_000,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(McpErrorCode.ClaimConflict);
    expect(result.text).toContain("feature-x");
    expect(result.text).toContain("agent-A");
  });

  test("allows same agent to renew an existing claim", async () => {
    await callTool(server, "grove_claim", {
      targetRef: "feature-y",
      agent: { agentId: "agent-A" },
      intentSummary: "Initial work",
      leaseDurationMs: 300_000,
    });

    const result = await callTool(server, "grove_claim", {
      targetRef: "feature-y",
      agent: { agentId: "agent-A" },
      intentSummary: "Renewed work",
      leaseDurationMs: 600_000,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.status).toBe("active");
  });

  test("release returns not-found for non-existent claim ID", async () => {
    const result = await callTool(server, "grove_release", {
      claimId: "does-not-exist",
      action: "release",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(McpErrorCode.NotFound);
  });
});

// ---------------------------------------------------------------------------
// grove_search
// ---------------------------------------------------------------------------

describe("grove_search (tools.test)", () => {
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

  test("finds contributions matching a text query", async () => {
    const c1 = makeContribution({ summary: "Transformer architecture improvements" });
    const c2 = makeContribution({ summary: "Database indexing strategy" });
    await deps.contributionStore.put(c1);
    await deps.contributionStore.put(c2);

    const result = await callTool(server, "grove_search", { query: "transformer" });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.results.length).toBe(1);
    expect(data.results[0].summary).toBe("Transformer architecture improvements");
  });

  test("returns empty results when nothing matches", async () => {
    const c = makeContribution({ summary: "Something unrelated" });
    await deps.contributionStore.put(c);

    const result = await callTool(server, "grove_search", { query: "quantum" });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.results.length).toBe(0);
  });

  test("returns trimmed results without description or artifacts", async () => {
    const c = makeContribution({
      summary: "Searchable summary",
      description: "This should not appear",
    });
    await deps.contributionStore.put(c);

    const result = await callTool(server, "grove_search", { query: "searchable" });
    const data = JSON.parse(result.text);
    const item = data.results[0];
    expect(item.cid).toBeDefined();
    expect(item.summary).toBe("Searchable summary");
    expect(item.description).toBeUndefined();
    expect(item.artifacts).toBeUndefined();
  });

  test("filters search by agentName", async () => {
    const c1 = makeContribution({
      summary: "Work by Alice",
      agent: { agentId: "a-1", agentName: "Alice" },
    });
    const c2 = makeContribution({
      summary: "Work by Bob",
      agent: { agentId: "b-1", agentName: "Bob" },
    });
    await deps.contributionStore.put(c1);
    await deps.contributionStore.put(c2);

    const result = await callTool(server, "grove_search", {
      query: "work",
      agentName: "Alice",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.results.length).toBe(1);
    expect(data.results[0].summary).toBe("Work by Alice");
  });
});

// ---------------------------------------------------------------------------
// grove_checkout
// ---------------------------------------------------------------------------

describe("grove_checkout (tools.test)", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerWorkspaceTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("materializes a contribution with artifacts into a workspace", async () => {
    const hash = await storeTestContent(deps.cas, "print('hello')");
    const c = makeContribution({
      summary: "Python script",
      artifacts: { "main.py": hash },
    });
    await deps.contributionStore.put(c);

    const result = await callTool(server, "grove_checkout", {
      cid: c.cid,
      agent: { agentId: "agent-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.cid).toBe(c.cid);
    expect(data.workspacePath).toBeDefined();
    expect(data.status).toBe("active");
    expect(data.artifactCount).toBe(1);
  });

  test("returns not-found for non-existent CID", async () => {
    const result = await callTool(server, "grove_checkout", {
      cid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      agent: { agentId: "agent-1" },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(McpErrorCode.NotFound);
  });

  test("is idempotent — same agent and CID yields same workspace path", async () => {
    const hash = await storeTestContent(deps.cas, "content");
    const c = makeContribution({
      summary: "Idempotent checkout",
      artifacts: { "data.txt": hash },
    });
    await deps.contributionStore.put(c);

    const r1 = await callTool(server, "grove_checkout", {
      cid: c.cid,
      agent: { agentId: "agent-1" },
    });
    const r2 = await callTool(server, "grove_checkout", {
      cid: c.cid,
      agent: { agentId: "agent-1" },
    });

    const d1 = JSON.parse(r1.text);
    const d2 = JSON.parse(r2.text);
    expect(d1.workspacePath).toBe(d2.workspacePath);
  });
});

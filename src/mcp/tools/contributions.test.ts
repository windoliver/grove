/**
 * Tests for per-kind contribution tools:
 *   grove_submit_work, grove_submit_review, grove_discuss,
 *   grove_reproduce, grove_adopt
 *
 * Each tool is tested for:
 *   - Happy path (success with all required fields)
 *   - Required-field rejection (missing required fields return actionable errors)
 *   - Edge cases (empty artifacts, non-existent targets)
 *
 * Regression: grove_contribute and grove_review (old tools) must NOT be registered.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeContribution } from "../../core/test-helpers.js";
import type { McpDeps } from "../deps.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps, storeTestContent } from "../test-helpers.js";
import { registerContributionTools } from "./contributions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Helper to call a tool handler directly via a test McpServer. */
async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean | undefined; text: string; allText: string[] }> {
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
    allText: result.content.map((c) => c.text),
  };
}

/** Check if a tool is registered on the server. */
function isToolRegistered(server: McpServer, name: string): boolean {
  const registeredTools = (
    server as unknown as {
      _registeredTools: Record<string, unknown>;
    }
  )._registeredTools;
  return name in registeredTools;
}

// ---------------------------------------------------------------------------
// Regression: old tools must NOT be registered
// ---------------------------------------------------------------------------

describe("regression: removed tools", () => {
  let testDeps: TestMcpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerContributionTools(server, testDeps.deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("grove_contribute is NOT registered", () => {
    expect(isToolRegistered(server, "grove_contribute")).toBe(false);
  });

  test("grove_review is NOT registered", () => {
    expect(isToolRegistered(server, "grove_review")).toBe(false);
  });

  test("grove_submit_work IS registered", () => {
    expect(isToolRegistered(server, "grove_submit_work")).toBe(true);
  });

  test("grove_submit_review IS registered", () => {
    expect(isToolRegistered(server, "grove_submit_review")).toBe(true);
  });

  test("grove_adopt IS registered", () => {
    expect(isToolRegistered(server, "grove_adopt")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// grove_submit_work
// ---------------------------------------------------------------------------

describe("grove_submit_work", () => {
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

  test("creates work contribution with artifacts", async () => {
    const hash = await storeTestContent(deps.cas, "console.log('hello')");

    const result = await callTool(server, "grove_submit_work", {
      summary: "Built hello module",
      artifacts: { "hello.ts": hash },
      agent: { agentId: "coder-1", role: "coder" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.cid).toMatch(/^blake3:/);
    expect(data.kind).toBe("work");
    expect(data.summary).toBe("Built hello module");
    expect(data.artifactCount).toBe(1);
  });

  test("accepts empty artifacts with warning", async () => {
    const result = await callTool(server, "grove_submit_work", {
      summary: "Configured CI pipeline",
      artifacts: {},
      agent: { agentId: "coder-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.cid).toMatch(/^blake3:/);
    // Check warning is present in response
    const warningText = result.allText.find((t) => t.startsWith("WARNING:"));
    expect(warningText).toBeDefined();
    expect(warningText).toContain("artifacts");
  });

  test("validates artifact hashes exist in CAS", async () => {
    const result = await callTool(server, "grove_submit_work", {
      summary: "Bad artifacts",
      artifacts: {
        "file.txt": "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      },
      agent: { agentId: "coder-1" },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("non-existent hash");
  });

  test("creates work with valid relations", async () => {
    const parent = makeContribution({ summary: "Parent work" });
    await deps.contributionStore.put(parent);

    const result = await callTool(server, "grove_submit_work", {
      summary: "Child work",
      artifacts: {},
      relations: [{ targetCid: parent.cid, relationType: "derives_from" }],
      agent: { agentId: "coder-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.relationCount).toBe(1);
  });

  test("creates work with scores and tags", async () => {
    const hash = await storeTestContent(deps.cas, "benchmark results");

    const result = await callTool(server, "grove_submit_work", {
      summary: "Benchmark run",
      artifacts: { "results.json": hash },
      scores: { latency: { value: 42, direction: "minimize" } },
      tags: ["benchmark", "perf"],
      mode: "evaluation",
      agent: { agentId: "coder-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.kind).toBe("work");
  });

  test("exploration mode succeeds without scores", async () => {
    const result = await callTool(server, "grove_submit_work", {
      summary: "Exploratory work",
      artifacts: {},
      mode: "exploration",
      tags: ["experiment"],
      agent: { agentId: "explorer-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.cid).toMatch(/^blake3:/);
  });
});

// ---------------------------------------------------------------------------
// grove_submit_review
// ---------------------------------------------------------------------------

describe("grove_submit_review", () => {
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

  test("creates a review with scores", async () => {
    const target = makeContribution({ summary: "Target work" });
    await deps.contributionStore.put(target);

    const result = await callTool(server, "grove_submit_review", {
      targetCid: target.cid,
      summary: "Code looks correct, style needs work",
      scores: {
        correctness: { value: 0.95, direction: "maximize" },
        style: { value: 0.6, direction: "maximize" },
      },
      agent: { agentId: "reviewer-1", role: "reviewer" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.kind).toBe("review");
    expect(data.targetCid).toBe(target.cid);
  });

  test("creates review with minimum one score", async () => {
    const target = makeContribution({ summary: "Target" });
    await deps.contributionStore.put(target);

    const result = await callTool(server, "grove_submit_review", {
      targetCid: target.cid,
      summary: "LGTM",
      scores: { approval: { value: 1, direction: "maximize" } },
      agent: { agentId: "reviewer-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.kind).toBe("review");
  });

  test("rejects review with empty scores — error names field and gives example", async () => {
    const target = makeContribution({ summary: "Target" });
    await deps.contributionStore.put(target);

    const result = await callTool(server, "grove_submit_review", {
      targetCid: target.cid,
      summary: "LGTM",
      scores: {},
      agent: { agentId: "reviewer-1" },
    });

    // Tool-level pre-validation rejects empty scores
    expect(result.isError).toBe(true);
    expect(result.text).toContain("VALIDATION_ERROR");
    expect(result.text).toContain("score");
    expect(result.text).toContain("correctness"); // Contains example
  });

  test("rejects review with undefined scores", async () => {
    const target = makeContribution({ summary: "Target" });
    await deps.contributionStore.put(target);

    const result = await callTool(server, "grove_submit_review", {
      targetCid: target.cid,
      summary: "LGTM with no scores",
      agent: { agentId: "reviewer-1" },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("VALIDATION_ERROR");
    expect(result.text).toContain("score");
  });

  test("returns not-found for non-existent target", async () => {
    const result = await callTool(server, "grove_submit_review", {
      targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      summary: "Review of nothing",
      scores: { quality: { value: 0.5, direction: "maximize" } },
      agent: { agentId: "reviewer-1" },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found");
  });

  test("creates review with description and metadata", async () => {
    const target = makeContribution({ summary: "Target" });
    await deps.contributionStore.put(target);

    const result = await callTool(server, "grove_submit_review", {
      targetCid: target.cid,
      summary: "Detailed review",
      description: "The algorithm has a bug on line 42...",
      scores: { correctness: { value: 0.3, direction: "maximize" } },
      metadata: { score: 0.3 },
      tags: ["code-review", "bug"],
      agent: { agentId: "reviewer-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.kind).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// grove_discuss
// ---------------------------------------------------------------------------

describe("grove_discuss", () => {
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

  test("creates a root discussion (no targetCid)", async () => {
    const result = await callTool(server, "grove_discuss", {
      summary: "Should we use polling or push?",
      tags: ["architecture"],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.kind).toBe("discussion");
    expect(data.cid).toMatch(/^blake3:/);
    expect(data.targetCid).toBeUndefined();
  });

  test("creates a reply discussion (with targetCid)", async () => {
    const target = makeContribution({ summary: "Root topic" });
    await deps.contributionStore.put(target);

    const result = await callTool(server, "grove_discuss", {
      targetCid: target.cid,
      summary: "I think push is better",
      tags: [],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.kind).toBe("discussion");
    expect(data.targetCid).toBe(target.cid);
  });

  test("returns not-found for non-existent targetCid", async () => {
    const result = await callTool(server, "grove_discuss", {
      targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      summary: "Reply to nothing",
      tags: [],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found");
  });

  test("creates discussion with agent identity", async () => {
    const result = await callTool(server, "grove_discuss", {
      summary: "Agent discussion",
      agent: { agentId: "discuss-1", role: "architect" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.kind).toBe("discussion");
  });
});

// ---------------------------------------------------------------------------
// grove_reproduce
// ---------------------------------------------------------------------------

describe("grove_reproduce", () => {
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

  test("creates a reproduction with confirmed result", async () => {
    const target = makeContribution({ summary: "Experiment" });
    await deps.contributionStore.put(target);

    const result = await callTool(server, "grove_reproduce", {
      targetCid: target.cid,
      summary: "Reproduced successfully",
      result: "confirmed",
      agent: { agentId: "reproducer-1" },
      artifacts: {},
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.kind).toBe("reproduction");
    expect(data.result).toBe("confirmed");
  });

  test("creates a reproduction with challenged result", async () => {
    const target = makeContribution({ summary: "Experiment" });
    await deps.contributionStore.put(target);

    const result = await callTool(server, "grove_reproduce", {
      targetCid: target.cid,
      summary: "Could not reproduce",
      result: "challenged",
      agent: { agentId: "reproducer-1" },
      artifacts: {},
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.result).toBe("challenged");
  });

  test("creates a reproduction with partial result", async () => {
    const target = makeContribution({ summary: "Experiment" });
    await deps.contributionStore.put(target);

    const result = await callTool(server, "grove_reproduce", {
      targetCid: target.cid,
      summary: "Partial reproduction",
      result: "partial",
      agent: { agentId: "reproducer-1" },
      artifacts: {},
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.result).toBe("partial");
  });

  test("defaults to confirmed when result omitted", async () => {
    const target = makeContribution({ summary: "Experiment" });
    await deps.contributionStore.put(target);

    const result = await callTool(server, "grove_reproduce", {
      targetCid: target.cid,
      summary: "Reproduced it",
      agent: { agentId: "reproducer-1" },
      artifacts: {},
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.result).toBe("confirmed");
  });

  test("returns not-found for non-existent target", async () => {
    const result = await callTool(server, "grove_reproduce", {
      targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      summary: "Cannot reproduce",
      result: "confirmed",
      agent: { agentId: "reproducer-1" },
      artifacts: {},
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found");
  });

  test("creates reproduction with artifacts", async () => {
    const target = makeContribution({ summary: "Experiment" });
    await deps.contributionStore.put(target);
    const hash = await storeTestContent(deps.cas, "reproduction output");

    const result = await callTool(server, "grove_reproduce", {
      targetCid: target.cid,
      summary: "Reproduced with output",
      result: "confirmed",
      artifacts: { "output.log": hash },
      agent: { agentId: "reproducer-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.kind).toBe("reproduction");
  });
});

// ---------------------------------------------------------------------------
// grove_adopt
// ---------------------------------------------------------------------------

describe("grove_adopt", () => {
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

  test("adopts an existing contribution", async () => {
    const target = makeContribution({ summary: "Great work to adopt" });
    await deps.contributionStore.put(target);

    const result = await callTool(server, "grove_adopt", {
      targetCid: target.cid,
      summary: "Adopting this as the base for my implementation",
      agent: { agentId: "adopter-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.kind).toBe("adoption");
    expect(data.targetCid).toBe(target.cid);
    expect(data.cid).toMatch(/^blake3:/);
  });

  test("returns not-found for non-existent target", async () => {
    const result = await callTool(server, "grove_adopt", {
      targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      summary: "Adopting nothing",
      agent: { agentId: "adopter-1" },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found");
  });

  test("adopts with description and tags", async () => {
    const target = makeContribution({ summary: "Base contribution" });
    await deps.contributionStore.put(target);

    const result = await callTool(server, "grove_adopt", {
      targetCid: target.cid,
      summary: "Building on this for feature X",
      description: "This contribution has the right architecture for our needs",
      tags: ["feature-x"],
      agent: { agentId: "adopter-1", role: "coder" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.kind).toBe("adoption");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeContribution } from "../../core/test-helpers.js";
import type { McpDeps } from "../deps.js";
import { McpErrorCode } from "../error-handler.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps, storeTestContent } from "../test-helpers.js";
import { registerContributionTools } from "./contributions.js";

/** Helper to call a tool handler directly via a test McpServer. */
async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean | undefined; text: string }> {
  // Access the registered tool's handler via the server's internal state
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

describe("grove_contribute", () => {
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

  test("creates a work contribution", async () => {
    const result = await callTool(server, "grove_contribute", {
      kind: "work",
      mode: "evaluation",
      summary: "Test work",
      tags: ["test"],
      relations: [],
      artifacts: {},
      agent: { agentId: "agent-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.cid).toMatch(/^blake3:/);
    expect(data.kind).toBe("work");
    expect(data.summary).toBe("Test work");
  });

  test("validates artifact hashes exist in CAS", async () => {
    const result = await callTool(server, "grove_contribute", {
      kind: "work",
      mode: "evaluation",
      summary: "Bad artifacts",
      tags: [],
      relations: [],
      artifacts: {
        "file.txt": "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      },
      agent: { agentId: "agent-1" },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(McpErrorCode.ValidationError);
    expect(result.text).toContain("non-existent hash");
  });

  test("creates contribution with valid artifact hash", async () => {
    const hash = await storeTestContent(deps.cas, "hello world");

    const result = await callTool(server, "grove_contribute", {
      kind: "work",
      mode: "evaluation",
      summary: "With artifact",
      tags: [],
      relations: [],
      artifacts: { "file.txt": hash },
      agent: { agentId: "agent-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.artifactCount).toBe(1);
  });

  test("validates relation target CIDs exist", async () => {
    const result = await callTool(server, "grove_contribute", {
      kind: "work",
      mode: "evaluation",
      summary: "Bad relation",
      tags: [],
      relations: [
        {
          targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
          relationType: "derives_from",
        },
      ],
      artifacts: {},
      agent: { agentId: "agent-1" },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(McpErrorCode.ValidationError);
    expect(result.text).toContain("Relation target not found");
  });

  test("creates contribution with valid relation", async () => {
    // Create parent first
    const parent = makeContribution({ summary: "Parent" });
    await deps.contributionStore.put(parent);

    const result = await callTool(server, "grove_contribute", {
      kind: "work",
      mode: "evaluation",
      summary: "Child",
      tags: [],
      relations: [{ targetCid: parent.cid, relationType: "derives_from" }],
      artifacts: {},
      agent: { agentId: "agent-1" },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.relationCount).toBe(1);
  });
});

describe("grove_review", () => {
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

  test("creates a review of an existing contribution", async () => {
    const target = makeContribution({ summary: "Target work" });
    await deps.contributionStore.put(target);

    const result = await callTool(server, "grove_review", {
      targetCid: target.cid,
      summary: "Looks good",
      agent: { agentId: "reviewer-1" },
      tags: [],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.kind).toBe("review");
    expect(data.targetCid).toBe(target.cid);
  });

  test("returns not-found for non-existent target", async () => {
    const result = await callTool(server, "grove_review", {
      targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      summary: "Review of nothing",
      agent: { agentId: "reviewer-1" },
      tags: [],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(McpErrorCode.NotFound);
  });

  test("creates review with scores and metadata", async () => {
    const target = makeContribution({ summary: "Target" });
    await deps.contributionStore.put(target);

    const result = await callTool(server, "grove_review", {
      targetCid: target.cid,
      summary: "Detailed review",
      scores: { quality: { value: 0.8, direction: "maximize" } },
      metadata: { score: 0.8 },
      agent: { agentId: "reviewer-1" },
      tags: ["code-review"],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.kind).toBe("review");
  });
});

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
      tags: [],
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
      tags: [],
      artifacts: {},
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.result).toBe("challenged");
  });

  test("returns not-found for non-existent target", async () => {
    const result = await callTool(server, "grove_reproduce", {
      targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      summary: "Cannot reproduce",
      result: "confirmed",
      agent: { agentId: "reproducer-1" },
      tags: [],
      artifacts: {},
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(McpErrorCode.NotFound);
  });
});

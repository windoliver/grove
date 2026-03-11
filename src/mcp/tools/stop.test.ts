import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createContribution } from "../../core/manifest.js";
import { ContributionKind, ContributionMode, ScoreDirection } from "../../core/models.js";
import type { McpDeps } from "../deps.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerStopTools } from "./stop.js";

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

describe("grove_check_stop", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns stopped=false when no contract is defined", async () => {
    // deps.contract is undefined by default from createTestMcpDeps
    registerStopTools(server, deps);

    const result = await callTool(server, "grove_check_stop", {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.stopped).toBe(false);
    expect(data.reason).toContain("No GROVE.md contract");
    expect(data.conditions).toEqual({});
    expect(data.evaluatedAt).toBeDefined();
  });

  test("returns stopped=false when stop conditions are not met", async () => {
    const depsWithContract: McpDeps = {
      ...deps,
      contract: {
        contractVersion: 2,
        name: "test-grove",
        description: "Test",
        mode: ContributionMode.Evaluation,
        metrics: {
          throughput: {
            direction: ScoreDirection.Maximize,
            unit: "ops/sec",
          },
        },
        stopConditions: {
          targetMetric: { metric: "throughput", value: 10000 },
          budget: { maxContributions: 100 },
        },
      },
    };
    registerStopTools(server, depsWithContract);

    // Add a contribution that doesn't meet the target
    const contribution = createContribution({
      kind: ContributionKind.Work,
      mode: ContributionMode.Evaluation,
      summary: "Test work",
      artifacts: {},
      relations: [],
      scores: {
        throughput: { value: 500, direction: ScoreDirection.Maximize, unit: "ops/sec" },
      },
      tags: ["test"],
      agent: { agentId: "test-agent" },
      createdAt: new Date().toISOString(),
    });
    await deps.contributionStore.put(contribution);

    const result = await callTool(server, "grove_check_stop", {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.stopped).toBe(false);
    expect(data.evaluatedAt).toBeDefined();
  });

  test("returns stopped=true when target metric is met", async () => {
    const depsWithContract: McpDeps = {
      ...deps,
      contract: {
        contractVersion: 2,
        name: "test-grove",
        description: "Test",
        mode: ContributionMode.Evaluation,
        metrics: {
          throughput: {
            direction: ScoreDirection.Maximize,
            unit: "ops/sec",
          },
        },
        stopConditions: {
          targetMetric: { metric: "throughput", value: 1000 },
        },
      },
    };
    registerStopTools(server, depsWithContract);

    // Add a contribution that exceeds the target
    const contribution = createContribution({
      kind: ContributionKind.Work,
      mode: ContributionMode.Evaluation,
      summary: "High throughput work",
      artifacts: {},
      relations: [],
      scores: {
        throughput: { value: 2000, direction: ScoreDirection.Maximize, unit: "ops/sec" },
      },
      tags: ["test"],
      agent: { agentId: "test-agent" },
      createdAt: new Date().toISOString(),
    });
    await deps.contributionStore.put(contribution);

    const result = await callTool(server, "grove_check_stop", {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.stopped).toBe(true);
    expect(data.reason).toContain("target_metric");
  });

  test("returns stopped=true when budget is exhausted", async () => {
    const depsWithContract: McpDeps = {
      ...deps,
      contract: {
        contractVersion: 2,
        name: "test-grove",
        description: "Test",
        mode: ContributionMode.Evaluation,
        stopConditions: {
          budget: { maxContributions: 2 },
        },
      },
    };
    registerStopTools(server, depsWithContract);

    // Add 2 contributions to meet the budget limit
    for (let i = 0; i < 2; i++) {
      const contribution = createContribution({
        kind: ContributionKind.Work,
        mode: ContributionMode.Evaluation,
        summary: `Work ${i}`,
        artifacts: {},
        relations: [],
        scores: {},
        tags: ["test"],
        agent: { agentId: "test-agent" },
        createdAt: new Date().toISOString(),
      });
      await deps.contributionStore.put(contribution);
    }

    const result = await callTool(server, "grove_check_stop", {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.stopped).toBe(true);
    expect(data.reason).toContain("budget");
  });

  test("returns conditions map with each condition's status", async () => {
    const depsWithContract: McpDeps = {
      ...deps,
      contract: {
        contractVersion: 2,
        name: "test-grove",
        description: "Test",
        mode: ContributionMode.Evaluation,
        metrics: {
          throughput: {
            direction: ScoreDirection.Maximize,
            unit: "ops/sec",
          },
        },
        stopConditions: {
          targetMetric: { metric: "throughput", value: 10000 },
          budget: { maxContributions: 100 },
        },
      },
    };
    registerStopTools(server, depsWithContract);

    const contribution = createContribution({
      kind: ContributionKind.Work,
      mode: ContributionMode.Evaluation,
      summary: "Test",
      artifacts: {},
      relations: [],
      scores: {
        throughput: { value: 100, direction: ScoreDirection.Maximize, unit: "ops/sec" },
      },
      tags: [],
      agent: { agentId: "test-agent" },
      createdAt: new Date().toISOString(),
    });
    await deps.contributionStore.put(contribution);

    const result = await callTool(server, "grove_check_stop", {});
    const data = JSON.parse(result.text);

    expect(data.conditions.target_metric).toBeDefined();
    expect(data.conditions.target_metric.met).toBe(false);
    expect(data.conditions.budget).toBeDefined();
    expect(data.conditions.budget.met).toBe(false);
  });
});

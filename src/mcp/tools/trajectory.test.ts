import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "../deps.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerTrajectoryTools } from "./trajectory.js";

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
  return { isError: result.isError, text: result.content[0]?.text ?? "" };
}

describe("grove_check_trajectory", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    deps = testDeps.deps;
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerTrajectoryTools(server, deps);
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns trajectory report JSON", async () => {
    const dir = await mkdtemp(join(testDeps.tempDir, "trajectory-mcp-"));
    const transcriptPath = join(dir, "transcript.jsonl");
    const specPath = join(dir, "spec.yaml");
    await writeFile(transcriptPath, '{"event":"ASSISTANT_MESSAGE","message":"done"}\n', "utf8");
    await writeFile(specPath, "name: local\nrules: []\n", "utf8");

    const result = await callTool(server, "grove_check_trajectory", {
      transcriptPath,
      specPaths: [specPath],
      runtime: "subprocess",
      format: "json",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.report.eventCount).toBe(1);
  });

  test("uses bundled default spec when specPaths is omitted", async () => {
    const transcriptPath = join(testDeps.tempDir, "transcript.jsonl");
    await writeFile(transcriptPath, '{"event":"ASSISTANT_MESSAGE","message":"done"}\n', "utf8");

    const result = await callTool(server, "grove_check_trajectory", {
      transcriptPath,
      runtime: "subprocess",
      format: "json",
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.text);
    expect(data.report.name).toBe("common");
    expect(data.report.specPaths[0]).toEndWith(join("spec", "trajectory", "common.yaml"));
  });

  test("rejects transcript paths outside the workspace boundary", async () => {
    const result = await callTool(server, "grove_check_trajectory", {
      transcriptPath: join(tmpdir(), "trajectory-outside-transcript.jsonl"),
      runtime: "subprocess",
      format: "json",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Path containment violation");
  });

  test("rejects spec paths outside the workspace boundary", async () => {
    const transcriptPath = join(testDeps.tempDir, "transcript.jsonl");
    await writeFile(transcriptPath, '{"event":"ASSISTANT_MESSAGE","message":"done"}\n', "utf8");

    const result = await callTool(server, "grove_check_trajectory", {
      transcriptPath,
      specPaths: [join(tmpdir(), "trajectory-outside-spec.yaml")],
      runtime: "subprocess",
      format: "json",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Path containment violation");
  });

  test("rejects annotated log paths outside the workspace boundary", async () => {
    const transcriptPath = join(testDeps.tempDir, "transcript.jsonl");
    const specPath = join(testDeps.tempDir, "spec.yaml");
    await writeFile(transcriptPath, '{"event":"ASSISTANT_MESSAGE","message":"done"}\n', "utf8");
    await writeFile(specPath, "name: local\nrules: []\n", "utf8");

    const result = await callTool(server, "grove_check_trajectory", {
      transcriptPath,
      specPaths: [specPath],
      runtime: "subprocess",
      format: "json",
      annotatedLogPath: join(tmpdir(), "trajectory-outside.log"),
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Path containment violation");
  });
});

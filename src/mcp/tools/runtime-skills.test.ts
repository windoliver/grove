import { afterEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  RuntimeSkillAcquisitionError,
  type RuntimeSkillAcquisitionService,
} from "../../core/runtime-skill-acquisition.js";
import type { McpDeps } from "../deps.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerRuntimeSkillTools } from "./runtime-skills.js";

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

describe("grove_request_skill", () => {
  let testDeps: TestMcpDeps | undefined;
  const originalRole = process.env.GROVE_AGENT_ROLE;
  const originalAgent = process.env.GROVE_AGENT_ID;
  const originalSession = process.env.GROVE_SESSION_ID;

  afterEach(async () => {
    if (originalRole === undefined) delete process.env.GROVE_AGENT_ROLE;
    else process.env.GROVE_AGENT_ROLE = originalRole;
    if (originalAgent === undefined) delete process.env.GROVE_AGENT_ID;
    else process.env.GROVE_AGENT_ID = originalAgent;
    if (originalSession === undefined) delete process.env.GROVE_SESSION_ID;
    else process.env.GROVE_SESSION_ID = originalSession;
    await testDeps?.cleanup();
    testDeps = undefined;
  });

  test("binds trusted caller context from env and cwd", async () => {
    testDeps = await createTestMcpDeps();
    process.env.GROVE_AGENT_ROLE = "coder";
    process.env.GROVE_AGENT_ID = "agent-1";
    process.env.GROVE_SESSION_ID = "session-1";

    const calls: unknown[] = [];
    const runtimeSkillService: RuntimeSkillAcquisitionService = {
      requestSkill: async (input) => {
        calls.push(input);
        return {
          skillName: input.skillName,
          status: "installed",
          source: "bundled",
          sessionPersisted: true,
          providerReload: { status: "context-returned", message: "use returned content" },
          installedTargets: [".codex/skills/review", ".claude/skills/review"],
          skill: { name: "review", skillMd: "review skill", truncated: false },
          warnings: [],
        };
      },
    };
    const deps: McpDeps = { ...testDeps.deps, runtimeSkillService };
    const server = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerRuntimeSkillTools(server, deps);

    const result = await callTool(server, "grove_request_skill", { skillName: "review" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text).skill.skillMd).toBe("review skill");
    expect(calls).toEqual([
      {
        skillName: "review",
        caller: {
          role: "coder",
          agentId: "agent-1",
          sessionId: "session-1",
          workspacePath: process.cwd(),
        },
      },
    ]);
  });

  test("returns NOT_CONFIGURED when service is absent", async () => {
    testDeps = await createTestMcpDeps();
    const server = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerRuntimeSkillTools(server, testDeps.deps);

    const result = await callTool(server, "grove_request_skill", { skillName: "review" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("[NOT_CONFIGURED]");
  });

  test("preserves runtime skill persistence recovery metadata in error response", async () => {
    testDeps = await createTestMcpDeps();
    process.env.GROVE_AGENT_ROLE = "coder";
    const runtimeSkillService: RuntimeSkillAcquisitionService = {
      requestSkill: async () => {
        throw new RuntimeSkillAcquisitionError("SESSION_PERSIST_FAILED", "persist failed", {
          workspaceInstalled: true,
          installedTargets: [".claude/skills/review", ".codex/skills/review"],
        });
      },
    };
    const server = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerRuntimeSkillTools(server, { ...testDeps.deps, runtimeSkillService });

    const result = await callTool(server, "grove_request_skill", { skillName: "review" });
    const payload = JSON.parse(result.text) as {
      code: string;
      message: string;
      workspaceInstalled: boolean;
      installedTargets: readonly string[];
    };

    expect(result.isError).toBe(true);
    expect(payload).toEqual({
      code: "SESSION_PERSIST_FAILED",
      message: "persist failed",
      workspaceInstalled: true,
      installedTargets: [".claude/skills/review", ".codex/skills/review"],
    });
  });
});

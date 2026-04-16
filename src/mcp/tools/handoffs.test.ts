/**
 * Tests for grove_ack_handoff role authorization.
 *
 * Only the target role (handoff.toRole) may mark a handoff seen/acked.
 * Cross-role ack attempts must be rejected with PERMISSION_DENIED.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { InMemoryHandoffStore } from "../../core/in-memory-handoff-store.js";
import type { McpDeps } from "../deps.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerHandoffTools } from "./handoffs.js";

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

describe("grove_ack_handoff authorization", () => {
  let testDeps: TestMcpDeps;
  let deps: McpDeps;
  let server: McpServer;
  let handoffStore: InMemoryHandoffStore;
  let handoffId: string;
  const originalRole = process.env.GROVE_AGENT_ROLE;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    handoffStore = new InMemoryHandoffStore();
    deps = { ...testDeps.deps, handoffStore };
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerHandoffTools(server, deps);

    // Seed a handoff addressed to "reviewer"
    const h = await handoffStore.create({
      sourceCid: "blake3:test",
      fromRole: "coder",
      toRole: "reviewer",
    });
    handoffId = h.handoffId;
  });

  afterEach(async () => {
    if (originalRole === undefined) {
      delete process.env.GROVE_AGENT_ROLE;
    } else {
      process.env.GROVE_AGENT_ROLE = originalRole;
    }
    await testDeps.cleanup();
  });

  test("rejects cross-role ack attempts", async () => {
    // Caller role is "coder" but handoff is addressed to "reviewer"
    process.env.GROVE_AGENT_ROLE = "coder";
    const result = await callTool(server, "grove_ack_handoff", {
      handoffId,
      level: "acked",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("PERMISSION_DENIED");
    // Handoff state must not have changed
    const after = await handoffStore.get(handoffId);
    expect(after?.ackedAt).toBeUndefined();
    expect(after?.seenAt).toBeUndefined();
  });

  test("rejects when caller role is unset", async () => {
    delete process.env.GROVE_AGENT_ROLE;
    const result = await callTool(server, "grove_ack_handoff", {
      handoffId,
      level: "seen",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("PERMISSION_DENIED");
  });

  test("allows ack when caller role matches toRole", async () => {
    process.env.GROVE_AGENT_ROLE = "reviewer";
    const result = await callTool(server, "grove_ack_handoff", {
      handoffId,
      level: "acked",
    });
    expect(result.isError).toBeUndefined();
    const after = await handoffStore.get(handoffId);
    expect(after?.ackedAt).toBeDefined();
    expect(after?.seenAt).toBeDefined(); // auto-filled
  });

  test("allows seen when caller role matches toRole", async () => {
    process.env.GROVE_AGENT_ROLE = "reviewer";
    const result = await callTool(server, "grove_ack_handoff", {
      handoffId,
      level: "seen",
    });
    expect(result.isError).toBeUndefined();
    const after = await handoffStore.get(handoffId);
    expect(after?.seenAt).toBeDefined();
    expect(after?.ackedAt).toBeUndefined();
  });

  test("grove_ack_handoff is NOT registered when includeAckTool is false (HTTP)", () => {
    // Simulate HTTP transport registration — ack tool must be omitted.
    const httpServer = new McpServer(
      { name: "test-http", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerHandoffTools(httpServer, deps, { includeAckTool: false });
    const registeredTools = (
      httpServer as unknown as { _registeredTools: Record<string, unknown> }
    )._registeredTools;
    expect(registeredTools["grove_list_handoffs"]).toBeDefined();
    expect(registeredTools["grove_get_handoff"]).toBeDefined();
    expect(registeredTools["grove_ack_handoff"]).toBeUndefined();
  });
});

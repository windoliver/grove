/**
 * Tests for grove_ack_handoff role authorization.
 *
 * Only the target role (handoff.toRole) may mark a handoff seen/acked.
 * Cross-role ack attempts must be rejected with PERMISSION_DENIED.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { HandoffStatus } from "../../core/handoff.js";
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

class ExpireTrackingHandoffStore extends InMemoryHandoffStore {
  expireCalls = 0;

  override async expireStale(now?: string) {
    this.expireCalls += 1;
    return super.expireStale(now);
  }
}

class SessionCheckThrowingHandoffStore extends InMemoryHandoffStore {
  override async isInCurrentSession(_handoffId: string): Promise<boolean> {
    throw new Error("isInCurrentSession should not be called by MCP handoff tools");
  }
}

class BlockingExpireHandoffStore extends InMemoryHandoffStore {
  expireCalls = 0;
  private readonly releaseSweep: Promise<void>;
  private resolveReleaseSweep!: () => void;
  readonly sweepStarted: Promise<void>;
  private resolveSweepStarted!: () => void;

  constructor() {
    super();
    this.releaseSweep = new Promise((resolve) => {
      this.resolveReleaseSweep = resolve;
    });
    this.sweepStarted = new Promise((resolve) => {
      this.resolveSweepStarted = resolve;
    });
  }

  unblock(): void {
    this.resolveReleaseSweep();
  }

  override async expireStale(now?: string) {
    this.expireCalls += 1;
    this.resolveSweepStarted();
    await this.releaseSweep;
    return super.expireStale(now);
  }
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
    const registeredTools = (httpServer as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(registeredTools.grove_list_handoffs).toBeDefined();
    expect(registeredTools.grove_get_handoff).toBeDefined();
    expect(registeredTools.grove_ack_handoff).toBeUndefined();
  });

  test("grove_list_handoffs schema accepts operator terminal status filters", () => {
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { inputSchema: { safeParse(input: unknown): { success: boolean } } }
        >;
      }
    )._registeredTools;
    const schema = registeredTools.grove_list_handoffs?.inputSchema;
    if (schema === undefined) throw new Error("grove_list_handoffs was not registered");

    expect(schema.safeParse({ status: HandoffStatus.Cancelled }).success).toBe(true);
    expect(schema.safeParse({ status: HandoffStatus.ManuallyResolved }).success).toBe(true);
  });
});

describe("handoff tool hot paths", () => {
  let testDeps: TestMcpDeps;

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("grove_list_handoffs throttles inline expiry sweeps", async () => {
    testDeps = await createTestMcpDeps();
    const handoffStore = new ExpireTrackingHandoffStore();
    await handoffStore.create({
      sourceCid: "blake3:list",
      fromRole: "coder",
      toRole: "reviewer",
    });

    const server = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerHandoffTools(server, { ...testDeps.deps, handoffStore });

    await callTool(server, "grove_list_handoffs", {});
    await callTool(server, "grove_list_handoffs", {});

    expect(handoffStore.expireCalls).toBe(1);
  });

  test("grove_list_handoffs skips inline expiry when deadline handling is managed", async () => {
    testDeps = await createTestMcpDeps();
    const handoffStore = new ExpireTrackingHandoffStore();
    const server = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerHandoffTools(server, {
      ...testDeps.deps,
      handoffStore,
      deadlineWatcher: {} as NonNullable<McpDeps["deadlineWatcher"]>,
      handoffExpiryManaged: true,
    });

    await callTool(server, "grove_list_handoffs", {});

    expect(handoffStore.expireCalls).toBe(0);
  });

  test("grove_list_handoffs skips inline expiry when expiry is managed externally", async () => {
    testDeps = await createTestMcpDeps();
    const handoffStore = new ExpireTrackingHandoffStore();
    const server = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerHandoffTools(server, {
      ...testDeps.deps,
      handoffStore,
      handoffExpiryManaged: true,
    });

    await callTool(server, "grove_list_handoffs", {});

    expect(handoffStore.expireCalls).toBe(0);
  });

  test("grove_list_handoffs reuses an in-flight expiry sweep", async () => {
    testDeps = await createTestMcpDeps();
    const handoffStore = new BlockingExpireHandoffStore();
    await handoffStore.create({
      sourceCid: "blake3:concurrent-list",
      fromRole: "coder",
      toRole: "reviewer",
    });

    const server = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerHandoffTools(server, { ...testDeps.deps, handoffStore });

    const firstList = callTool(server, "grove_list_handoffs", {});
    await handoffStore.sweepStarted;
    const secondList = callTool(server, "grove_list_handoffs", {});

    expect(handoffStore.expireCalls).toBe(1);

    handoffStore.unblock();
    await Promise.all([firstList, secondList]);
    expect(handoffStore.expireCalls).toBe(1);
  });

  test("grove_ack_handoff does not re-check session ownership on scoped stores", async () => {
    testDeps = await createTestMcpDeps();
    const handoffStore = new SessionCheckThrowingHandoffStore();
    const server = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerHandoffTools(server, { ...testDeps.deps, handoffStore });
    const originalRole = process.env.GROVE_AGENT_ROLE;

    try {
      const handoff = await handoffStore.create({
        sourceCid: "blake3:ack",
        fromRole: "coder",
        toRole: "reviewer",
      });
      process.env.GROVE_AGENT_ROLE = "reviewer";

      const result = await callTool(server, "grove_ack_handoff", {
        handoffId: handoff.handoffId,
        level: "acked",
      });

      expect(result.isError).toBeUndefined();
    } finally {
      if (originalRole === undefined) {
        delete process.env.GROVE_AGENT_ROLE;
      } else {
        process.env.GROVE_AGENT_ROLE = originalRole;
      }
    }
  });

  test("grove_process_handoff does not re-check session ownership on scoped stores", async () => {
    testDeps = await createTestMcpDeps();
    const handoffStore = new SessionCheckThrowingHandoffStore();
    const server = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerHandoffTools(server, { ...testDeps.deps, handoffStore });
    const originalRole = process.env.GROVE_AGENT_ROLE;

    try {
      const handoff = await handoffStore.create({
        sourceCid: "blake3:process",
        fromRole: "coder",
        toRole: "reviewer",
      });
      await handoffStore.markDelivered(handoff.handoffId);
      process.env.GROVE_AGENT_ROLE = "reviewer";

      const result = await callTool(server, "grove_process_handoff", {
        handoffId: handoff.handoffId,
      });

      expect(result.isError).toBeUndefined();
    } finally {
      if (originalRole === undefined) {
        delete process.env.GROVE_AGENT_ROLE;
      } else {
        process.env.GROVE_AGENT_ROLE = originalRole;
      }
    }
  });
});

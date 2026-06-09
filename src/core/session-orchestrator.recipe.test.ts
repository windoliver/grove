import { describe, expect, test } from "bun:test";
import { LocalEventBus } from "./local-event-bus.js";
import { MockRuntime } from "./mock-runtime.js";
import { SessionOrchestrator } from "./session-orchestrator.js";
import type { AgentTopology } from "./topology.js";

const singleCoderTopology: AgentTopology = {
  structure: "flat",
  roles: [
    {
      name: "coder",
      description: "Write code",
      command: "echo coder",
    },
  ],
};

describe("SessionOrchestrator — extraMcpServers from recipes", () => {
  test("extraMcpServers are appended after grove server in spawned agent config", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();

    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract: {
        contractVersion: 2,
        name: "test",
        topology: singleCoderTopology,
      },
      topology: singleCoderTopology,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      repos: [{ kind: "local", path: "/tmp" }],
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
      extraMcpServers: [{ name: "fs", command: "grove-fs-mcp", args: [] }],
    });

    await orchestrator.start();

    const coderConfig = runtime.spawnCalls.find((call) => call.role === "coder")?.config;
    expect(coderConfig?.mcpServers).toBeDefined();

    const names = coderConfig!.mcpServers!.map((s) => s.name);
    expect(names[0]).toBe("grove");
    expect(names).toContain("fs");

    bus.close();
  });

  test("no extraMcpServers leaves only the grove server (backward compat)", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();

    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract: {
        contractVersion: 2,
        name: "test",
        topology: singleCoderTopology,
      },
      topology: singleCoderTopology,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      repos: [{ kind: "local", path: "/tmp" }],
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
    });

    await orchestrator.start();

    const coderConfig = runtime.spawnCalls.find((call) => call.role === "coder")?.config;
    expect(coderConfig?.mcpServers).toHaveLength(1);
    expect(coderConfig?.mcpServers?.[0]?.name).toBe("grove");

    bus.close();
  });

  test("multiple extraMcpServers are all appended after grove in order", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();

    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract: {
        contractVersion: 2,
        name: "test",
        topology: singleCoderTopology,
      },
      topology: singleCoderTopology,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      repos: [{ kind: "local", path: "/tmp" }],
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
      extraMcpServers: [
        { name: "fs", command: "grove-fs-mcp", args: [] },
        { name: "search", command: "grove-search-mcp", args: ["--index", "/data"] },
      ],
    });

    await orchestrator.start();

    const coderConfig = runtime.spawnCalls.find((call) => call.role === "coder")?.config;
    expect(coderConfig?.mcpServers).toHaveLength(3);

    const names = coderConfig!.mcpServers!.map((s) => s.name);
    expect(names[0]).toBe("grove");
    expect(names[1]).toBe("fs");
    expect(names[2]).toBe("search");

    bus.close();
  });
});

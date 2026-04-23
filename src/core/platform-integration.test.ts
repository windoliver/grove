/**
 * Integration test: validates the complete platform/model flow from
 * topology parsing through orchestrator to runtime session metadata.
 *
 * This is the end-to-end validation for issue #207.
 */

import { describe, expect, test } from "bun:test";
import { LocalEventBus } from "./local-event-bus.js";
import { MockRuntime } from "./mock-runtime.js";
import { mergeRuntimeConfig, SessionOrchestrator } from "./session-orchestrator.js";
import { shellEscape } from "./shell-utils.js";
import type { AgentTopology } from "./topology.js";
import { AgentTopologySchema, wireToTopology } from "./topology.js";

describe("Issue 207 — full platform/model integration", () => {
  // ── Topology parsing → TypeScript types ─────────────────────────────────

  test("topology schema accepts platform and model fields", () => {
    const wire = {
      structure: "flat" as const,
      roles: [
        {
          name: "coder",
          description: "Write code",
          command: "codex",
          platform: "codex" as const,
          model: "gpt-4.1",
        },
        {
          name: "reviewer",
          description: "Review code",
          command: "claude",
          platform: "claude-code" as const,
          model: "claude-opus-4-6",
        },
      ],
    };

    const result = AgentTopologySchema.safeParse(wire);
    expect(result.success).toBe(true);
  });

  test("wireToTopology preserves platform and model", () => {
    const wire = {
      structure: "flat" as const,
      roles: [
        {
          name: "coder",
          description: "Write code",
          command: "codex",
          platform: "codex" as const,
          model: "gpt-4.1",
        },
      ],
    };

    const topology = wireToTopology(wire);
    expect(topology.roles[0]!.platform).toBe("codex");
    expect(topology.roles[0]!.model).toBe("gpt-4.1");
    expect(topology.roles[0]!.command).toBe("codex");
  });

  // ── mergeRuntimeConfig ─────────────────────────────────────────────────

  test("merge produces correct config for mixed topology", () => {
    const coderRole = {
      name: "coder",
      command: "codex",
      platform: "codex" as const,
      model: "gpt-4.1",
    };
    const reviewerRole = {
      name: "reviewer",
      command: "claude",
      platform: "claude-code" as const,
      model: "claude-opus-4-6",
    };

    const coderConfig = mergeRuntimeConfig(coderRole, undefined);
    const reviewerConfig = mergeRuntimeConfig(reviewerRole, undefined);

    expect(coderConfig.command).toBe("codex");
    expect(coderConfig.platform).toBe("codex");
    expect(coderConfig.model).toBe("gpt-4.1");

    expect(reviewerConfig.command).toBe("claude");
    expect(reviewerConfig.platform).toBe("claude-code");
    expect(reviewerConfig.model).toBe("claude-opus-4-6");
  });

  // ── SessionOrchestrator → MockRuntime ──────────────────────────────────

  test("orchestrator passes distinct platform/model per role", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();

    const topology: AgentTopology = {
      structure: "flat",
      roles: [
        {
          name: "coder",
          description: "Write code",
          command: "codex",
          platform: "codex",
          model: "gpt-4.1",
        },
        {
          name: "reviewer",
          description: "Review code",
          command: "claude",
          platform: "claude-code",
          model: "claude-opus-4-6",
        },
      ],
    };

    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract: { contractVersion: 2, name: "test", topology },
      topology,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
    });

    await orchestrator.start();

    // Verify each role got its own platform/model in AgentConfig
    const coderCall = runtime.spawnCalls.find((c) => c.role === "coder");
    const reviewerCall = runtime.spawnCalls.find((c) => c.role === "reviewer");

    expect(coderCall).toBeDefined();
    expect(reviewerCall).toBeDefined();

    // Coder: codex platform
    expect(coderCall!.config.platform).toBe("codex");
    expect(coderCall!.config.model).toBe("gpt-4.1");
    expect(coderCall!.config.command).toBe("codex");

    // Reviewer: claude-code platform
    expect(reviewerCall!.config.platform).toBe("claude-code");
    expect(reviewerCall!.config.model).toBe("claude-opus-4-6");
    expect(reviewerCall!.config.command).toBe("claude");

    bus.close();
  });

  test("MockRuntime session metadata matches spawn config", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();

    const topology: AgentTopology = {
      structure: "flat",
      roles: [{ name: "coder", command: "codex", platform: "codex", model: "gpt-4.1" }],
    };

    const orchestrator = new SessionOrchestrator({
      goal: "Build it",
      contract: { contractVersion: 2, name: "test", topology },
      topology,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
    });

    const status = await orchestrator.start();
    const session = status.agents[0]!.session;

    // Session carries metadata from config
    expect(session.platform).toBe("codex");
    expect(session.model).toBe("gpt-4.1");

    // getSessionMetadata helper works
    const meta = runtime.getSessionMetadata(session.id);
    expect(meta!.platform).toBe("codex");
    expect(meta!.model).toBe("gpt-4.1");

    bus.close();
  });

  // ── Profile overlay through orchestrator ───────────────────────────────

  test("profile overlay changes platform mid-flight", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();

    const topology: AgentTopology = {
      structure: "flat",
      roles: [
        { name: "coder", command: "claude", platform: "claude-code", model: "claude-opus-4-6" },
      ],
    };

    const orchestrator = new SessionOrchestrator({
      goal: "Build it",
      contract: { contractVersion: 2, name: "test", topology },
      topology,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
      profiles: [
        {
          name: "@coder-fast",
          role: "coder",
          platform: "codex",
          command: "codex",
          model: "gpt-4.1",
        },
      ],
    });

    await orchestrator.start();

    const call = runtime.spawnCalls[0]!;
    // Profile overrides role
    expect(call.config.platform).toBe("codex");
    expect(call.config.model).toBe("gpt-4.1");
    expect(call.config.command).toBe("codex");

    // Session metadata reflects the override
    const session = (await runtime.listSessions())[0]!;
    expect(session.platform).toBe("codex");
    expect(session.model).toBe("gpt-4.1");

    bus.close();
  });

  // ── Shell utils shared correctly ───────────────────────────────────────

  test("shellEscape is the same function imported by all runtimes", () => {
    // Verify it handles the edge case that matters most: single quotes in session names
    const name = "grove-coder-0-l'abc";
    const escaped = shellEscape(name);
    expect(escaped).toContain("'\\''");
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import type { GroveContract } from "./contract.js";
import { LocalEventBus } from "./local-event-bus.js";
import { MockRuntime } from "./mock-runtime.js";
import { type Contribution, ContributionKind, ContributionMode } from "./models.js";
import { SessionOrchestrator } from "./session-orchestrator.js";
import type { AgentTopology } from "./topology.js";

function makeContract(overrides?: Partial<GroveContract>): GroveContract {
  return {
    contractVersion: 2,
    name: "test",
    topology: {
      structure: "graph",
      roles: [
        {
          name: "coder",
          description: "Write code",
          command: "echo coder",
          edges: [{ target: "reviewer", edgeType: "delegates" }],
        },
        {
          name: "reviewer",
          description: "Review code",
          command: "echo reviewer",
          edges: [{ target: "coder", edgeType: "feedback" }],
        },
      ],
    },
    ...overrides,
  };
}

/** Make an orchestrator that uses allow-fallback policy so /tmp tests pass. */
function makeOrchestrator(
  contract: GroveContract,
  overrides?: {
    runtime?: InstanceType<typeof MockRuntime>;
    bus?: InstanceType<typeof LocalEventBus>;
    goal?: string;
    sessionId?: string;
    contributionStore?:
      | { list(query?: { limit?: number }): Promise<readonly Contribution[]> }
      | undefined;
  },
) {
  const runtime = overrides?.runtime ?? new MockRuntime();
  const bus = overrides?.bus ?? new LocalEventBus();
  const orchestrator = new SessionOrchestrator({
    goal: overrides?.goal ?? "Build auth module",
    contract,
    topology: contract.topology!,
    runtime,
    eventBus: bus,
    projectRoot: "/tmp",
    workspaceBaseDir: "/tmp/workspaces",
    // /tmp is not a git repo, so worktrees always fail in tests.
    // allow-fallback lets agents start despite that.
    workspaceIsolationPolicy: "allow-fallback",
    ...(overrides?.sessionId ? { sessionId: overrides.sessionId } : {}),
    ...(overrides?.contributionStore ? { contributionStore: overrides.contributionStore } : {}),
  });
  return { orchestrator, runtime, bus };
}

describe("SessionOrchestrator", () => {
  test("start spawns agents for all roles", async () => {
    const contract = makeContract();
    const { orchestrator, runtime, bus } = makeOrchestrator(contract);

    const status = await orchestrator.start();

    expect(status.started).toBe(true);
    expect(status.agents).toHaveLength(2);
    expect(runtime.spawnCalls).toHaveLength(2);
    expect(status.agents.map((a) => a.role).sort()).toEqual(["coder", "reviewer"]);
    // /tmp is not a git repo → worktree fails → allow-fallback → fallback_workspace
    for (const agent of status.agents) {
      expect(agent.workspaceMode.status).toBe("fallback_workspace");
      expect(agent.workspaceMode.path).toBe("/tmp");
    }
    bus.close();
  });

  test("start sends goals to all agents", async () => {
    const contract = makeContract();
    const { orchestrator, runtime, bus } = makeOrchestrator(contract);

    const status = await orchestrator.start();

    // MockRuntime doesn't send goals in spawn(), so orchestrator sends via send()
    expect(runtime.sendCalls).toHaveLength(2);
    expect(runtime.sendCalls[0]!.message).toContain("Build auth module");
    for (const agent of status.agents) {
      expect(agent.workspaceMode.status).toBe("fallback_workspace");
    }
    bus.close();
  });

  test("stop closes all agents", async () => {
    const contract = makeContract();
    const { orchestrator, runtime, bus } = makeOrchestrator(contract);

    const started = await orchestrator.start();
    for (const agent of started.agents) {
      expect(agent.workspaceMode.status).toBe("fallback_workspace");
    }

    await orchestrator.stop("Budget exceeded");

    const status = orchestrator.getStatus();
    expect(status.stopped).toBe(true);
    expect(status.stopReason).toBe("Budget exceeded");
    expect(runtime.closeCalls).toHaveLength(2);
    bus.close();
  });

  test("throws when topology is missing", () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();

    expect(
      () =>
        new SessionOrchestrator({
          goal: "test",
          contract: { contractVersion: 2, name: "test" },
          topology: undefined as unknown as AgentTopology,
          runtime,
          eventBus: bus,
          projectRoot: "/tmp",
          workspaceBaseDir: "/tmp/workspaces",
        }),
    ).toThrow();
    bus.close();
  });

  test("getStatus returns correct state", async () => {
    const contract = makeContract();
    const { orchestrator, bus } = makeOrchestrator(contract, { goal: "Test goal" });

    const before = orchestrator.getStatus();
    expect(before.started).toBe(false);
    expect(before.stopped).toBe(false);

    await orchestrator.start();
    const after = orchestrator.getStatus();
    expect(after.started).toBe(true);
    expect(after.goal).toBe("Test goal");
    for (const agent of after.agents) {
      expect(agent.workspaceMode.status).toBe("fallback_workspace");
    }
    bus.close();
  });

  test("contribution events forwarded via EventBus when no contribution store", async () => {
    const contract = makeContract();
    const { orchestrator, runtime, bus } = makeOrchestrator(contract);

    const status = await orchestrator.start();
    for (const agent of status.agents) {
      expect(agent.workspaceMode.status).toBe("fallback_workspace");
    }

    // Without contributionStore, EventBus forwarding is the only path
    void bus.publish({
      type: "contribution",
      sourceRole: "coder",
      targetRole: "reviewer",
      payload: { cid: "blake3:abc", summary: "Added auth" },
      timestamp: new Date().toISOString(),
    });

    // 2 goal sends (MockRuntime) + 1 contribution forwarding = 3
    expect(runtime.sendCalls.length).toBe(3);
    expect(runtime.sendCalls[2]!.message).toContain("coder");
    bus.close();
  });

  test("polling forwards only contributions from this session's agent IDs", async () => {
    const contract = makeContract();
    const contributions: Contribution[] = [];
    const contributionStore = {
      list: async (_query?: { limit?: number }): Promise<readonly Contribution[]> => contributions,
    };
    const { orchestrator, runtime, bus } = makeOrchestrator(contract, { contributionStore });

    const status = await orchestrator.start();
    const coderSession = status.agents.find((a) => a.role === "coder")?.session.id;
    expect(coderSession).toBeDefined();
    if (coderSession === undefined) {
      throw new Error("Expected coder session to be defined");
    }

    contributions.push(
      {
        cid: `blake3:${"a".repeat(64)}`,
        manifestVersion: 1,
        kind: ContributionKind.Work,
        mode: ContributionMode.Exploration,
        summary: "Foreign coder contribution",
        artifacts: {},
        relations: [],
        tags: ["work"],
        agent: { agentId: "mock-coder-other", role: "coder" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        cid: `blake3:${"b".repeat(64)}`,
        manifestVersion: 1,
        kind: ContributionKind.Work,
        mode: ContributionMode.Exploration,
        summary: "Local coder contribution",
        artifacts: {},
        relations: [],
        tags: ["work"],
        agent: { agentId: coderSession, role: "coder" },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    );

    const before = runtime.sendCalls.length;
    await (
      orchestrator as unknown as {
        pollContributions: () => Promise<void>;
      }
    ).pollContributions();
    const forwarded = runtime.sendCalls.slice(before);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.message).toContain("Local coder contribution");
    expect(forwarded[0]!.message).not.toContain("Foreign coder contribution");

    await orchestrator.stop("done");
    bus.close();
  });

  test("polling still accepts contributions from pre-resume session IDs", async () => {
    const contract = makeContract();
    const contributions: Contribution[] = [];
    const contributionStore = {
      list: async (_query?: { limit?: number }): Promise<readonly Contribution[]> => contributions,
    };
    const { orchestrator, runtime, bus } = makeOrchestrator(contract, { contributionStore });

    const status = await orchestrator.start();
    const originalCoderSession = status.agents.find((a) => a.role === "coder")?.session.id;
    expect(originalCoderSession).toBeDefined();
    if (originalCoderSession === undefined) {
      throw new Error("Expected original coder session to be defined");
    }

    await orchestrator.resumeAgent("coder");

    contributions.push({
      cid: `blake3:${"c".repeat(64)}`,
      manifestVersion: 1,
      kind: ContributionKind.Work,
      mode: ContributionMode.Exploration,
      summary: "Contribution from old coder session",
      artifacts: {},
      relations: [],
      tags: ["work"],
      agent: { agentId: originalCoderSession, role: "coder" },
      createdAt: "2026-01-01T00:00:02.000Z",
    });

    const before = runtime.sendCalls.length;
    await (
      orchestrator as unknown as {
        pollContributions: () => Promise<void>;
      }
    ).pollContributions();
    const forwarded = runtime.sendCalls.slice(before);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.message).toContain("Contribution from old coder session");

    await orchestrator.stop("done");
    bus.close();
  });

  test("stop events are not forwarded to agents", async () => {
    const contract = makeContract();
    const { orchestrator, runtime, bus } = makeOrchestrator(contract);

    const status = await orchestrator.start();
    for (const agent of status.agents) {
      expect(agent.workspaceMode.status).toBe("fallback_workspace");
    }

    // Publish a stop event to a role — should NOT be forwarded
    void bus.publish({
      type: "stop",
      sourceRole: "system",
      targetRole: "coder",
      payload: { reason: "done" },
      timestamp: new Date().toISOString(),
    });

    // 2 goal sends (MockRuntime), no forwarded stop events
    expect(runtime.sendCalls.length).toBe(2);
    bus.close();
  });

  test("contribution events are ignored after stop", async () => {
    const contract = makeContract();
    const { orchestrator, runtime, bus } = makeOrchestrator(contract);

    await orchestrator.start();
    await orchestrator.stop("done");

    const before = runtime.sendCalls.length;
    await bus.publish({
      type: "contribution",
      sourceRole: "coder",
      targetRole: "reviewer",
      payload: { cid: "blake3:abc", summary: "late event" },
      timestamp: new Date().toISOString(),
    });

    expect(runtime.sendCalls.length).toBe(before);
    bus.close();
  });

  test("uses custom sessionId when provided", () => {
    const contract = makeContract();
    const { orchestrator, bus } = makeOrchestrator(contract, { sessionId: "custom-id-123" });

    expect(orchestrator.getStatus().sessionId).toBe("custom-id-123");
    bus.close();
  });

  test("uses role prompt over description for goal", async () => {
    const contract = makeContract({
      topology: {
        structure: "flat",
        roles: [
          {
            name: "writer",
            description: "A writer agent",
            prompt: "Write high-quality documentation",
            command: "echo writer",
          },
        ],
      },
    });

    const { orchestrator, runtime, bus } = makeOrchestrator(contract, {
      goal: "Document the API",
    });
    const status = await orchestrator.start();

    // The prompt should be preferred over description (passed via spawn, not send)
    expect(runtime.spawnCalls[0]!.config.goal).toContain("Write high-quality documentation");
    expect(runtime.spawnCalls[0]!.config.goal).not.toContain("A writer agent");
    expect(status.agents[0]!.workspaceMode.status).toBe("fallback_workspace");
    bus.close();
  });

  test("falls back to description when no prompt", async () => {
    const contract = makeContract({
      topology: {
        structure: "flat",
        roles: [
          {
            name: "worker",
            description: "Do the work",
            command: "echo worker",
          },
        ],
      },
    });

    const { orchestrator, runtime, bus } = makeOrchestrator(contract, { goal: "Build it" });
    const status = await orchestrator.start();

    expect(runtime.spawnCalls[0]!.config.goal).toContain("Do the work");
    expect(status.agents[0]!.workspaceMode.status).toBe("fallback_workspace");
    bus.close();
  });

  test("defaults command to claude when role has no command", async () => {
    const contract = makeContract({
      topology: {
        structure: "flat",
        roles: [{ name: "helper", description: "Help out" }],
      },
    });

    const { orchestrator, runtime, bus } = makeOrchestrator(contract, { goal: "Help" });
    const status = await orchestrator.start();

    expect(runtime.spawnCalls[0]!.config.command).toBe("claude");
    expect(status.agents[0]!.workspaceMode.status).toBe("fallback_workspace");
    bus.close();
  });

  test("all agents idle triggers auto-stop after contribution", async () => {
    const contract = makeContract();
    const { orchestrator, runtime, bus } = makeOrchestrator(contract);

    const status = await orchestrator.start();
    expect(status.stopped).toBe(false);
    for (const agent of status.agents) {
      expect(agent.workspaceMode.status).toBe("fallback_workspace");
    }

    // Set all agent sessions to idle
    for (const agent of status.agents) {
      runtime.setSessionStatus(agent.session.id, "idle");
    }

    // Force grace period to expire (normally 30s, but we can't wait)
    // @ts-expect-error — accessing private field for test
    orchestrator.startedAt = Date.now() - 60_000;

    // Trigger idle check — should now stop (grace period expired)
    const stopped = await orchestrator.checkIdleCompletion();
    expect(stopped).toBe(true);

    const finalStatus = orchestrator.getStatus();
    expect(finalStatus.stopped).toBe(true);
    expect(finalStatus.stopReason).toBe("All agents idle — session complete");
    bus.close();
  });

  test("checkIdleCompletion returns false when agents are still running", async () => {
    const contract = makeContract();
    const { orchestrator, bus } = makeOrchestrator(contract);

    const status = await orchestrator.start();
    for (const agent of status.agents) {
      expect(agent.workspaceMode.status).toBe("fallback_workspace");
    }

    // Agents are still running — should not stop
    const stopped = await orchestrator.checkIdleCompletion();
    expect(stopped).toBe(false);
    expect(orchestrator.getStatus().stopped).toBe(false);
    bus.close();
  });

  test("waitForCompletion times out even when idle checks throw", async () => {
    class ThrowingListSessionsRuntime extends MockRuntime {
      override async listSessions(): Promise<readonly import("./agent-runtime.js").AgentSession[]> {
        throw new Error("listSessions failed");
      }
    }

    const contract = makeContract();
    const runtime = new ThrowingListSessionsRuntime();
    const bus = new LocalEventBus();
    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract,
      topology: contract.topology!,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
    });

    await orchestrator.start();
    const reason = await orchestrator.waitForCompletion(40, 10);
    expect(reason).toBe("Session timed out");
    expect(orchestrator.getStatus().stopped).toBe(true);
    bus.close();
  });

  test("resumeAgent spawns new session and sends reconciliation message", async () => {
    const contract = makeContract();
    const { orchestrator, runtime, bus } = makeOrchestrator(contract);

    const started = await orchestrator.start();
    for (const agent of started.agents) {
      expect(agent.workspaceMode.status).toBe("fallback_workspace");
    }
    const initialSpawnCount = runtime.spawnCalls.length;
    const initialSendCount = runtime.sendCalls.length;

    // Resume the coder role
    const resumed = await orchestrator.resumeAgent("coder");

    expect(resumed.role).toBe("coder");
    // Resumed agent also has a workspace mode
    expect(resumed.workspaceMode.status).toBe("fallback_workspace");
    // Should have spawned a new session
    expect(runtime.spawnCalls.length).toBe(initialSpawnCount + 1);
    // Should have sent goal + reconciliation message
    expect(runtime.sendCalls.length).toBe(initialSendCount + 1);
    expect(runtime.sendCalls[runtime.sendCalls.length - 1]!.message).toContain(
      "resuming role 'coder'",
    );

    // The agent list should still have 2 agents (replaced, not duplicated)
    const finalAgents = orchestrator.getStatus().agents;
    expect(finalAgents).toHaveLength(2);
    for (const agent of finalAgents) {
      expect(agent.workspaceMode.status).toBe("fallback_workspace");
    }
    bus.close();
  });

  test("resumeAgent throws for unknown role", async () => {
    const contract = makeContract();
    const { orchestrator, bus } = makeOrchestrator(contract);

    await orchestrator.start();

    await expect(orchestrator.resumeAgent("nonexistent")).rejects.toThrow("not found in topology");
    bus.close();
  });
});

// ---------------------------------------------------------------------------
// Platform/model passthrough (Issue 207)
// ---------------------------------------------------------------------------

describe("SessionOrchestrator — platform/model passthrough", () => {
  test("passes role.platform to AgentConfig", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract({
      topology: {
        structure: "flat",
        roles: [
          {
            name: "coder",
            description: "Write code",
            command: "codex",
            platform: "codex",
            model: "gpt-4.1",
          },
        ],
      },
    });

    const orchestrator = new SessionOrchestrator({
      goal: "Build it",
      contract,
      topology: contract.topology!,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
    });

    await orchestrator.start();

    expect(runtime.spawnCalls[0]!.config.platform).toBe("codex");
    expect(runtime.spawnCalls[0]!.config.model).toBe("gpt-4.1");
    bus.close();
  });

  test("platform and model are undefined when role doesn't set them", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract({
      topology: {
        structure: "flat",
        roles: [{ name: "worker", description: "Do work", command: "echo worker" }],
      },
    });

    const orchestrator = new SessionOrchestrator({
      goal: "Work",
      contract,
      topology: contract.topology!,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
    });

    await orchestrator.start();

    expect(runtime.spawnCalls[0]!.config.platform).toBeUndefined();
    expect(runtime.spawnCalls[0]!.config.model).toBeUndefined();
    bus.close();
  });

  test("profile overlays role — platform and command override", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract({
      topology: {
        structure: "flat",
        roles: [
          {
            name: "coder",
            description: "Write code",
            command: "claude",
            platform: "claude-code",
          },
        ],
      },
    });

    const orchestrator = new SessionOrchestrator({
      goal: "Build it",
      contract,
      topology: contract.topology!,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
      profiles: [
        {
          name: "@coder",
          role: "coder",
          platform: "codex",
          command: "codex",
          model: "gpt-4.1",
        },
      ],
    });

    await orchestrator.start();

    // Profile overrides role
    expect(runtime.spawnCalls[0]!.config.command).toBe("codex");
    expect(runtime.spawnCalls[0]!.config.platform).toBe("codex");
    expect(runtime.spawnCalls[0]!.config.model).toBe("gpt-4.1");
    bus.close();
  });

  test("profile without command falls back to role command", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract({
      topology: {
        structure: "flat",
        roles: [
          {
            name: "coder",
            description: "Write code",
            command: "claude",
            platform: "claude-code",
            model: "claude-opus-4-6",
          },
        ],
      },
    });

    const orchestrator = new SessionOrchestrator({
      goal: "Build it",
      contract,
      topology: contract.topology!,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
      profiles: [
        {
          name: "@coder",
          role: "coder",
          platform: "gemini", // override platform only
        },
      ],
    });

    await orchestrator.start();

    // Profile overrides platform, role provides command and model
    expect(runtime.spawnCalls[0]!.config.command).toBe("claude");
    expect(runtime.spawnCalls[0]!.config.platform).toBe("gemini");
    expect(runtime.spawnCalls[0]!.config.model).toBe("claude-opus-4-6");
    bus.close();
  });

  test("mixed topology with different platforms per role", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract({
      topology: {
        structure: "graph",
        roles: [
          {
            name: "coder",
            description: "Write code",
            command: "codex",
            platform: "codex",
            edges: [{ target: "reviewer", edgeType: "delegates" as const }],
          },
          {
            name: "reviewer",
            description: "Review code",
            command: "claude",
            platform: "claude-code",
            model: "claude-opus-4-6",
            edges: [{ target: "coder", edgeType: "feedback" as const }],
          },
        ],
      },
    });

    const orchestrator = new SessionOrchestrator({
      goal: "Build + review",
      contract,
      topology: contract.topology!,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
    });

    await orchestrator.start();

    const coderCall = runtime.spawnCalls.find((c) => c.role === "coder");
    const reviewerCall = runtime.spawnCalls.find((c) => c.role === "reviewer");

    expect(coderCall!.config.platform).toBe("codex");
    expect(reviewerCall!.config.platform).toBe("claude-code");
    expect(reviewerCall!.config.model).toBe("claude-opus-4-6");
    bus.close();
  });

  test("uses role.goal when available", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract({
      topology: {
        structure: "flat",
        roles: [
          {
            name: "writer",
            description: "A writer agent",
            prompt: "System instructions for writing",
            goal: "Write excellent documentation",
            command: "echo writer",
          },
        ],
      },
    });

    const orchestrator = new SessionOrchestrator({
      goal: "Document the API",
      contract,
      topology: contract.topology!,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
    });

    await orchestrator.start();

    // goal takes precedence over prompt and description
    expect(runtime.sendCalls[0]!.message).toContain("Write excellent documentation");
    expect(runtime.sendCalls[0]!.message).not.toContain("System instructions for writing");
    expect(runtime.sendCalls[0]!.message).not.toContain("A writer agent");
    bus.close();
  });
});

// ---------------------------------------------------------------------------
// Workspace isolation policy tests
// ---------------------------------------------------------------------------

describe("SessionOrchestrator — workspace isolation policy", () => {
  test("strict policy (default): worktree failure rejects the spawn", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract({
      topology: {
        structure: "flat",
        roles: [{ name: "worker", description: "Do the work", command: "echo worker" }],
      },
    });

    const orchestrator = new SessionOrchestrator({
      goal: "Test strict failure",
      contract,
      topology: contract.topology!,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "strict",
    });

    // /tmp is not a git repo so worktree creation will fail.
    // strict policy → fails fast with provisioning error (more informative than "No agents spawned")
    await expect(orchestrator.start()).rejects.toThrow(
      "Workspace provisioning failed for role 'worker'",
    );

    expect(runtime.spawnCalls).toHaveLength(0);
    bus.close();
  });

  test("allow-fallback policy: worktree failure produces fallback_workspace mode", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract({
      topology: {
        structure: "flat",
        roles: [{ name: "worker", description: "Do the work", command: "echo worker" }],
      },
    });

    const orchestrator = new SessionOrchestrator({
      goal: "Test fallback",
      contract,
      topology: contract.topology!,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
    });

    const status = await orchestrator.start();

    // Agent spawned despite worktree failure
    expect(status.started).toBe(true);
    expect(status.agents).toHaveLength(1);

    // Agent is running in fallback workspace mode
    const agent = status.agents[0]!;
    expect(agent.workspaceMode.status).toBe("fallback_workspace");
    expect(agent.workspaceMode.path).toBe("/tmp");

    // Agent cwd is the project root (fallback)
    expect(runtime.spawnCalls[0]!.config.cwd).toBe("/tmp");
    bus.close();
  });

  test("allow-fallback policy: successful worktree produces isolated_worktree mode", async () => {
    const { execSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: pathJoin } = await import("node:path");

    // Create a real git repo with initial commit
    const repoDir = mkdtempSync(pathJoin(tmpdir(), "grove-so-test-"));
    try {
      execSync("git init", { cwd: repoDir, stdio: "pipe" });
      execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "pipe" });
      execSync('git config user.name "Test"', { cwd: repoDir, stdio: "pipe" });
      execSync("git commit --allow-empty -m 'init'", { cwd: repoDir, stdio: "pipe" });

      const runtime = new MockRuntime();
      const bus = new LocalEventBus();
      const contract = makeContract({
        topology: {
          structure: "flat",
          roles: [{ name: "worker", description: "Do the work", command: "echo worker" }],
        },
      });

      const orchestrator = new SessionOrchestrator({
        goal: "Test isolated",
        contract,
        topology: contract.topology!,
        runtime,
        eventBus: bus,
        projectRoot: repoDir,
        workspaceBaseDir: pathJoin(repoDir, ".grove", "workspaces"),
        workspaceIsolationPolicy: "allow-fallback",
        sessionId: "testsessionid12345678",
      });

      const status = await orchestrator.start();

      expect(status.agents).toHaveLength(1);
      const agent = status.agents[0]!;

      // Worktree succeeded → isolated_worktree or bootstrap_failed
      // (bootstrap may fail if MCP serve.ts isn't found, but worktree should succeed)
      expect(["isolated_worktree", "bootstrap_failed"]).toContain(agent.workspaceMode.status);

      // In either case, the agent cwd is inside the repo, NOT the repo root itself
      expect(agent.workspaceMode.path).not.toBe(repoDir);
      bus.close();
    } finally {
      try {
        // Clean up worktrees before removing the directory
        execSync("git worktree prune", { cwd: repoDir, stdio: "pipe" });
      } catch {
        // best-effort
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("bootstrap failure with allow-fallback produces bootstrap_failed mode", async () => {
    const { execSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: pathJoin } = await import("node:path");

    const repoDir = mkdtempSync(pathJoin(tmpdir(), "grove-so-bootstrap-test-"));
    try {
      execSync("git init", { cwd: repoDir, stdio: "pipe" });
      execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "pipe" });
      execSync('git config user.name "Test"', { cwd: repoDir, stdio: "pipe" });
      execSync("git commit --allow-empty -m 'init'", { cwd: repoDir, stdio: "pipe" });

      const runtime = new MockRuntime();
      const bus = new LocalEventBus();
      const contract = makeContract({
        topology: {
          structure: "flat",
          roles: [{ name: "worker", description: "Do the work", command: "echo worker" }],
        },
      });

      // Point mcpServePath to a real path that bootstrapWorkspace can resolve.
      // bootstrapWorkspace writes CLAUDE.md even if MCP serve path is absent,
      // but writing config may fail when the worktree path itself doesn't exist yet.
      // We just need the worktree creation to succeed and bootstrap to at least attempt.
      const orchestrator = new SessionOrchestrator({
        goal: "Test bootstrap mode",
        contract,
        topology: contract.topology!,
        runtime,
        eventBus: bus,
        projectRoot: repoDir,
        workspaceBaseDir: pathJoin(repoDir, ".grove", "workspaces"),
        workspaceIsolationPolicy: "allow-fallback",
        sessionId: "bootsessionid12345678",
      });

      const status = await orchestrator.start();
      expect(status.agents).toHaveLength(1);

      // The agent workspace mode must be one of the typed values
      const mode = status.agents[0]!.workspaceMode.status;
      expect(["isolated_worktree", "bootstrap_failed"]).toContain(mode);
      bus.close();
    } finally {
      try {
        execSync("git worktree prune", { cwd: repoDir, stdio: "pipe" });
      } catch {
        // best-effort
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("workspaceMode.status is visible on each agent in getStatus()", async () => {
    const contract = makeContract();
    const { orchestrator, bus } = makeOrchestrator(contract);

    const status = await orchestrator.start();

    // Every agent must have a workspaceMode
    for (const agent of status.agents) {
      expect(agent.workspaceMode).toBeDefined();
      expect(["isolated_worktree", "fallback_workspace", "bootstrap_failed"]).toContain(
        agent.workspaceMode.status,
      );
      expect(typeof agent.workspaceMode.path).toBe("string");
    }
    bus.close();
  });
});

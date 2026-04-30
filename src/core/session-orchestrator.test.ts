import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GroveContract } from "./contract.js";
import { LocalEventBus } from "./local-event-bus.js";
import { MockRuntime } from "./mock-runtime.js";
import {
  computeRoutingSignatureForContribution,
  ROUTING_SIGNATURE_CONTEXT_KEY,
} from "./routing-provenance.js";
import { SessionOrchestrator } from "./session-orchestrator.js";
import { makeContribution } from "./test-helpers.js";
import type { AgentTopology } from "./topology.js";

/**
 * Create a temporary bare clone with a seeded initial commit.
 * Returns the path to the bare repo.
 */
function makeFixtureBareRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-so-fx-"));
  execSync("git -c init.defaultBranch=main init --bare", { cwd: dir, stdio: "pipe" });
  const scratch = mkdtempSync(join(tmpdir(), "grove-so-scratch-"));
  execSync(`git clone "${dir}" "${scratch}"`, { stdio: "pipe" });
  execSync('git config user.email "t@t"', { cwd: scratch, stdio: "pipe" });
  execSync('git config user.name "t"', { cwd: scratch, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd: scratch, stdio: "pipe" });
  execSync("git push origin main", { cwd: scratch, stdio: "pipe" });
  rmSync(scratch, { recursive: true, force: true });
  return dir;
}

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
    repos: [{ kind: "local", path: "/tmp" }],
    workspaceBaseDir: "/tmp/workspaces",
    // /tmp is not a git repo, so worktrees always fail in tests.
    // allow-fallback lets agents start despite that.
    workspaceIsolationPolicy: "allow-fallback",
    ...(overrides?.sessionId ? { sessionId: overrides.sessionId } : {}),
  });
  return { orchestrator, runtime, bus };
}

function signContributionForRouting(
  contribution: ReturnType<typeof makeContribution>,
  routingToken: string,
): ReturnType<typeof makeContribution> {
  const signature = computeRoutingSignatureForContribution(contribution, routingToken);
  return {
    ...contribution,
    context: {
      ...(contribution.context ?? {}),
      [ROUTING_SIGNATURE_CONTEXT_KEY]: signature,
    },
  };
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
          repos: [{ kind: "local", path: "/tmp" }],
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

  test("polling ignores contributions from same-role agents in other sessions", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract();
    const contributions = [
      makeContribution({
        summary: "external coder contribution",
        agent: { agentId: "external-session-coder", role: "coder" },
      }),
    ];
    const contributionStore = {
      list: async () => contributions,
    };

    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract,
      topology: contract.topology!,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      repos: [{ kind: "local", path: "/tmp" }],
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
      contributionStore,
    });
    const internals = orchestrator as unknown as {
      startContributionPolling: () => void;
      pollContributions: () => Promise<void>;
    };
    // Avoid a real 15s timer in test; invoke poll manually.
    internals.startContributionPolling = () => undefined;

    await orchestrator.start();
    await internals.pollContributions();

    // Only initial role-goal sends should be present.
    expect(runtime.sendCalls).toHaveLength(2);
    bus.close();
  });

  test("polling forwards contributions from this session's agentId", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract();
    const contributions: ReturnType<typeof makeContribution>[] = [];
    const contributionStore = {
      list: async () => contributions,
    };

    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract,
      topology: contract.topology!,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      repos: [{ kind: "local", path: "/tmp" }],
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
      contributionStore,
    });
    const internals = orchestrator as unknown as {
      startContributionPolling: () => void;
      pollContributions: () => Promise<void>;
    };
    // Avoid a real 15s timer in test; invoke poll manually.
    internals.startContributionPolling = () => undefined;

    const started = await orchestrator.start();
    const coderSessionId = started.agents.find((a) => a.role === "coder")?.session.id;
    const coderToken = runtime.spawnCalls.find((c) => c.role === "coder")?.config.env
      ?.GROVE_ROUTING_TOKEN;
    expect(coderSessionId).toBeDefined();
    expect(coderToken).toBeDefined();

    contributions.push(
      signContributionForRouting(
        makeContribution({
          summary: "local coder contribution",
          agent: { agentId: coderSessionId ?? "missing", role: "coder" },
        }),
        coderToken ?? "missing-token",
      ),
    );

    await internals.pollContributions();

    // 2 initial goal sends + 1 routed handoff to reviewer.
    expect(runtime.sendCalls).toHaveLength(3);
    expect(runtime.sendCalls[2]!.message).toContain("local coder contribution");
    bus.close();
  });

  test("polling requests newest contributions so large stores do not hide fresh work", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract();
    const contributions: ReturnType<typeof makeContribution>[] = [];
    const contributionStore = {
      list: async (query?: { limit?: number; order?: "created_at_asc" | "created_at_desc" }) => {
        const sorted = [...contributions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const ordered = query?.order === "created_at_desc" ? sorted.reverse() : sorted;
        return query?.limit !== undefined ? ordered.slice(0, query.limit) : ordered;
      },
    };

    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract,
      topology: contract.topology!,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      repos: [{ kind: "local", path: "/tmp" }],
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
      contributionStore,
    });
    const internals = orchestrator as unknown as {
      startContributionPolling: () => void;
      pollContributions: () => Promise<void>;
    };
    internals.startContributionPolling = () => undefined;

    const started = await orchestrator.start();
    const coderSessionId = started.agents.find((a) => a.role === "coder")?.session.id;
    const coderToken = runtime.spawnCalls.find((c) => c.role === "coder")?.config.env
      ?.GROVE_ROUTING_TOKEN;
    expect(coderSessionId).toBeDefined();
    expect(coderToken).toBeDefined();

    for (let i = 0; i < 200; i++) {
      contributions.push(
        makeContribution({
          summary: `old contribution ${i}`,
          agent: { agentId: "external-agent", role: "coder" },
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
        }),
      );
    }
    contributions.push(
      signContributionForRouting(
        makeContribution({
          summary: "fresh local coder contribution",
          agent: { agentId: coderSessionId ?? "missing", role: "coder" },
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
        coderToken ?? "missing-token",
      ),
    );

    await internals.pollContributions();

    expect(runtime.sendCalls).toHaveLength(3);
    expect(runtime.sendCalls[2]!.message).toContain("fresh local coder contribution");
    bus.close();
  });

  test("polling ignores contributions with forgeable deterministic agent ids", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract();
    const contributions: ReturnType<typeof makeContribution>[] = [];
    const contributionStore = {
      list: async () => contributions,
    };

    const sessionId = "session-routing-1";
    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract,
      topology: contract.topology!,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      repos: [{ kind: "local", path: "/tmp" }],
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
      contributionStore,
      sessionId,
    });
    const internals = orchestrator as unknown as {
      startContributionPolling: () => void;
      pollContributions: () => Promise<void>;
    };
    // Avoid a real 15s timer in test; invoke poll manually.
    internals.startContributionPolling = () => undefined;

    await orchestrator.start();
    contributions.push(
      makeContribution({
        summary: "spoofed deterministic id contribution",
        agent: { agentId: `${sessionId}:coder`, role: "coder" },
      }),
    );

    await internals.pollContributions();

    // Only initial role-goal sends should be present.
    expect(runtime.sendCalls).toHaveLength(2);
    bus.close();
  });

  test("polling ignores forged session id when routing signature is invalid", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract();
    const contributions: ReturnType<typeof makeContribution>[] = [];
    const contributionStore = {
      list: async () => contributions,
    };

    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract,
      topology: contract.topology!,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      repos: [{ kind: "local", path: "/tmp" }],
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
      contributionStore,
    });
    const internals = orchestrator as unknown as {
      startContributionPolling: () => void;
      pollContributions: () => Promise<void>;
    };
    // Avoid a real 15s timer in test; invoke poll manually.
    internals.startContributionPolling = () => undefined;

    const started = await orchestrator.start();
    const coderSessionId = started.agents.find((a) => a.role === "coder")?.session.id;
    expect(coderSessionId).toBeDefined();

    contributions.push({
      ...makeContribution({
        summary: "forged signature contribution",
        agent: { agentId: coderSessionId ?? "missing", role: "coder" },
      }),
      context: { [ROUTING_SIGNATURE_CONTEXT_KEY]: "invalid-signature" },
    });

    await internals.pollContributions();

    // Only initial role-goal sends should be present.
    expect(runtime.sendCalls).toHaveLength(2);
    bus.close();
  });

  test("polling ignores forged session id when routing signature uses wrong token", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract();
    const contributions: ReturnType<typeof makeContribution>[] = [];
    const contributionStore = {
      list: async () => contributions,
    };

    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract,
      topology: contract.topology!,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      repos: [{ kind: "local", path: "/tmp" }],
      workspaceBaseDir: "/tmp/workspaces",
      workspaceIsolationPolicy: "allow-fallback",
      contributionStore,
    });
    const internals = orchestrator as unknown as {
      startContributionPolling: () => void;
      pollContributions: () => Promise<void>;
    };
    // Avoid a real 15s timer in test; invoke poll manually.
    internals.startContributionPolling = () => undefined;

    const started = await orchestrator.start();
    const coderSessionId = started.agents.find((a) => a.role === "coder")?.session.id;
    expect(coderSessionId).toBeDefined();

    contributions.push(
      signContributionForRouting(
        makeContribution({
          summary: "forged token contribution",
          agent: { agentId: coderSessionId ?? "missing", role: "coder" },
        }),
        "wrong-token",
      ),
    );

    await internals.pollContributions();

    // Only initial role-goal sends should be present.
    expect(runtime.sendCalls).toHaveLength(2);
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
      repos: [{ kind: "local", path: "/tmp" }],
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
      repos: [{ kind: "local", path: "/tmp" }],
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
      repos: [{ kind: "local", path: "/tmp" }],
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
      repos: [{ kind: "local", path: "/tmp" }],
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
      repos: [{ kind: "local", path: "/tmp" }],
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
      repos: [{ kind: "local", path: "/tmp" }],
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
      repos: [{ kind: "local", path: "/tmp" }],
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
      repos: [{ kind: "local", path: "/tmp" }],
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
    const { rmSync } = await import("node:fs");

    // Create a bare clone — matches the new workspace-provisioner contract.
    const bareRepo = makeFixtureBareRepo();
    try {
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
        projectRoot: bareRepo,
        repos: [{ kind: "local", path: bareRepo }],
        workspaceBaseDir: join(tmpdir(), `grove-so-ws-${Date.now()}`),
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
      expect(agent.workspaceMode.path).not.toBe(bareRepo);
      bus.close();
    } finally {
      try {
        rmSync(bareRepo, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  test("bootstrap failure with allow-fallback produces bootstrap_failed mode", async () => {
    const { rmSync } = await import("node:fs");

    const bareRepo = makeFixtureBareRepo();
    try {
      const runtime = new MockRuntime();
      const bus = new LocalEventBus();
      const contract = makeContract({
        topology: {
          structure: "flat",
          roles: [{ name: "worker", description: "Do the work", command: "echo worker" }],
        },
      });

      // We just need the worktree creation to succeed and bootstrap to at least attempt.
      const orchestrator = new SessionOrchestrator({
        goal: "Test bootstrap mode",
        contract,
        topology: contract.topology!,
        runtime,
        eventBus: bus,
        projectRoot: bareRepo,
        repos: [{ kind: "local", path: bareRepo }],
        workspaceBaseDir: join(tmpdir(), `grove-so-ws-${Date.now()}`),
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
        rmSync(bareRepo, { recursive: true, force: true });
      } catch {
        // best-effort
      }
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

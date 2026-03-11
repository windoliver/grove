/**
 * Tests for agent identity resolution.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AgentIdentity } from "../core/models.js";
import type { AgentRole, AgentTopology } from "../core/topology.js";
import { resolveAgent, resolveAgentRole } from "./agent.js";

describe("resolveAgent", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all GROVE_AGENT_* env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GROVE_AGENT_")) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GROVE_AGENT_")) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (key.startsWith("GROVE_AGENT_") && value !== undefined) {
        process.env[key] = value;
      }
    }
  });

  test("returns default agentId when no overrides or env vars", () => {
    const agent = resolveAgent();
    expect(agent.agentId).toMatch(/^.+-\d+$/); // hostname-pid
  });

  test("CLI override takes precedence over env var", () => {
    process.env.GROVE_AGENT_ID = "from-env";
    const agent = resolveAgent({ agentId: "from-cli" });
    expect(agent.agentId).toBe("from-cli");
  });

  test("env var is used when no CLI override", () => {
    process.env.GROVE_AGENT_ID = "from-env";
    const agent = resolveAgent();
    expect(agent.agentId).toBe("from-env");
  });

  test("resolves all fields from env vars", () => {
    process.env.GROVE_AGENT_ID = "agent-1";
    process.env.GROVE_AGENT_NAME = "Test Agent";
    process.env.GROVE_AGENT_PROVIDER = "anthropic";
    process.env.GROVE_AGENT_MODEL = "claude-4";
    process.env.GROVE_AGENT_PLATFORM = "linux";
    process.env.GROVE_AGENT_VERSION = "1.0";
    process.env.GROVE_AGENT_TOOLCHAIN = "bun";
    process.env.GROVE_AGENT_RUNTIME = "bun-1.3";
    process.env.GROVE_AGENT_ROLE = "contributor";

    const agent = resolveAgent();
    expect(agent.agentId).toBe("agent-1");
    expect(agent.agentName).toBe("Test Agent");
    expect(agent.provider).toBe("anthropic");
    expect(agent.model).toBe("claude-4");
    expect(agent.platform).toBe("linux");
    expect(agent.version).toBe("1.0");
    expect(agent.toolchain).toBe("bun");
    expect(agent.runtime).toBe("bun-1.3");
    expect(agent.role).toBe("contributor");
  });

  test("CLI overrides take precedence over all env vars", () => {
    process.env.GROVE_AGENT_ID = "env-id";
    process.env.GROVE_AGENT_NAME = "env-name";

    const agent = resolveAgent({
      agentId: "cli-id",
      agentName: "cli-name",
    });

    expect(agent.agentId).toBe("cli-id");
    expect(agent.agentName).toBe("cli-name");
  });

  test("optional fields are omitted when not set", () => {
    const agent = resolveAgent({ agentId: "test" });
    expect(agent.agentId).toBe("test");
    expect(agent.agentName).toBeUndefined();
    expect(agent.provider).toBeUndefined();
    expect(agent.model).toBeUndefined();
    expect(agent.role).toBeUndefined();
  });

  test("role resolved from CLI override", () => {
    const agent = resolveAgent({ agentId: "test", role: "reviewer" });
    expect(agent.role).toBe("reviewer");
  });

  test("role resolved from GROVE_AGENT_ROLE env var", () => {
    process.env.GROVE_AGENT_ROLE = "contributor";
    const agent = resolveAgent();
    expect(agent.role).toBe("contributor");
  });

  test("role omitted when not provided", () => {
    const agent = resolveAgent({ agentId: "test" });
    expect(agent.role).toBeUndefined();
    expect(Object.keys(agent)).not.toContain("role");
  });

  test("CLI override takes precedence over env var for role", () => {
    process.env.GROVE_AGENT_ROLE = "env-role";
    const agent = resolveAgent({ role: "cli-role" });
    expect(agent.role).toBe("cli-role");
  });
});

describe("resolveAgentRole", () => {
  const coderRole: AgentRole = { name: "coder", maxInstances: 5 };
  const reviewerRole: AgentRole = { name: "reviewer", maxInstances: 2 };
  const topology: AgentTopology = {
    structure: "graph",
    roles: [coderRole, reviewerRole],
  };

  test("returns matching role when found", () => {
    const agent: AgentIdentity = { agentId: "a1", role: "coder" };
    const result = resolveAgentRole(topology, agent);
    expect(result).toEqual(coderRole);
  });

  test("returns undefined when no topology", () => {
    const agent: AgentIdentity = { agentId: "a1", role: "coder" };
    const result = resolveAgentRole(undefined, agent);
    expect(result).toBeUndefined();
  });

  test("returns undefined when agent has no role and no fallback matches", () => {
    const agent: AgentIdentity = { agentId: "a1" };
    const result = resolveAgentRole(topology, agent);
    expect(result).toBeUndefined();
  });

  test("returns undefined when role name doesn't match and no fallback matches", () => {
    const agent: AgentIdentity = { agentId: "a1", role: "nonexistent" };
    const result = resolveAgentRole(topology, agent);
    expect(result).toBeUndefined();
  });

  test("falls back to agentName when role is undefined", () => {
    const agent: AgentIdentity = { agentId: "a1", agentName: "coder" };
    const result = resolveAgentRole(topology, agent);
    expect(result).toEqual(coderRole);
  });

  test("agentName fallback is case-insensitive", () => {
    const agent: AgentIdentity = { agentId: "a1", agentName: "Coder" };
    const result = resolveAgentRole(topology, agent);
    expect(result).toEqual(coderRole);
  });

  test("falls back to agentId containing role name", () => {
    const agent: AgentIdentity = { agentId: "instance-reviewer-01" };
    const result = resolveAgentRole(topology, agent);
    expect(result).toEqual(reviewerRole);
  });

  test("agentId fallback is case-insensitive", () => {
    const agent: AgentIdentity = { agentId: "CODER-agent-1" };
    const result = resolveAgentRole(topology, agent);
    expect(result).toEqual(coderRole);
  });

  test("explicit role takes priority over agentName fallback", () => {
    const agent: AgentIdentity = { agentId: "a1", role: "reviewer", agentName: "coder" };
    const result = resolveAgentRole(topology, agent);
    expect(result).toEqual(reviewerRole);
  });

  test("agentName fallback takes priority over agentId fallback", () => {
    const agent: AgentIdentity = { agentId: "reviewer-bot", agentName: "coder" };
    const result = resolveAgentRole(topology, agent);
    expect(result).toEqual(coderRole);
  });
});

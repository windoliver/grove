/**
 * Tests for agent identity resolution.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveAgent } from "./agent.js";

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

    const agent = resolveAgent();
    expect(agent.agentId).toBe("agent-1");
    expect(agent.agentName).toBe("Test Agent");
    expect(agent.provider).toBe("anthropic");
    expect(agent.model).toBe("claude-4");
    expect(agent.platform).toBe("linux");
    expect(agent.version).toBe("1.0");
    expect(agent.toolchain).toBe("bun");
    expect(agent.runtime).toBe("bun-1.3");
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
  });
});

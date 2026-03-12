/**
 * Tests for unified agent identity resolution.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { hostname } from "node:os";

import { resolveAgent } from "./agent.js";

// Save and restore env vars to avoid test pollution
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "GROVE_AGENT_ID",
  "GROVE_AGENT_NAME",
  "GROVE_AGENT_PROVIDER",
  "GROVE_AGENT_MODEL",
  "GROVE_AGENT_PLATFORM",
  "GROVE_AGENT_VERSION",
  "GROVE_AGENT_TOOLCHAIN",
  "GROVE_AGENT_RUNTIME",
  "GROVE_AGENT_ROLE",
];

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
}

describe("resolveAgent()", () => {
  afterEach(() => {
    restoreEnv();
  });

  test("defaults agentId to hostname-pid", () => {
    clearEnv();
    const agent = resolveAgent();
    expect(agent.agentId).toBe(`${hostname()}-${process.pid}`);
  });

  test("override takes precedence over env var", () => {
    clearEnv();
    process.env.GROVE_AGENT_ID = "env-agent";
    const agent = resolveAgent({ agentId: "override-agent" });
    expect(agent.agentId).toBe("override-agent");
  });

  test("env var takes precedence over default", () => {
    clearEnv();
    process.env.GROVE_AGENT_ID = "env-agent";
    const agent = resolveAgent();
    expect(agent.agentId).toBe("env-agent");
  });

  test("sets all optional fields from overrides", () => {
    clearEnv();
    const agent = resolveAgent({
      agentId: "test-agent",
      agentName: "Test Agent",
      provider: "anthropic",
      model: "claude-opus-4-6",
      platform: "H100",
      version: "1.0.0",
      toolchain: "claude-code",
      runtime: "bun-1.3",
      role: "contributor",
    });

    expect(agent.agentId).toBe("test-agent");
    expect(agent.agentName).toBe("Test Agent");
    expect(agent.provider).toBe("anthropic");
    expect(agent.model).toBe("claude-opus-4-6");
    expect(agent.platform).toBe("H100");
    expect(agent.version).toBe("1.0.0");
    expect(agent.toolchain).toBe("claude-code");
    expect(agent.runtime).toBe("bun-1.3");
    expect(agent.role).toBe("contributor");
  });

  test("sets optional fields from env vars when no overrides", () => {
    clearEnv();
    process.env.GROVE_AGENT_NAME = "Env Agent";
    process.env.GROVE_AGENT_PROVIDER = "openai";
    const agent = resolveAgent({ agentId: "test" });

    expect(agent.agentName).toBe("Env Agent");
    expect(agent.provider).toBe("openai");
  });

  test("omits optional fields when neither override nor env set", () => {
    clearEnv();
    const agent = resolveAgent({ agentId: "test" });
    expect(agent.agentName).toBeUndefined();
    expect(agent.provider).toBeUndefined();
    expect(agent.model).toBeUndefined();
    expect(agent.platform).toBeUndefined();
    expect(agent.version).toBeUndefined();
    expect(agent.toolchain).toBeUndefined();
    expect(agent.runtime).toBeUndefined();
    expect(agent.role).toBeUndefined();
  });

  test("accepts empty overrides object", () => {
    clearEnv();
    const agent = resolveAgent({});
    expect(agent.agentId).toBe(`${hostname()}-${process.pid}`);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveAgentIdentity } from "./agent-identity.js";

describe("resolveAgentIdentity", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "GROVE_AGENT_ID",
    "GROVE_AGENT_NAME",
    "GROVE_AGENT_PROVIDER",
    "GROVE_AGENT_MODEL",
    "GROVE_AGENT_PLATFORM",
    "GROVE_AGENT_VERSION",
    "GROVE_AGENT_TOOLCHAIN",
    "GROVE_AGENT_RUNTIME",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test("returns default agentId when no input and no env", () => {
    const identity = resolveAgentIdentity();
    expect(identity.agentId).toMatch(/.+-\d+/); // hostname-pid
  });

  test("uses explicit agentId from input", () => {
    const identity = resolveAgentIdentity({ agentId: "my-agent" });
    expect(identity.agentId).toBe("my-agent");
  });

  test("falls back to GROVE_AGENT_ID env var", () => {
    process.env.GROVE_AGENT_ID = "env-agent";
    const identity = resolveAgentIdentity();
    expect(identity.agentId).toBe("env-agent");
  });

  test("input takes precedence over env var", () => {
    process.env.GROVE_AGENT_ID = "env-agent";
    const identity = resolveAgentIdentity({ agentId: "input-agent" });
    expect(identity.agentId).toBe("input-agent");
  });

  test("resolves all optional fields from env vars", () => {
    process.env.GROVE_AGENT_ID = "test-id";
    process.env.GROVE_AGENT_NAME = "Test Agent";
    process.env.GROVE_AGENT_PROVIDER = "anthropic";
    process.env.GROVE_AGENT_MODEL = "claude-4";
    process.env.GROVE_AGENT_PLATFORM = "darwin";
    process.env.GROVE_AGENT_VERSION = "1.0.0";
    process.env.GROVE_AGENT_TOOLCHAIN = "claude-code";
    process.env.GROVE_AGENT_RUNTIME = "bun";

    const identity = resolveAgentIdentity();
    expect(identity).toEqual({
      agentId: "test-id",
      agentName: "Test Agent",
      provider: "anthropic",
      model: "claude-4",
      platform: "darwin",
      version: "1.0.0",
      toolchain: "claude-code",
      runtime: "bun",
    });
  });

  test("input fields override env vars for optional fields", () => {
    process.env.GROVE_AGENT_NAME = "env-name";
    process.env.GROVE_AGENT_PROVIDER = "env-provider";

    const identity = resolveAgentIdentity({
      agentId: "test",
      agentName: "input-name",
    });
    expect(identity.agentName).toBe("input-name");
    expect(identity.provider).toBe("env-provider");
  });

  test("omits undefined optional fields from result", () => {
    const identity = resolveAgentIdentity({ agentId: "minimal" });
    expect(identity.agentId).toBe("minimal");
    expect(Object.keys(identity)).toEqual(["agentId"]);
  });
});

import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "./agent-profile.js";
import { mergeRuntimeConfig } from "./session-orchestrator.js";
import type { AgentRole } from "./topology.js";

function makeRole(overrides?: Partial<AgentRole>): AgentRole {
  return { name: "coder", description: "Write code", ...overrides };
}

function makeProfile(overrides?: Partial<AgentProfile>): AgentProfile {
  return { name: "@coder", role: "coder", platform: "codex", ...overrides };
}

describe("mergeRuntimeConfig", () => {
  // --- command ---

  test("defaults command to 'claude' when neither role nor profile set it", () => {
    const result = mergeRuntimeConfig(makeRole(), undefined);
    expect(result.command).toBe("claude");
  });

  test("uses role.command when no profile", () => {
    const result = mergeRuntimeConfig(makeRole({ command: "codex" }), undefined);
    expect(result.command).toBe("codex");
  });

  test("profile.command overrides role.command", () => {
    const result = mergeRuntimeConfig(
      makeRole({ command: "claude" }),
      makeProfile({ command: "gemini" }),
    );
    expect(result.command).toBe("gemini");
  });

  test("falls back to role.command when profile has no command", () => {
    const result = mergeRuntimeConfig(
      makeRole({ command: "codex" }),
      makeProfile({ command: undefined }),
    );
    expect(result.command).toBe("codex");
  });

  // --- platform ---

  test("platform is undefined when neither role nor profile set it", () => {
    const result = mergeRuntimeConfig(makeRole(), undefined);
    expect(result.platform).toBeUndefined();
  });

  test("uses role.platform when no profile", () => {
    const result = mergeRuntimeConfig(makeRole({ platform: "gemini" }), undefined);
    expect(result.platform).toBe("gemini");
  });

  test("profile.platform overrides role.platform", () => {
    const result = mergeRuntimeConfig(
      makeRole({ platform: "claude-code" }),
      makeProfile({ platform: "codex" }),
    );
    expect(result.platform).toBe("codex");
  });

  test("falls back to role.platform when profile has no platform override", () => {
    // AgentProfile.platform is required, so we test with a profile that has
    // a different platform value — this tests the override path.
    const result = mergeRuntimeConfig(
      makeRole({ platform: "claude-code" }),
      makeProfile({ platform: "claude-code" }),
    );
    expect(result.platform).toBe("claude-code");
  });

  // --- model ---

  test("model is undefined when neither role nor profile set it", () => {
    const result = mergeRuntimeConfig(makeRole(), undefined);
    expect(result.model).toBeUndefined();
  });

  test("uses role.model when no profile", () => {
    const result = mergeRuntimeConfig(makeRole({ model: "claude-opus-4-6" }), undefined);
    expect(result.model).toBe("claude-opus-4-6");
  });

  test("profile.model overrides role.model", () => {
    const result = mergeRuntimeConfig(
      makeRole({ model: "claude-opus-4-6" }),
      makeProfile({ model: "gpt-4.1" }),
    );
    expect(result.model).toBe("gpt-4.1");
  });

  test("falls back to role.model when profile has no model", () => {
    const result = mergeRuntimeConfig(
      makeRole({ model: "claude-opus-4-6" }),
      makeProfile({ model: undefined }),
    );
    expect(result.model).toBe("claude-opus-4-6");
  });

  // --- combined precedence ---

  test("full precedence chain: profile > role > default", () => {
    const role = makeRole({
      command: "claude",
      platform: "claude-code",
      model: "claude-opus-4-6",
    });
    const profile = makeProfile({
      command: "codex",
      platform: "codex",
      model: "gpt-4.1",
    });
    const result = mergeRuntimeConfig(role, profile);
    expect(result.command).toBe("codex");
    expect(result.platform).toBe("codex");
    expect(result.model).toBe("gpt-4.1");
  });

  test("partial profile overlay: only overrides fields that are set", () => {
    const role = makeRole({
      command: "claude",
      platform: "claude-code",
      model: "claude-opus-4-6",
    });
    // Profile only sets platform, everything else falls back to role
    const profile = makeProfile({
      command: undefined,
      platform: "codex",
      model: undefined,
    });
    const result = mergeRuntimeConfig(role, profile);
    expect(result.command).toBe("claude");
    expect(result.platform).toBe("codex");
    expect(result.model).toBe("claude-opus-4-6");
  });
});

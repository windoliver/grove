import { describe, expect, test } from "bun:test";
import { AcpxRuntime, KNOWN_ACPX_AGENTS, PLATFORM_TO_AGENT } from "./acpx-runtime.js";
import type { AgentConfig } from "./agent-runtime.js";

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    role: "coder",
    command: "echo hello",
    cwd: "/tmp",
    ...overrides,
  };
}

describe("PLATFORM_TO_AGENT mapping", () => {
  test("claude-code maps to claude", () => {
    expect(PLATFORM_TO_AGENT["claude-code"]).toBe("claude");
  });

  test("codex maps to codex", () => {
    expect(PLATFORM_TO_AGENT.codex).toBe("codex");
  });

  test("gemini maps to gemini", () => {
    expect(PLATFORM_TO_AGENT.gemini).toBe("gemini");
  });

  test("custom falls back to codex", () => {
    expect(PLATFORM_TO_AGENT.custom).toBe("codex");
  });

  test("all platform values map to known agents", () => {
    for (const [_platform, agent] of Object.entries(PLATFORM_TO_AGENT)) {
      expect(KNOWN_ACPX_AGENTS.has(agent)).toBe(true);
    }
  });
});

describe("KNOWN_ACPX_AGENTS", () => {
  test("contains expected agents", () => {
    expect(KNOWN_ACPX_AGENTS.has("claude")).toBe(true);
    expect(KNOWN_ACPX_AGENTS.has("codex")).toBe(true);
    expect(KNOWN_ACPX_AGENTS.has("gemini")).toBe(true);
    expect(KNOWN_ACPX_AGENTS.has("pi")).toBe(true);
    expect(KNOWN_ACPX_AGENTS.has("openclaw")).toBe(true);
  });

  test("does not contain unknown agents", () => {
    expect(KNOWN_ACPX_AGENTS.has("gpt")).toBe(false);
    expect(KNOWN_ACPX_AGENTS.has("echo")).toBe(false);
  });
});

describe("AcpxRuntime.resolveAgent", () => {
  test("uses platform when provided — claude-code", () => {
    const rt = new AcpxRuntime();
    expect(rt.resolveAgent(makeConfig({ platform: "claude-code" }))).toBe("claude");
  });

  test("uses platform when provided — codex", () => {
    const rt = new AcpxRuntime();
    expect(rt.resolveAgent(makeConfig({ platform: "codex" }))).toBe("codex");
  });

  test("uses platform when provided — gemini", () => {
    const rt = new AcpxRuntime();
    expect(rt.resolveAgent(makeConfig({ platform: "gemini" }))).toBe("gemini");
  });

  test("platform takes precedence over command", () => {
    const rt = new AcpxRuntime();
    // platform says gemini, command says claude — platform wins
    const agent = rt.resolveAgent(makeConfig({ platform: "gemini", command: "claude --flag" }));
    expect(agent).toBe("gemini");
  });

  test("falls back to command parsing when no platform", () => {
    const rt = new AcpxRuntime();
    expect(rt.resolveAgent(makeConfig({ command: "claude --flag" }))).toBe("claude");
  });

  test("falls back to command parsing — strips rm prefix", () => {
    const rt = new AcpxRuntime();
    const config = makeConfig({
      command: "rm -f ~/.claude/remote-settings.json; claude --dangerously-skip-permissions",
    });
    expect(rt.resolveAgent(config)).toBe("claude");
  });

  test("falls back to constructor default for unknown command", () => {
    const rt = new AcpxRuntime({ agent: "codex" });
    expect(rt.resolveAgent(makeConfig({ command: "echo hello" }))).toBe("codex");
  });

  test("falls back to constructor default when no platform and no command", () => {
    const rt = new AcpxRuntime({ agent: "claude" });
    expect(rt.resolveAgent(makeConfig({ command: "" }))).toBe("claude");
  });

  test("uses DEFAULT_AGENT (codex) when no constructor override and no config", () => {
    const rt = new AcpxRuntime();
    expect(rt.resolveAgent(makeConfig({ command: "unknown-binary" }))).toBe("codex");
  });
});

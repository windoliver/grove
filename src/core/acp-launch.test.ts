import { describe, expect, test } from "bun:test";
import { resolveAcpLaunch, SUPPORTED_ACP_AGENTS } from "./acp-launch.js";

describe("resolveAcpLaunch", () => {
  test("lists exactly three supported agents", () => {
    expect(SUPPORTED_ACP_AGENTS).toEqual(["codex", "claude", "gemini"]);
  });

  test("codex resolves to the pinned @zed-industries/codex-acp binary", () => {
    const launch = resolveAcpLaunch("codex");
    expect(launch.agent).toBe("codex");
    expect(launch.args[0]).toMatch(/codex-acp/);
    expect(launch.packageName).toBe("@zed-industries/codex-acp");
  });

  test("claude resolves to @agentclientprotocol/claude-agent-acp", () => {
    const launch = resolveAcpLaunch("claude");
    expect(launch.agent).toBe("claude");
    expect(launch.packageName).toBe("@agentclientprotocol/claude-agent-acp");
  });

  test("gemini resolves to external gemini --acp (no packageName)", () => {
    const launch = resolveAcpLaunch("gemini");
    expect(launch.agent).toBe("gemini");
    expect(launch.command).toBe("gemini");
    expect(launch.args).toEqual(["--acp"]);
    expect(launch.packageName).toBeUndefined();
  });

  test("unknown agent throws", () => {
    expect(() => resolveAcpLaunch("openclaw")).toThrow(/unsupported/i);
  });
});

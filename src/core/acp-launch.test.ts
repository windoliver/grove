import { describe, expect, test } from "bun:test";
import { resolveAcpLaunch, SUPPORTED_ACP_AGENTS } from "./acp-launch.js";

function parseVersion(version: string | undefined): readonly [number, number, number] {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(
  version: string | undefined,
  minimum: readonly [number, number, number],
): boolean {
  const [major, minor, patch] = parseVersion(version);
  const [minimumMajor, minimumMinor, minimumPatch] = minimum;
  if (major !== minimumMajor) return major > minimumMajor;
  if (minor !== minimumMinor) return minor > minimumMinor;
  if (patch !== minimumPatch) return patch > minimumPatch;
  return true;
}

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

  test("codex ACP package is new enough for current Codex model config", () => {
    const launch = resolveAcpLaunch("codex");
    expect(isAtLeast(launch.packageVersion, [0, 14, 0])).toBe(true);
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

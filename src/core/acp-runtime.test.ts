import { describe, expect, test } from "bun:test";
import type { AcpLaunch } from "./acp-launch.js";
import { AcpRuntime, buildAcpLaunchArgs, buildAcpLaunchEnv } from "./acp-runtime.js";
import { DENY_ALL_RESOLVER } from "./permission-resolver.js";

describe("AcpRuntime construction", () => {
  test("implements AgentRuntime interface (method shape)", () => {
    const rt = new AcpRuntime();
    expect(typeof rt.spawn).toBe("function");
    expect(typeof rt.send).toBe("function");
    expect(typeof rt.close).toBe("function");
    expect(typeof rt.onIdle).toBe("function");
    expect(typeof rt.listSessions).toBe("function");
    expect(typeof rt.isAvailable).toBe("function");
    expect(typeof rt.setPermissionResolver).toBe("function");
  });

  test("default resolver is DenyAll", () => {
    const rt = new AcpRuntime();
    expect(rt.currentResolver).toBe(DENY_ALL_RESOLVER);
  });

  test("setPermissionResolver swaps the resolver", () => {
    const rt = new AcpRuntime();
    const custom = {
      async resolve() {
        return { outcome: { outcome: "cancelled" as const } };
      },
    };
    rt.setPermissionResolver(custom);
    expect(rt.currentResolver).toBe(custom);
  });

  test("listSessions empty by default", async () => {
    const rt = new AcpRuntime();
    expect(await rt.listSessions()).toEqual([]);
  });

  test("isAvailable returns true when SDK importable", async () => {
    const rt = new AcpRuntime();
    expect(await rt.isAvailable()).toBe(true);
  });
});

describe("buildAcpLaunchArgs", () => {
  const codexLaunch: AcpLaunch = {
    agent: "codex",
    command: "bun",
    args: ["codex-acp.js"],
  };
  const claudeLaunch: AcpLaunch = {
    agent: "claude",
    command: "bun",
    args: ["claude-agent-acp.js"],
  };

  test("passes explicit model overrides through to codex-acp", () => {
    expect(buildAcpLaunchArgs(codexLaunch, { model: "gpt-5.4-mini" })).toEqual([
      "codex-acp.js",
      "-c",
      'model="gpt-5.4-mini"',
    ]);
  });

  test("uses GROVE_CODEX_MODEL as codex fallback when role model is absent", () => {
    expect(buildAcpLaunchArgs(codexLaunch, {}, { GROVE_CODEX_MODEL: "gpt-5.4-mini" })).toEqual([
      "codex-acp.js",
      "-c",
      'model="gpt-5.4-mini"',
    ]);
  });

  test("passes full-auto policy overrides through to codex-acp", () => {
    expect(buildAcpLaunchArgs(codexLaunch, { command: "codex --full-auto" })).toEqual([
      "codex-acp.js",
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      'approval_policy="never"',
    ]);
  });

  test("uses GROVE_ALLOW_ALL_PERMISSIONS as codex full-auto fallback", () => {
    expect(buildAcpLaunchArgs(codexLaunch, {}, { GROVE_ALLOW_ALL_PERMISSIONS: "1" })).toEqual([
      "codex-acp.js",
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      'approval_policy="never"',
    ]);
  });

  test("passes only non-secret Grove MCP env through codex config args", () => {
    expect(
      buildAcpLaunchArgs(
        codexLaunch,
        {
          mcpServers: [
            {
              name: "grove",
              command: "/Users/example/.bun/bin/bun",
              args: ["run", "/tmp/grove/dist/mcp/serve.js"],
              startupTimeoutSec: 30,
              env: {
                GROVE_DIR: "/tmp/grove/.grove",
                GROVE_NEXUS_URL: "http://localhost:10120",
                NEXUS_API_KEY: "example-secret",
                GROVE_SESSION_ID: "session-1",
              },
            },
          ],
        },
        {
          GROVE_AGENT_ID: "grove-coder-0--abc",
          GROVE_AGENT_ROLE: "coder",
          GROVE_ROUTING_TOKEN: "routing-secret",
        },
      ),
    ).toEqual([
      "codex-acp.js",
      "-c",
      'mcp_servers.grove.command="/Users/example/.bun/bin/bun"',
      "-c",
      'mcp_servers.grove.args=["run", "/tmp/grove/dist/mcp/serve.js"]',
      "-c",
      "mcp_servers.grove.startup_timeout_sec=30",
      "-c",
      'mcp_servers.grove.env.GROVE_AGENT_ID="grove-coder-0--abc"',
      "-c",
      'mcp_servers.grove.env.GROVE_AGENT_ROLE="coder"',
      "-c",
      'mcp_servers.grove.env.GROVE_DIR="/tmp/grove/.grove"',
      "-c",
      'mcp_servers.grove.env.GROVE_NEXUS_URL="http://localhost:10120"',
      "-c",
      'mcp_servers.grove.env.GROVE_SESSION_ID="session-1"',
    ]);
  });

  test("puts Grove MCP env in the codex adapter process env without leaking it into argv", () => {
    expect(
      buildAcpLaunchEnv(
        "codex",
        {
          PATH: "/bin",
          GROVE_AGENT_ID: "grove-coder-0--abc",
          GROVE_AGENT_ROLE: "coder",
        },
        [
          {
            name: "grove",
            command: "/Users/example/.bun/bin/bun",
            args: ["run", "/tmp/grove/dist/mcp/serve.js"],
            startupTimeoutSec: 30,
            env: {
              GROVE_DIR: "/tmp/grove/.grove",
              GROVE_NEXUS_URL: "http://localhost:10120",
              NEXUS_API_KEY: "example-secret",
              GROVE_SESSION_ID: "session-1",
            },
          },
        ],
      ),
    ).toEqual({
      PATH: "/bin",
      GROVE_AGENT_ID: "grove-coder-0--abc",
      GROVE_AGENT_ROLE: "coder",
      GROVE_DIR: "/tmp/grove/.grove",
      GROVE_NEXUS_URL: "http://localhost:10120",
      NEXUS_API_KEY: "example-secret",
      GROVE_SESSION_ID: "session-1",
    });
  });

  test("skips codex MCP argv overrides when CODEX_HOME config is authoritative", () => {
    expect(
      buildAcpLaunchArgs(
        codexLaunch,
        {
          model: "gpt-5.4-mini",
          command: "codex --full-auto",
          mcpServers: [
            {
              name: "grove",
              command: "/Users/example/.bun/bin/bun",
              args: ["run", "/tmp/grove/dist/mcp/serve.js"],
              env: { GROVE_DIR: "/tmp/grove/.grove" },
            },
          ],
        },
        { GROVE_CODEX_WRITE_MCP_CONFIG: "1" },
      ),
    ).toEqual([
      "codex-acp.js",
      "-c",
      'model="gpt-5.4-mini"',
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      'approval_policy="never"',
    ]);
  });

  test("does not pass codex config flags to non-codex adapters", () => {
    expect(
      buildAcpLaunchArgs(
        claudeLaunch,
        {
          model: "gpt-5.4-mini",
          command: "codex --full-auto",
          mcpServers: [
            {
              name: "grove",
              command: "/Users/example/.bun/bin/bun",
              args: ["run", "/tmp/grove/dist/mcp/serve.js"],
              env: { GROVE_DIR: "/tmp/grove/.grove" },
            },
          ],
        },
        { GROVE_ALLOW_ALL_PERMISSIONS: "1" },
      ),
    ).toEqual(["claude-agent-acp.js"]);
  });
});

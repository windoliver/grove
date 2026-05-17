import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpLaunch } from "./acp-launch.js";
import {
  AcpRuntime,
  buildAcpLaunchArgs,
  buildAcpLaunchEnv,
  isBootstrapFailure,
  prepareIsolatedCodexHome,
} from "./acp-runtime.js";
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
      'model="gpt-5.4"',
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
      'model="gpt-5.4"',
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      'approval_policy="never"',
    ]);
  });

  test("pins DEFAULT_CODEX_MODEL when neither opts.model nor GROVE_CODEX_MODEL is set", () => {
    // User config can have a model codex-acp's bundled CLI doesn't support
    // yet (e.g. gpt-5.5). Grove must override via -c model so spawned
    // agents don't fail the very first prompt with invalid_request_error.
    expect(buildAcpLaunchArgs(codexLaunch, {})).toEqual(["codex-acp.js", "-c", 'model="gpt-5.4"']);
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
      'model="gpt-5.4"',
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
      "-c",
      'mcp_servers.grove.env_vars=["GROVE_ROUTING_TOKEN", "NEXUS_API_KEY"]',
    ]);
    expect(
      buildAcpLaunchArgs(codexLaunch, {}, { GROVE_ROUTING_TOKEN: "routing-secret" }).join("\n"),
    ).not.toContain("routing-secret");
  });

  test("deduplicates sensitive MCP env var names across config entries", () => {
    const args = buildAcpLaunchArgs(codexLaunch, {
      mcpServers: [
        {
          name: "grove",
          command: "/Users/example/.bun/bin/bun",
          env: {
            FIRST_TOKEN: "sk-test",
            SECOND_SECRET: "example-secret",
          },
        },
      ],
    });

    expect(args).toContain('mcp_servers.grove.env_vars=["FIRST_TOKEN", "SECOND_SECRET"]');
    expect(args.join("\n")).not.toContain("example-secret");
    expect(args.join("\n")).not.toContain("sk-test");
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

describe("isBootstrapFailure", () => {
  test("end_turn → false (successful turn completion)", () => {
    expect(isBootstrapFailure("end_turn")).toBe(false);
  });

  test("cancelled → false (voluntary exit, e.g. after grove_done)", () => {
    expect(isBootstrapFailure("cancelled")).toBe(false);
  });

  test("undefined → false (no stopReason present)", () => {
    expect(isBootstrapFailure(undefined)).toBe(false);
  });

  test("error → true (real failure)", () => {
    expect(isBootstrapFailure("error")).toBe(true);
  });

  test("refusal → true (real failure)", () => {
    expect(isBootstrapFailure("refusal")).toBe(true);
  });

  test("max_tokens → true (real failure)", () => {
    expect(isBootstrapFailure("max_tokens")).toBe(true);
  });

  test("max_turn_requests → true (real failure)", () => {
    expect(isBootstrapFailure("max_turn_requests")).toBe(true);
  });
});

describe("prepareIsolatedCodexHome", () => {
  test("writes Grove MCP into the isolated Codex config with private env off argv", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "grove-user-codex-"));
    let isolated = "";
    try {
      writeFileSync(
        join(userHome, "config.toml"),
        ['model = "gpt-5.4-mini"', "", "[mcp_servers.untrusted]", 'command = "bad-mcp"', ""].join(
          "\n",
        ),
        "utf-8",
      );
      writeFileSync(join(userHome, "auth.json"), '{"token":"ok"}', "utf-8");

      isolated = await prepareIsolatedCodexHome({ CODEX_HOME: userHome }, [
        {
          name: "grove",
          command: "/bin/bun",
          args: ["run", "/tmp/grove/dist/mcp/serve.js"],
          env: {
            GROVE_DIR: "/tmp/project/.grove",
            GROVE_NEXUS_URL: "http://localhost:59588",
            NEXUS_API_KEY: "secret-key",
            GROVE_SESSION_ID: "session-1",
          },
        },
      ]);

      const config = readFileSync(join(isolated, "config.toml"), "utf-8");
      // User's `model` is intentionally NOT copied into the isolated config —
      // grove pins the model via `-c model=...` in buildAcpLaunchArgs to avoid
      // user configs lagging codex-acp's bundled CLI (e.g. user sets gpt-5.5
      // but the CLI rejects it). See SAFE_CODEX_TOP_LEVEL_KEYS / DEFAULT_CODEX_MODEL.
      expect(config).not.toContain('model = "gpt-5.4-mini"');
      expect(config).not.toContain("bad-mcp");
      expect(config).toContain("[mcp_servers.grove]");
      expect(config).toContain('command = "/bin/bun"');
      expect(config).toContain('args = ["run", "/tmp/grove/dist/mcp/serve.js"]');
      expect(config).toContain('env_vars = ["NEXUS_API_KEY"]');
      expect(config).toContain("[mcp_servers.grove.env]");
      expect(config).toContain('GROVE_DIR = "/tmp/project/.grove"');
      expect(config).toContain('GROVE_NEXUS_URL = "http://localhost:59588"');
      expect(config).toContain('GROVE_SESSION_ID = "session-1"');
      expect(config).not.toContain("secret-key");
      expect(existsSync(join(isolated, "auth.json"))).toBe(true);
      writeFileSync(join(userHome, "auth.json"), '{"token":"rotated"}', "utf-8");
      expect(readFileSync(join(isolated, "auth.json"), "utf-8")).toBe('{"token":"rotated"}');
    } finally {
      if (isolated) rmSync(isolated, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  });
});

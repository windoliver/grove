import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "./agent-profile.js";
import {
  parseAgentProfiles,
  serializeAgentProfiles,
  validateProfilesAgainstTopology,
} from "./agent-profile.js";
import { makeTopology } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// parseAgentProfiles
// ---------------------------------------------------------------------------

describe("parseAgentProfiles", () => {
  test("parses valid JSON with minimal profiles", () => {
    const json = JSON.stringify({
      profiles: [
        {
          name: "@alice",
          role: "coder",
          platform: "claude-code",
        },
      ],
    });

    const result = parseAgentProfiles(json);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]?.name).toBe("@alice");
    expect(result.profiles[0]?.role).toBe("coder");
    expect(result.profiles[0]?.platform).toBe("claude-code");
  });

  test("parses valid JSON with all optional fields", () => {
    const json = JSON.stringify({
      profiles: [
        {
          name: "@bob",
          role: "reviewer",
          platform: "codex",
          command: "codex run",
          model: "gpt-4o",
          color: "#00cccc",
          mcp_servers: ["server1", "server2"],
          ask_user_enabled: true,
        },
      ],
    });

    const result = parseAgentProfiles(json);
    const p = result.profiles[0]!;
    expect(p.command).toBe("codex run");
    expect(p.model).toBe("gpt-4o");
    expect(p.color).toBe("#00cccc");
    expect(p.mcpServers).toEqual(["server1", "server2"]);
    expect(p.askUserEnabled).toBe(true);
  });

  test("throws on invalid JSON", () => {
    expect(() => parseAgentProfiles("not json")).toThrow();
  });

  test("throws on schema validation error — missing required field", () => {
    const json = JSON.stringify({
      profiles: [
        {
          name: "@alice",
          // missing role and platform
        },
      ],
    });

    expect(() => parseAgentProfiles(json)).toThrow(/Invalid agents\.json/);
  });

  test("throws on schema validation error — invalid name format", () => {
    const json = JSON.stringify({
      profiles: [
        {
          name: "alice", // missing @ prefix
          role: "coder",
          platform: "claude-code",
        },
      ],
    });

    expect(() => parseAgentProfiles(json)).toThrow(/Invalid agents\.json/);
  });

  test("throws on schema validation error — invalid platform", () => {
    const json = JSON.stringify({
      profiles: [
        {
          name: "@alice",
          role: "coder",
          platform: "unknown-platform",
        },
      ],
    });

    expect(() => parseAgentProfiles(json)).toThrow(/Invalid agents\.json/);
  });

  test("throws on schema validation error — invalid color format", () => {
    const json = JSON.stringify({
      profiles: [
        {
          name: "@alice",
          role: "coder",
          platform: "claude-code",
          color: "red",
        },
      ],
    });

    expect(() => parseAgentProfiles(json)).toThrow(/Invalid agents\.json/);
  });

  test("throws on unknown fields (strict mode)", () => {
    const json = JSON.stringify({
      profiles: [
        {
          name: "@alice",
          role: "coder",
          platform: "claude-code",
          unknownField: "should fail",
        },
      ],
    });

    expect(() => parseAgentProfiles(json)).toThrow(/Invalid agents\.json/);
  });
});

// ---------------------------------------------------------------------------
// validateProfilesAgainstTopology
// ---------------------------------------------------------------------------

describe("validateProfilesAgainstTopology", () => {
  test("accepts valid profiles matching topology roles", () => {
    const profiles: AgentProfile[] = [
      { name: "@alice", role: "coder", platform: "claude-code" },
      { name: "@bob", role: "reviewer", platform: "codex" },
    ];
    const topology = makeTopology();

    expect(() => validateProfilesAgainstTopology(profiles, topology)).not.toThrow();
  });

  test("rejects duplicate profile names", () => {
    const profiles: AgentProfile[] = [
      { name: "@alice", role: "coder", platform: "claude-code" },
      { name: "@alice", role: "reviewer", platform: "codex" },
    ];
    const topology = makeTopology();

    expect(() => validateProfilesAgainstTopology(profiles, topology)).toThrow(
      /duplicate profile name '@alice'/,
    );
  });

  test("rejects profiles referencing undefined roles", () => {
    const profiles: AgentProfile[] = [
      { name: "@alice", role: "unknown-role", platform: "claude-code" },
    ];
    const topology = makeTopology();

    expect(() => validateProfilesAgainstTopology(profiles, topology)).toThrow(
      /undefined role 'unknown-role'/,
    );
  });

  test("rejects when maxInstances is exceeded", () => {
    // makeTopology gives coder maxInstances=3, reviewer maxInstances=2
    const profiles: AgentProfile[] = [
      { name: "@r1", role: "reviewer", platform: "claude-code" },
      { name: "@r2", role: "reviewer", platform: "codex" },
      { name: "@r3", role: "reviewer", platform: "gemini" },
    ];
    const topology = makeTopology(); // reviewer maxInstances is 2

    expect(() => validateProfilesAgainstTopology(profiles, topology)).toThrow(
      /role 'reviewer' has 3 profiles but maxInstances is 2/,
    );
  });

  test("accepts profiles within maxInstances", () => {
    const profiles: AgentProfile[] = [
      { name: "@c1", role: "coder", platform: "claude-code" },
      { name: "@c2", role: "coder", platform: "codex" },
      { name: "@c3", role: "coder", platform: "gemini" },
    ];
    const topology = makeTopology(); // coder maxInstances is 3

    expect(() => validateProfilesAgainstTopology(profiles, topology)).not.toThrow();
  });

  test("skips role validation when topology is undefined", () => {
    const profiles: AgentProfile[] = [
      { name: "@alice", role: "any-role", platform: "claude-code" },
    ];

    // Should only check for duplicate names, not role references
    expect(() => validateProfilesAgainstTopology(profiles, undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// serializeAgentProfiles — round-trip
// ---------------------------------------------------------------------------

describe("serializeAgentProfiles", () => {
  test("round-trips minimal profiles through serialize/parse", () => {
    const profiles: AgentProfile[] = [{ name: "@alice", role: "coder", platform: "claude-code" }];

    const json = serializeAgentProfiles(profiles);
    const result = parseAgentProfiles(json);

    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]?.name).toBe("@alice");
    expect(result.profiles[0]?.role).toBe("coder");
    expect(result.profiles[0]?.platform).toBe("claude-code");
  });

  test("round-trips profiles with all optional fields", () => {
    const profiles: AgentProfile[] = [
      {
        name: "@bob",
        role: "reviewer",
        platform: "codex",
        command: "codex run",
        model: "gpt-4o",
        color: "#00cccc",
        mcpServers: ["server1"],
        askUserEnabled: false,
      },
    ];

    const json = serializeAgentProfiles(profiles);
    const result = parseAgentProfiles(json);

    const p = result.profiles[0]!;
    expect(p.name).toBe("@bob");
    expect(p.command).toBe("codex run");
    expect(p.model).toBe("gpt-4o");
    expect(p.color).toBe("#00cccc");
    expect(p.mcpServers).toEqual(["server1"]);
    expect(p.askUserEnabled).toBe(false);
  });

  test("omits undefined optional fields from JSON output", () => {
    const profiles: AgentProfile[] = [{ name: "@alice", role: "coder", platform: "claude-code" }];

    const json = serializeAgentProfiles(profiles);
    const parsed = JSON.parse(json) as { profiles: Record<string, unknown>[] };
    const wire = parsed.profiles[0]!;

    expect("command" in wire).toBe(false);
    expect("model" in wire).toBe(false);
    expect("color" in wire).toBe(false);
    expect("mcp_servers" in wire).toBe(false);
    expect("ask_user_enabled" in wire).toBe(false);
  });

  test("produces valid JSON", () => {
    const profiles: AgentProfile[] = [{ name: "@alice", role: "coder", platform: "claude-code" }];

    const json = serializeAgentProfiles(profiles);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

import { describe, expect, test } from "bun:test";

import type { AgentTopology } from "../../core/topology.js";
import {
  parseSessionSkillOverrideClauses,
  resolveSessionStartTopology,
} from "./session-start-topology.js";

const PRESET_TOPOLOGY: AgentTopology = {
  structure: "graph",
  roles: [{ name: "planner", skills: ["grove"] }, { name: "builder" }],
};

const CONTRACT_TOPOLOGY: AgentTopology = {
  structure: "flat",
  roles: [{ name: "solo" }],
};

describe("parseSessionSkillOverrideClauses", () => {
  test("parses repeated replace, add, and remove clauses", () => {
    expect(
      parseSessionSkillOverrideClauses(["*=grove", "planner+=review,lint", "builder-=grove"]),
    ).toEqual([
      { target: "*", op: "replace", skills: ["grove"] },
      { target: "planner", op: "add", skills: ["review", "lint"] },
      { target: "builder", op: "remove", skills: ["grove"] },
    ]);
  });

  test("supports empty replace clauses to clear skills", () => {
    expect(parseSessionSkillOverrideClauses(["planner="])).toEqual([
      { target: "planner", op: "replace", skills: [] },
    ]);
  });

  test("throws on malformed clauses", () => {
    expect(() => parseSessionSkillOverrideClauses(["planner"])).toThrow("Invalid --skills clause");
    expect(() => parseSessionSkillOverrideClauses(["planner+="])).toThrow(
      "Invalid --skills clause",
    );
    expect(() => parseSessionSkillOverrideClauses(["=grove"])).toThrow("Invalid --skills clause");
    expect(() => parseSessionSkillOverrideClauses(["planner= , "])).toThrow(
      "Invalid --skills clause",
    );
  });
});

describe("resolveSessionStartTopology", () => {
  test("applies skill overrides after preset resolution", () => {
    const result = resolveSessionStartTopology(
      {
        presetName: "review-loop",
        skillArgs: ["*=grove", "builder+=review"],
      },
      (name: string) => (name === "review-loop" ? PRESET_TOPOLOGY : undefined),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.source).toBe("preset");
    expect(result.topology.roles[0]?.skills).toEqual(["grove"]);
    expect(result.topology.roles[1]?.skills).toEqual(["grove", "review"]);
  });

  test("builds inline flat topology from --roles before applying overrides", () => {
    const result = resolveSessionStartTopology({
      rolesArg: "planner,builder",
      skillArgs: ["builder=review"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.source).toBe("inline");
    expect(result.topology.structure).toBe("flat");
    expect(result.topology.roles.map((role) => role.name)).toEqual(["planner", "builder"]);
    expect(result.topology.roles[0]?.skills).toBeUndefined();
    expect(result.topology.roles[1]?.skills).toEqual(["review"]);
  });

  test("returns failed topology resolution unchanged", () => {
    const result = resolveSessionStartTopology({
      presetName: "missing-preset",
      skillArgs: ["*=grove"],
    });

    expect(result).toEqual({
      ok: false,
      error: "Preset 'missing-preset' requested but no preset registry available",
    });
  });

  test("returns an unknown preset error when lookup misses", () => {
    const result = resolveSessionStartTopology(
      {
        presetName: "missing-preset",
        skillArgs: [],
      },
      () => undefined,
    );

    expect(result).toEqual({
      ok: false,
      error: "Unknown preset 'missing-preset'",
    });
  });

  test("falls back to the contract topology when no inline or preset is provided", () => {
    const result = resolveSessionStartTopology({
      contractDefault: CONTRACT_TOPOLOGY,
      skillArgs: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.source).toBe("contract");
    expect(result.topology).toBe(CONTRACT_TOPOLOGY);
  });

  test("returns a descriptive error when no topology source is available", () => {
    const result = resolveSessionStartTopology({
      skillArgs: [],
    });

    expect(result).toEqual({
      ok: false,
      error:
        "No topology available: provide --preset, an inline topology, or define one in GROVE.md",
    });
  });

  test("returns the original successful resolution when there are no overrides", () => {
    const result = resolveSessionStartTopology(
      {
        presetName: "review-loop",
        skillArgs: [],
      },
      (name: string) => (name === "review-loop" ? PRESET_TOPOLOGY : undefined),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.source).toBe("preset");
    expect(result.topology).toBe(PRESET_TOPOLOGY);
  });

  test("rejects empty --roles input after trimming", () => {
    expect(() =>
      resolveSessionStartTopology({
        rolesArg: " , ",
        skillArgs: [],
      }),
    ).toThrow("--roles must be a comma-separated list of role names");
  });
});

import { describe, expect, test } from "bun:test";
import type { AgentTopology } from "./topology.js";
import {
  applySessionSkillOverrides,
  normalizeSkillList,
  type SessionSkillOverrideClause,
} from "./session-skill-overrides.js";

const BASE_TOPOLOGY: AgentTopology = {
  structure: "graph",
  roles: [
    { name: "planner", skills: ["grove"] },
    { name: "builder", skills: ["review"] },
  ],
};

describe("normalizeSkillList", () => {
  test("trims values, drops empties, and preserves first occurrence order", () => {
    expect(normalizeSkillList([" grove ", "review", "", "grove", "lint "])).toEqual([
      "grove",
      "review",
      "lint",
    ]);
  });
});

describe("applySessionSkillOverrides", () => {
  test("supports replace, add, and remove without mutating the input topology", () => {
    const clauses: readonly SessionSkillOverrideClause[] = [
      { target: "planner", op: "replace", skills: ["grove", "review", "grove"] },
      { target: "builder", op: "add", skills: ["lint", "review"] },
      { target: "builder", op: "remove", skills: ["review"] },
    ];

    const next = applySessionSkillOverrides(BASE_TOPOLOGY, clauses);

    expect(next.roles[0]?.skills).toEqual(["grove", "review"]);
    expect(next.roles[1]?.skills).toEqual(["lint"]);
    expect(BASE_TOPOLOGY.roles[0]?.skills).toEqual(["grove"]);
    expect(BASE_TOPOLOGY.roles[1]?.skills).toEqual(["review"]);
  });

  test("applies blanket clauses before role-specific clauses", () => {
    const clauses: readonly SessionSkillOverrideClause[] = [
      { target: "*", op: "replace", skills: ["grove"] },
      { target: "builder", op: "add", skills: ["review"] },
    ];

    const next = applySessionSkillOverrides(BASE_TOPOLOGY, clauses);

    expect(next.roles[0]?.skills).toEqual(["grove"]);
    expect(next.roles[1]?.skills).toEqual(["grove", "review"]);
  });

  test("clears a touched role with replace plus empty and writes an explicit empty array", () => {
    const clauses: readonly SessionSkillOverrideClause[] = [
      { target: "planner", op: "replace", skills: [] },
    ];

    const next = applySessionSkillOverrides(BASE_TOPOLOGY, clauses);

    expect(next.roles[0]?.skills).toEqual([]);
    expect(next.roles[1]?.skills).toEqual(["review"]);
  });

  test("throws on unknown role names", () => {
    const clauses: readonly SessionSkillOverrideClause[] = [
      { target: "unknown", op: "add", skills: ["grove"] },
    ];

    expect(() => applySessionSkillOverrides(BASE_TOPOLOGY, clauses)).toThrow(
      "Unknown role in skill override",
    );
  });
});

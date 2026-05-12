import { describe, expect, test } from "bun:test";
import {
  applyRoleSkillsToAll,
  formatRoleSkillsInput,
  parseRoleSkillsInput,
  setRoleSkills,
} from "./role-skills.js";

describe("role skill helpers", () => {
  test("parseRoleSkillsInput normalizes comma-separated skill names", () => {
    expect(parseRoleSkillsInput(" grove, review , ,grove,lint ")).toEqual([
      "grove",
      "review",
      "lint",
    ]);
  });

  test("parseRoleSkillsInput returns an empty list for blank input", () => {
    expect(parseRoleSkillsInput("   ")).toEqual([]);
  });

  test("formatRoleSkillsInput joins skills for editing", () => {
    expect(formatRoleSkillsInput(["grove", "review"])).toBe("grove, review");
  });

  test("setRoleSkills replaces one role without mutating the original map", () => {
    const original = new Map<string, readonly string[]>([
      ["planner", ["grove"]],
      ["builder", ["review"]],
    ]);

    const updated = setRoleSkills(original, "builder", ["lint"]);

    expect([...original.entries()]).toEqual([
      ["planner", ["grove"]],
      ["builder", ["review"]],
    ]);
    expect([...updated.entries()]).toEqual([
      ["planner", ["grove"]],
      ["builder", ["lint"]],
    ]);
    expect(updated).not.toBe(original);
    expect(updated.get("builder")).not.toBe(original.get("builder"));
  });

  test("applyRoleSkillsToAll copies the selected role skills to every role", () => {
    const current = new Map<string, readonly string[]>([
      ["planner", ["grove", "review"]],
      ["builder", []],
      ["qa", ["lint"]],
    ]);

    const updated = applyRoleSkillsToAll(["planner", "builder", "qa"], current, "planner");

    expect([...updated.entries()]).toEqual([
      ["planner", ["grove", "review"]],
      ["builder", ["grove", "review"]],
      ["qa", ["grove", "review"]],
    ]);
    expect(updated.get("planner")).not.toBe(current.get("planner"));
  });
});

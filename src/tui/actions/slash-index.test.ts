import { describe, expect, test } from "bun:test";
import { skillSource } from "./dynamic-sources.js";
import { buildSlashIndex, resolveSlash } from "./slash-index.js";
import type { Action, ActionContext } from "./types.js";

const a = (id: string, slash?: string): Action =>
  ({ id, label: id, detail: "", group: "View", slash, run: () => {} }) as Action;

describe("buildSlashIndex", () => {
  test("maps slash trigger → action id, ignoring actions without slash", () => {
    const idx = buildSlashIndex([a("view.quit", "/quit"), a("view.refresh")]);
    expect(idx.get("/quit")).toBe("view.quit");
    expect(idx.size).toBe(1);
  });
});

describe("resolveSlash", () => {
  test("parses /cmd args", () => {
    const idx = buildSlashIndex([a("agent.spawn", "/spawn")]);
    expect(resolveSlash(idx, "/spawn reviewer fast")).toEqual({
      id: "agent.spawn",
      args: ["reviewer", "fast"],
    });
  });
  test("returns undefined for unknown command", () => {
    expect(resolveSlash(buildSlashIndex([]), "/nope")).toBeUndefined();
  });

  test("resolves the colon-joined skill slash from skillSource", () => {
    const ctx = {
      selectedSession: "s1",
      availableSkills: [{ name: "grove" }],
    } as unknown as ActionContext;
    const idx = buildSlashIndex(skillSource(ctx));
    expect(resolveSlash(idx, "/skill:grove")).toEqual({
      id: "skill.request.grove",
      args: [],
    });
  });
});

import { describe, expect, test } from "bun:test";
import { buildSlashIndex, resolveSlash } from "./slash-index.js";
import type { Action } from "./types.js";

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
});

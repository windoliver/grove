import { describe, expect, test } from "bun:test";
import { buildPromptWithUpstream, type UpstreamSection } from "./upstream-prompt.js";

describe("buildPromptWithUpstream", () => {
  test("returns base prompt unchanged when no upstream sections", () => {
    expect(buildPromptWithUpstream("do work", [])).toBe("do work");
  });

  test("wraps base prompt with single upstream section", () => {
    const sections: UpstreamSection[] = [{ taskId: "coder-1", summary: "Implemented X." }];
    const out = buildPromptWithUpstream("Review my changes.", sections);
    expect(out).toContain("## Upstream output");
    expect(out).toContain("### coder-1 (succeeded)");
    expect(out).toContain("Implemented X.");
    expect(out).toContain("## Your task");
    expect(out).toContain("Review my changes.");
  });

  test("concatenates multiple sections in order", () => {
    const sections: UpstreamSection[] = [
      { taskId: "a", summary: "first" },
      { taskId: "b", summary: "second" },
    ];
    const out = buildPromptWithUpstream("base", sections);
    const aIdx = out.indexOf("### a (succeeded)");
    const bIdx = out.indexOf("### b (succeeded)");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  test("substitutes '(no summary)' when summary is empty", () => {
    const sections: UpstreamSection[] = [{ taskId: "a", summary: "" }];
    const out = buildPromptWithUpstream("base", sections);
    expect(out).toContain("(no summary)");
  });
});
